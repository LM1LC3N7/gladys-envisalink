// -----------------------------------------------------------------------------
// One TCP session with the Envisalink TPI (port 4025): connection, login,
// lines, keep-alive, watchdog, automatic reconnection, commands.
//
// The module accepts ONE TPI client at a time: a second one (Home Assistant,
// another Gladys) is refused or kicks the first out. The panel family is
// recognised from the first line (`Login:` Honeywell, `505` DSC) unless the
// configuration forces it.
//
// Events: 'up' { panelType }, 'down' { reason, retryIn, stopped }, 'event'
// (the decoded events of src/tpi/dsc.js / honeywell.js).
//
// The password and the user code are never logged: the frames carrying them
// are logged by their command only.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { createConnection } from 'node:net';
import { LIMITS, TIMINGS } from '../constants.js';
import * as dsc from './dsc.js';
import * as honeywell from './honeywell.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

export class TpiError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind;
  }
}

export class EnvisalinkClient extends EventEmitter {
  constructor({
    connect = (options) => createConnection(options),
    timers = globalThis,
    now = Date.now,
    logger = silent,
  } = {}) {
    super();
    this.connectFn = connect;
    this.timers = timers;
    this.now = now;
    this.logger = logger;
    this.options = { host: '', port: 4025, password: '', panelType: 'auto' };
    this.socket = undefined;
    this.generation = 0;
    this.running = false;
    this.loggedIn = false;
    this.panelType = undefined;
    this.failures = 0;
    this.refusals = 0;
    this.stopped = false;
    this.buffer = '';
    this.lastReceived = 0;
    this.pendingCode = undefined;
    this.timer = undefined;
    this.ticker = undefined;
    this.reconnectTimer = undefined;
  }

  configure({ host, port, password, panelType }) {
    this.options = { host, port, password, panelType };
  }

  get connected() {
    return this.loggedIn;
  }

  start() {
    this.stop();
    this.running = true;
    this.stopped = false;
    this.refusals = 0;
    this.failures = 0;
    this.open();
  }

  stop() {
    this.running = false;
    this.generation += 1;
    this.clearTimers();
    if (this.reconnectTimer) {
      this.timers.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.close();
  }

  clearTimers() {
    if (this.timer) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.ticker) {
      this.timers.clearInterval(this.ticker);
      this.ticker = undefined;
    }
  }

  close() {
    const socket = this.socket;
    this.socket = undefined;
    this.loggedIn = false;
    this.buffer = '';
    if (socket) {
      socket.removeAllListeners();
      socket.on('error', () => undefined);
      socket.destroy();
    }
  }

  // --- Connection -------------------------------------------------------------

  open() {
    const generation = this.generation;
    const { host, port } = this.options;
    this.panelType = this.options.panelType === 'auto' ? undefined : this.options.panelType;
    this.logger.debug(`Connecting to the Envisalink at ${host}:${port}`);
    let socket;
    try {
      socket = this.connectFn({ host, port });
    } catch (err) {
      this.lost(generation, `connection failed: ${err.message}`);
      return;
    }
    this.socket = socket;
    socket.setNoDelay?.(true);
    this.timer = this.timers.setTimeout(
      () => this.lost(generation, 'connection timed out'),
      TIMINGS.connectTimeout,
    );
    socket.on('connect', () => {
      if (generation !== this.generation) return;
      this.timers.clearTimeout(this.timer);
      this.lastReceived = this.now();
      this.timer = this.timers.setTimeout(
        () => this.lost(generation, 'no login prompt from the Envisalink'),
        TIMINGS.loginTimeout,
      );
    });
    socket.on('data', (chunk) => {
      if (generation === this.generation) this.received(chunk);
    });
    socket.on('error', (err) => this.lost(generation, err.code ?? err.message));
    socket.on('close', () => this.lost(generation, 'connection closed by the Envisalink'));
  }

  /** The session ended (error, close, timeout): reconnect later unless stopped. */
  lost(generation, reason, { refused = false } = {}) {
    if (generation !== this.generation) return;
    this.generation += 1;
    const wasUp = this.loggedIn;
    this.clearTimers();
    this.close();
    if (!this.running) return;
    let retryIn;
    if (refused) {
      this.refusals += 1;
      this.stopped = this.refusals >= LIMITS.maxLoginRefusals;
      retryIn = this.stopped ? undefined : TIMINGS.loginRefusedRetry;
    } else {
      this.failures = wasUp ? 1 : this.failures + 1;
      retryIn = TIMINGS.backoff[Math.min(this.failures - 1, TIMINGS.backoff.length - 1)];
    }
    if (retryIn !== undefined) {
      this.reconnectTimer = this.timers.setTimeout(() => {
        this.reconnectTimer = undefined;
        if (this.running) this.open();
      }, retryIn);
    }
    this.emit('down', { reason, retryIn, refused, stopped: this.stopped, wasUp });
  }

