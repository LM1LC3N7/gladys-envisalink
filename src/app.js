// -----------------------------------------------------------------------------
// The integration: one Envisalink TPI session (src/tpi/client.js), the panel
// state it describes (src/model.js), the Gladys devices and states
// (src/devices.js), the scene events, the commands. index.js only wires the
// SDK handlers to it.
//
// Safety: arming is allowed unless the configuration forbids it; disarming
// and panic alarms are off unless the configuration allows them. Every
// command, sent or refused, is logged; the user code and the password never
// are.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { codeFits, normalizeConfig, sessionKey } from './config.js';
import { ARM_MODES, MODES, PANIC_KINDS, SCENE_TRIGGERS, TIMINGS } from './constants.js';
import { buildDevices, buildStates, ids, parseFeatureId, zoneList } from './devices.js';
import { COMMAND_NAMES, T, fill, word } from './i18n.js';
import { applyEvent, emptyState, expireKeypadFaults } from './model.js';
import { StatePublisher } from './publisher.js';
import { EnvisalinkClient, TpiError } from './tpi/client.js';

/** A command the configuration refuses: nothing was sent. */
export class Refused extends Error {}

const ERROR_TEXTS = {
  invalid_code: 'the panel refused the user code',
  arm_failed: 'the panel failed to arm (zone open or trouble?)',
  busy: 'the partition is busy',
  code_required: 'the panel asked for a user code nobody was waiting for',
  checksum: 'the Envisalink refused a frame (checksum)',
};

export class EnvisalinkApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'envisalink' }),
    client,
    connect,
    now = Date.now,
    timers = globalThis,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.client = client ?? new EnvisalinkClient({ connect, timers, now, logger });
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
    this.config = normalizeConfig();
    this.key = undefined;
    this.state = emptyState();
    this.panelType = undefined;
    this.online = false;
    /** partition -> { mode, until }: what the last Gladys command asked. */
    this.commanded = new Map();
    this.lastStatus = undefined;
    this.lastTransport = undefined;
    this.published = undefined;
    this.started = false;
    this.sweeper = undefined;
    this.client.on('up', (info) => this.guard(() => this.onUp(info)));
    this.client.on('down', (info) => this.guard(() => this.onDown(info)));
    this.client.on('event', (event) => this.guard(() => this.onEvent(event)));
  }

  /** Client events run one after the other, in order. */
  guard(fn) {
    this.chain = (this.chain ?? Promise.resolve())
      .then(fn)
      .catch((err) => this.logger.error(`Envisalink event failed: ${err.message}`));
    return this.chain;
  }

  get language() {
    return this.config.language;
  }

  error(entry, cause) {
    return new Error(word(entry, this.language), cause ? { cause } : undefined);
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(raw = {}) {
    this.stop();
    const next = normalizeConfig(raw);
    if (sessionKey(next) !== this.key) {
      // Another module or another panel: what we knew no longer holds.
      this.state = emptyState();
      this.panelType = undefined;
    }
    this.config = next;
    this.key = sessionKey(next);
    this.online = false;
    if (next.zoneErrors.length > 0) {
      this.logger.warn(`Zones not understood in the configuration: ${next.zoneErrors.join(', ')}`);
    }
    if (next.codeInvalid) {
      this.logger.warn('The user code of the configuration is not 4 or 6 digits: ignored');
    }
    await this.publishDevices();
    await this.publishStates();
    const problem = this.configProblem();
    if (problem) {
      await this.setStatus(false, problem);
      return;
    }
    await this.setStatus(false, T.connecting);
    this.client.configure({
      host: next.host,
      port: next.port,
      password: next.password,
      panelType: next.panelType,
    });
    this.client.start();
    this.sweeper = this.timers.setInterval(() => this.guard(() => this.sweep()), TIMINGS.sweep);
  }

  stop() {
    this.client.stop();
    this.publisher.stop();
    if (this.sweeper) {
      this.timers.clearInterval(this.sweeper);
      this.sweeper = undefined;
    }
    if (this.discoveryTimer) {
      this.timers.clearTimeout(this.discoveryTimer);
      this.discoveryTimer = undefined;
    }
  }

  configProblem() {
    if (!this.config.host) return T.noHost;
    if (!this.config.password) return T.noPassword;
    return undefined;
  }

  /** First connection to Gladys: start; a reconnection (Gladys restarted): resend everything. */
  async connected(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    this.published = undefined;
    this.lastTransport = undefined;
    const status = this.lastStatus;
    this.lastStatus = undefined;
    await this.configUpdated(raw);
    if (status && this.lastStatus === undefined) {
      const [connected, message] = JSON.parse(status);
      await this.setStatus(connected, message ?? undefined);
    }
    this.publisher.forget();
    await this.publishDevices();
    await this.publishStates();
  }

  /** A new address, port, password or panel type reconnects; the rest applies at once. */
  async configUpdated(raw = {}) {
    const next = normalizeConfig(raw);
    if (sessionKey(next) !== this.key) {
      return this.start(raw);
    }
    this.config = next;
    await this.publishDevices();
    await this.publishStates();
    if (this.online) await this.setStatus(true, this.connectedMessage());
    return undefined;
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  partitionsSummary() {
    return Array.from({ length: this.config.partitions }, (_, i) => ({
      partition: i + 1,
      mode: this.state.partitions[i + 1]?.mode,
    }));
  }

  connectedMessage() {
    return fill(T.connected, this.panelType, this.partitionsSummary());
  }

  // --- Client events ---------------------------------------------------------

  async onUp({ panelType }) {
    this.online = true;
    if (panelType !== this.panelType) {
      this.panelType = panelType;
    }
    await this.publishDevices();
    await this.publishStates();
    await this.setStatus(true, this.connectedMessage());
    await this.publishTransports(DEVICE_TRANSPORTS.LOCAL);
  }

  async onDown({ reason, retryIn, refused, stopped, contended }) {
    this.online = false;
    const seconds = Math.round((retryIn ?? 0) / 1000);
    if (stopped) {
      this.logger.error('Envisalink: password refused too many times, connection stopped');
      await this.setStatus(false, T.stopped);
    } else if (refused) {
      await this.setStatus(false, fill(T.refused, seconds));
    } else if (contended) {
      this.logger.warn(
        `Envisalink: sessions dropped right after their login several times (another TPI client?); next try in ${seconds} s`,
      );
      await this.setStatus(false, fill(T.contended, seconds));
    } else {
      this.logger.warn(`Envisalink: ${reason}; next try in ${seconds} s`);
      await this.setStatus(false, fill(T.unreachable, reason, seconds));
    }
    await this.publishStates();
    await this.publishTransports(DEVICE_TRANSPORTS.UNREACHABLE);
  }

  async onEvent(event) {
    if (event.type === 'error') {
      const text = ERROR_TEXTS[event.code] ?? `error ${event.code}`;
      this.logger.warn(
        `Envisalink: ${text}${event.partition ? ` (partition ${event.partition})` : ''}`,
      );
      if (Number.isInteger(event.partition) && event.partition <= this.config.partitions) {
        // A failed arm or a refused code: the dashboard shows what was asked, send the real mode.
        this.publisher.forget(ids.partition(this.gladys, event.partition).feature('mode'));
        await this.publishStates();
      }
      return;
    }
    const zonesBefore = zoneList(this.config, this.state).length;
    const summary = JSON.stringify(this.partitionsSummary());
    const { state, effects } = applyEvent(this.state, event, {
      at: this.now(),
      zoneType: (number) => this.zoneType(number),
    });
    this.state = state;
    if (zoneList(this.config, this.state).length !== zonesBefore) {
      this.devicesSoon();
    }
    await this.publishStates();
    for (const effect of effects) {
      await this.effect(effect);
    }
    if (this.online && JSON.stringify(this.partitionsSummary()) !== summary) {
      await this.setStatus(true, this.connectedMessage());
    }
  }

  byGladys(partition, mode) {
    const asked = this.commanded.get(partition);
    return Boolean(asked && asked.mode === mode && this.now() < asked.until);
  }

  async effect(effect) {
    const known = effect.partition === null || effect.partition <= this.config.partitions;
    if (!known) return;
    const partition = effect.partition === null ? null : String(effect.partition);
    if (effect.type === 'armed') {
      const byGladys = this.byGladys(effect.partition, effect.mode);
      this.logger.info(
        `Panel: partition ${partition} ARMED ${effect.mode} (${byGladys ? 'Gladys command' : effect.user ? `user ${effect.user}` : 'keypad or other'})`,
      );
      await this.publisher.sceneEvent(SCENE_TRIGGERS.ARMED, {
        partition,
        mode: effect.mode,
        user: effect.user,
        by_gladys: byGladys,
      });
    } else if (effect.type === 'disarmed') {
      const byGladys = this.byGladys(effect.partition, 'disarmed');
      this.logger.info(
        `Panel: partition ${partition} DISARMED (${byGladys ? 'Gladys command' : effect.user ? `user ${effect.user}` : 'keypad or other'})`,
      );
      await this.publisher.sceneEvent(SCENE_TRIGGERS.DISARMED, {
        partition,
        user: effect.user,
        by_gladys: byGladys,
      });
    } else if (effect.type === 'alarm') {
      this.logger.warn(
        `Panel: ALARM ${effect.kind}${partition ? ` partition ${partition}` : ''}${effect.zone ? ` zone ${effect.zone}` : ''}`,
      );
      await this.publisher.sceneEvent(SCENE_TRIGGERS.ALARM_TRIGGERED, {
        partition,
        kind: effect.kind,
        zone: effect.zone,
      });
    }
  }

  /**
   * The kind of a zone the user configured; undefined for a zone added by the
   * panel (shown as an opening, but its real kind is unknown).
   */
  zoneType(number) {
    return this.config.zones.find((zone) => zone.zone === number)?.type;
  }

  /** Expires the Honeywell keypad values; also sends the heartbeats that are due. */
  async sweep() {
    if (this.panelType === 'honeywell') {
      const { state, changed } = expireKeypadFaults(this.state, { at: this.now() });
      if (changed) this.state = state;
    }
    await this.publishStates();
  }

  /** New zones come in bursts (a DSC status dump): one device list for the burst. */
  devicesSoon() {
    if (this.discoveryTimer) return;
    this.discoveryTimer = this.timers.setTimeout(() => {
      this.discoveryTimer = undefined;
      this.guard(() => this.publishDevices());
    }, TIMINGS.discoveryDebounce);
  }

  // --- Gladys ----------------------------------------------------------------

  async publishDevices({ force = false } = {}) {
    const devices = buildDevices(this.gladys, this.config, this.state, this.panelType);
    const json = JSON.stringify(devices);
    if (json === this.published && !force) return;
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the devices failed: ${err.message}`);
    }
  }

  publishStates() {
    return this.publisher.publish(
      buildStates(this.gladys, this.config, this.state, { online: this.online }),
    );
  }

  async publishTransports(transport) {
    if (transport === this.lastTransport) return;
    const devices = buildDevices(this.gladys, this.config, this.state, this.panelType);
    const entries = devices.map((device) => ({ external_id: device.external_id, transport }));
    try {
      // At most 100 entries per request.
      for (let i = 0; i < entries.length; i += 100) {
        await this.gladys.publishTransports(entries.slice(i, i + 100));
      }
      this.lastTransport = transport;
    } catch (err) {
      this.logger.warn(`Publishing the transports failed: ${err.message}`);
    }
  }

  async scan() {
    await this.publishDevices({ force: true });
  }

  /** The user created or updated a device: Gladys has none of its states yet, send them again. */
  async deviceChanged(device) {
    this.publisher.forget(device?.external_id);
    await this.publishStates();
  }

  /** The user code, if it suits the panel; else the reason as an error. */
  codeFor() {
    if (!this.config.code) {
      throw this.error(this.config.codeInvalid ? T.badCode : T.noCode);
    }
    if (!codeFits(this.config.code, this.panelType)) {
      throw this.error(T.badCodeHoneywell);
    }
    return this.config.code;
  }

  // --- Commands --------------------------------------------------------------

  partitionOf(value) {
    const partition = Number(value ?? 1);
    if (!Number.isInteger(partition) || partition < 1 || partition > this.config.partitions) {
      throw this.error(fill(T.unknownPartition, String(value)));
    }
    return partition;
  }

  /** Runs a TPI command; a client error becomes a message in the user's language. */
  send(fn) {
    try {
      fn();
    } catch (err) {
      if (err instanceof TpiError) {
        throw this.error(err.kind === 'no_code' ? T.noCode : T.offline, err);
      }
      throw err;
    }
  }

  async setValue(_device, feature, value) {
    const target = parseFeatureId(feature?.external_id);
    if (!target || target.kind !== 'partition' || target.key !== 'mode') {
      throw new Error(`${feature?.external_id} is read-only`);
    }
    const mode = String(value ?? '');
    if (!MODES.includes(mode)) {
      throw new Error(`Unknown alarm mode ${value}`);
    }
    try {
      return mode === 'disarmed'
        ? await this.disarm(target.number)
        : await this.arm(target.number, mode);
    } catch (err) {
      // The dashboard shows what was asked: send the real mode again.
      this.publisher.forget(ids.partition(this.gladys, target.number).feature('mode'));
      await this.publishStates();
      throw err;
    }
  }

  async arm(rawPartition, mode) {
    const partition = this.partitionOf(rawPartition);
    if (!ARM_MODES.includes(mode)) throw new Error(`Unknown arming mode ${mode}`);
    const what = word(fill(COMMAND_NAMES.arm, mode, partition), 'en');
    if (!this.config.allowArm) {
      this.logger.warn(
        `Arm REFUSED (${what}): arming from Gladys is disabled in the configuration`,
      );
      throw new Refused(word(T.armRefused, this.language));
    }
    const current = this.state.partitions[partition]?.mode;
    if (current === mode) {
      this.logger.info(`Partition ${partition} already ${mode}: nothing sent`);
      return fill(T.nothingSent, word(fill(COMMAND_NAMES.arm, mode, partition), this.language));
    }
    if (current && current !== 'disarmed') {
      throw this.error(T.alreadyArmed);
    }
    // DSC arms without a code (or answers its 900 with it); Honeywell always needs one.
    const code = this.panelType === 'dsc' && !this.config.code ? '' : this.codeFor();
    this.logger.info(`ARMING from Gladys: ${what}`);
    this.send(() => this.client.arm(partition, mode, code));
    this.commanded.set(partition, { mode, until: this.now() + TIMINGS.commandMemory });
    return fill(T.sent, word(fill(COMMAND_NAMES.arm, mode, partition), this.language));
  }

  async disarm(rawPartition) {
    const partition = this.partitionOf(rawPartition);
    const what = word(fill(COMMAND_NAMES.disarm, partition), 'en');
    if (!this.config.allowDisarm) {
      this.logger.warn(
        `Disarm REFUSED (${what}): disarming from Gladys is disabled in the configuration`,
      );
      throw new Refused(word(T.disarmRefused, this.language));
    }
    const code = this.codeFor();
    this.logger.info(`DISARMING from Gladys: ${what}`);
    this.send(() => this.client.disarm(partition, code));
    this.commanded.set(partition, { mode: 'disarmed', until: this.now() + TIMINGS.commandMemory });
    return fill(T.sent, word(fill(COMMAND_NAMES.disarm, partition), this.language));
  }

  async panic(kind) {
    if (!PANIC_KINDS.includes(kind)) throw new Error(`Unknown panic kind ${kind}`);
    const what = word(fill(COMMAND_NAMES.panic, kind), 'en');
    if (!this.config.allowPanic) {
      this.logger.warn(`Panic REFUSED (${what}): panic alarms from Gladys are disabled`);
      throw new Refused(word(T.panicRefused, this.language));
    }
    this.logger.warn(`PANIC from Gladys: ${what}`);
    this.send(() => this.client.panic(kind, 1));
    return fill(T.sent, word(fill(COMMAND_NAMES.panic, kind), this.language));
  }

  // --- Configuration button ----------------------------------------------------

  /** Waits for the client to come up or go down, at most `timeout` ms. */
  waitForLink(timeout = 15_000) {
    if (this.client.connected) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (up) => {
        this.client.off('up', onUp);
        this.client.off('down', onDown);
        this.timers.clearTimeout(timer);
        resolve(up);
      };
      const onUp = () => done(true);
      const onDown = () => done(false);
      const timer = this.timers.setTimeout(() => done(false), timeout);
      this.client.on('up', onUp);
      this.client.on('down', onDown);
    });
  }

  /** "Test the connection": reconnects if stopped, asks the panel for its status. */
  async testConnection() {
    const problem = this.configProblem();
    if (problem) throw this.error(problem);
    if (!this.client.connected) {
      // Now rather than at the next retry (also lifts a stop after refused passwords).
      this.client.start();
    }
    const up = await this.waitForLink();
    await this.chain;
    if (!up) {
      const [, message] = this.lastStatus ? JSON.parse(this.lastStatus) : [];
      throw this.error(message ?? T.offline);
    }
    this.send(() => this.client.requestStatus());
    return fill(
      T.testOk,
      this.panelType,
      this.partitionsSummary(),
      zoneList(this.config, this.state).length,
    );
  }
}