  received(chunk) {
    this.lastReceived = this.now();
    this.buffer += Buffer.isBuffer(chunk) ? chunk.toString('latin1') : String(chunk);
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop();
    // The Honeywell prompt may come without its line end.
    if (this.buffer === 'Login:') {
      lines.push(this.buffer);
      this.buffer = '';
    }
    if (this.buffer.length > LIMITS.maxLine) {
      this.logger.warn('Envisalink: line too long, dropped');
      this.buffer = '';
    }
    for (const line of lines) {
      const text = line.trim();
      if (text !== '' && this.socket) this.line(text);
    }
  }

  line(text) {
    if (!this.panelType) {
      if (text === 'Login:') this.panelType = 'honeywell';
      else if (dsc.parseFrame(text)?.command === '505') this.panelType = 'dsc';
      else return;
      this.logger.info(`Envisalink: ${this.panelType === 'dsc' ? 'DSC' : 'Honeywell'} panel`);
    }
    let events;
    if (this.panelType === 'dsc') {
      const parsed = dsc.parseFrame(text);
      if (!parsed) {
        this.logger.debug(`Envisalink: line ignored (not a valid DSC frame): ${text.slice(0, 40)}`);
        return;
      }
      events = dsc.decode(parsed);
    } else {
      events = honeywell.decode(text);
    }
    for (const event of events) {
      this.handle(event);
    }
  }

  handle(event) {
    if (event.type === 'login') {
      this.login(event.result);
      return;
    }
    if (!this.loggedIn) {
      return;
    }
    if (event.type === 'ack') {
      return;
    }
    if (event.type === 'code_required') {
      this.codeRequired(event.partition);
      return;
    }
    this.emit('event', event);
  }

  login(result) {
    const generation = this.generation;
    if (result === 'prompt') {
      this.write(this.encoder.login(this.options.password), 'login');
      return;
    }
    if (result === 'ok') {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
      this.loggedIn = true;
      this.failures = 0;
      this.refusals = 0;
      this.ticker = this.timers.setInterval(() => this.tick(generation), TIMINGS.keepAlive);
      this.logger.info('Envisalink: logged in');
      this.emit('up', { panelType: this.panelType });
      if (this.panelType === 'dsc') this.write(dsc.encode.status(), 'status report');
      return;
    }
    if (result === 'refused') {
      this.logger.error('Envisalink: password refused');
      this.lost(generation, 'password refused', { refused: true });
      return;
    }
    this.lost(generation, 'login timed out');
  }

  tick(generation) {
    if (generation !== this.generation || !this.loggedIn) return;
    if (this.now() - this.lastReceived > TIMINGS.watchdog) {
      this.logger.warn('Envisalink: nothing received for too long, reconnecting');
      this.lost(generation, 'no answer from the Envisalink');
      return;
    }
    this.write(this.encoder.poll(), 'keep-alive');
  }

  get encoder() {
    return this.panelType === 'dsc' ? dsc.encode : honeywell.encode;
  }

  write(text, what) {
    if (!this.socket) {
      throw new TpiError('Not connected to the Envisalink', 'offline');
    }
    // `what` names the frame: the frame itself may hold the password or a code.
    this.logger.debug(`Envisalink <- ${what}`);
    this.socket.write(text, 'latin1');
  }

  // --- Commands ----------------------------------------------------------------

  ensureUp() {
    if (!this.loggedIn) {
      throw new TpiError('Not connected to the Envisalink', 'offline');
    }
  }

  arm(partition, mode, code) {
    this.ensureUp();
    if (this.panelType === 'dsc') {
      // Answered with the code if the panel asks for it (900), and only then.
      this.pendingCode = code ? { code, until: this.now() + TIMINGS.codeWindow } : undefined;
      this.write(dsc.encode.arm(partition, mode), `arm ${mode} partition ${partition}`);
      return;
    }
    if (!code) {
      throw new TpiError('A user code is needed to arm a Honeywell panel', 'no_code');
    }
    this.write(honeywell.encode.arm(partition, mode, code), `arm ${mode} partition ${partition}`);
  }

  disarm(partition, code) {
    this.ensureUp();
    if (!code) {
      throw new TpiError('A user code is needed to disarm', 'no_code');
    }
    const frame =
      this.panelType === 'dsc'
        ? dsc.encode.disarm(partition, code)
        : honeywell.encode.disarm(partition, code);
    this.write(frame, `disarm partition ${partition}`);
  }

  panic(kind, partition = 1) {
    this.ensureUp();
    const frame =
      this.panelType === 'dsc' ? dsc.encode.panic(kind) : honeywell.encode.panic(kind, partition);
    this.write(frame, `panic ${kind}`);
  }

  /** DSC only: every zone and partition state again (Honeywell sends them by itself). */
  requestStatus() {
    this.ensureUp();
    if (this.panelType === 'dsc') this.write(dsc.encode.status(), 'status report');
  }

  codeRequired(partition) {
    const pending = this.pendingCode;
    this.pendingCode = undefined;
    if (!pending || this.now() > pending.until) {
      this.logger.warn(
        `Envisalink: the panel asks for a user code (partition ${partition}) but no Gladys command is waiting for one: not sent`,
      );
      this.emit('event', { type: 'error', code: 'code_required', partition });
      return;
    }
    this.write(dsc.encode.code(pending.code), 'user code');
  }
}
