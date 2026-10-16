// -----------------------------------------------------------------------------
// The panel state -> Gladys devices and states (pure).
//
// Ids that do not depend on the Envisalink address (a new DHCP lease keeps
// the devices) and that the panel itself numbers:
// - `ext:<selector>:panel:envisalink`: link, mains, battery, tamper, trouble,
//   panic;
// - `ext:<selector>:partition:<n>`: mode select (disarmed, away, stay,
//   night), alarm in progress, ready to arm;
// - `ext:<selector>:zone:<n>`: one state feature keyed by the zone kind
//   (`:opening`, `:motion`, `:smoke` or `:leak`: a kind changed in the
//   configuration is a new feature, never an old one with another
//   category), alarm, tamper, fault.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
} from '@gladysassistant/integration-sdk';
import { MODES, OPENING_SENSOR_STATE } from './constants.js';
import { DEVICE_NAMES, FEATURE_NAMES, MODE_NAMES, word } from './i18n.js';
import { panicActive } from './model.js';

const binary = (category, type, extra = {}) => ({
  category,
  type,
  min: 0,
  max: 1,
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...extra,
});

/** Feature definitions by key (the last part of their external id). Keys are forever. */
export const PANEL_FEATURES = {
  online: binary(C.INPUT, T.INPUT.BINARY),
  'ac-power': binary(C.INPUT, T.INPUT.BINARY),
  'battery-low': binary(C.BATTERY_LOW, T.BATTERY_LOW.BINARY),
  tamper: binary(C.TAMPER, T.TAMPER.BINARY),
  trouble: binary(C.INPUT, T.INPUT.BINARY),
  panic: binary(C.SIREN, T.SIREN.BINARY),
};

export const PARTITION_FEATURES = {
  mode: {
    category: C.TEXT,
    type: T.TEXT.SELECT,
    min: 0,
    max: 0,
    read_only: false,
    has_feedback: true,
    // A text history is not charted by Gladys; the armed / disarmed events are the history.
    keep_history: false,
  },
  alarm: binary(C.SIREN, T.SIREN.BINARY),
  ready: binary(C.INPUT, T.INPUT.BINARY),
};

/** The state feature of a zone, by zone type (the type is also its feature key). */
export const ZONE_STATE = {
  opening: binary(C.OPENING_SENSOR, T.SENSOR.BINARY),
  motion: binary(C.MOTION_SENSOR, T.SENSOR.BINARY),
  smoke: binary(C.SMOKE_SENSOR, T.SENSOR.BINARY),
  leak: binary(C.LEAK_SENSOR, T.SENSOR.BINARY),
};

export const ZONE_FEATURES = {
  alarm: binary(C.SIREN, T.SIREN.BINARY),
  tamper: binary(C.TAMPER, T.TAMPER.BINARY),
  fault: binary(C.INPUT, T.INPUT.BINARY),
};

export const ids = {
  panel: (gladys) => gladys.externalIds('panel', 'envisalink'),
  partition: (gladys, n) => gladys.externalIds('partition', String(n)),
  zone: (gladys, n) => gladys.externalIds('zone', String(n)),
};

/** `ext:sel:partition:2:mode` -> { kind: 'partition', number: 2, key: 'mode' }. */
export function parseFeatureId(externalId) {
  const match = /:(panel|partition|zone):([a-z0-9]+):([a-z-]+)$/.exec(String(externalId ?? ''));
  if (!match) return undefined;
  return {
    kind: match[1],
    number: match[1] === 'panel' ? undefined : Number(match[2]),
    key: match[3],
  };
}

const feature = (deviceIds, key, name, definition, extra = {}) => ({
  name,
  external_id: deviceIds.feature(key),
  ...definition,
  ...extra,
});

/** The zones to show: the configured ones, then the ones the panel reported. */
export function zoneList(config, state) {
  const zones = new Map(config.zones.map((zone) => [zone.zone, zone]));
  for (const number of Object.keys(state.zones).map(Number)) {
    if (!zones.has(number)) zones.set(number, { zone: number, name: '', type: 'opening' });
  }
  return [...zones.values()].sort((a, b) => a.zone - b.zone);
}

export function buildDevices(gladys, config, state, panelType) {
  const { language } = config;
  const params = panelType ? [{ name: 'panel', value: panelType }] : [];
  const panelIds = ids.panel(gladys);
  const devices = [
    {
      name: word(DEVICE_NAMES.panel, language),
      external_id: panelIds.device,
      should_poll: false,
      params,
      features: Object.entries(PANEL_FEATURES).map(([key, definition]) =>
        feature(panelIds, key, word(FEATURE_NAMES[key], language), definition),
      ),
    },
  ];
  const options = MODES.map((value) => ({ value, label: word(MODE_NAMES[value], language) }));
  for (let n = 1; n <= config.partitions; n += 1) {
    const partitionIds = ids.partition(gladys, n);
    devices.push({
      name: word(DEVICE_NAMES.partition, language)(n),
      external_id: partitionIds.device,
      should_poll: false,
      params: [...params, { name: 'partition', value: String(n) }],
      features: Object.entries(PARTITION_FEATURES).map(([key, definition]) =>
        feature(
          partitionIds,
          key,
          word(FEATURE_NAMES[key], language),
          definition,
          key === 'mode' ? { supported_options: options } : {},
        ),
      ),
    });
  }
  for (const zone of zoneList(config, state)) {
    const zoneIds = ids.zone(gladys, zone.zone);
    const names = { alarm: 'zone-alarm', tamper: 'zone-tamper', fault: 'fault' };
    devices.push({
      name: zone.name || word(DEVICE_NAMES.zone, language)(zone.zone),
      external_id: zoneIds.device,
      should_poll: false,
      params: [
        ...params,
        { name: 'zone', value: String(zone.zone) },
        { name: 'type', value: zone.type },
      ],
      features: [
        feature(
          zoneIds,
          zone.type,
          word(FEATURE_NAMES.state[zone.type], language),
          ZONE_STATE[zone.type],
        ),
        ...Object.entries(ZONE_FEATURES).map(([key, definition]) =>
          feature(zoneIds, key, word(FEATURE_NAMES[names[key]], language), definition),
        ),
      ],
    });
  }
  return devices;
}

const flag = (value) => (value === undefined ? undefined : value ? 1 : 0);

/** Every known state: `[{ device_feature_external_id, state | text }]`. */
export function buildStates(gladys, config, state, { online }) {
  const states = [];
  const push = (deviceIds, key, value) => {
    if (value === undefined) return;
    states.push({
      device_feature_external_id: deviceIds.feature(key),
      ...(typeof value === 'string' ? { text: value } : { state: value }),
    });
  };
  const panel = ids.panel(gladys);
  const { system } = state;
  push(panel, 'online', online ? 1 : 0);
  push(panel, 'ac-power', flag(system.ac));
  push(panel, 'battery-low', flag(system.batteryLow));
  push(panel, 'tamper', flag(system.tamper));
  push(panel, 'trouble', flag(system.trouble));
  push(
    panel,
    'panic',
    Object.keys(system.panic ?? {}).length > 0 ? flag(panicActive(state)) : undefined,
  );
  for (let n = 1; n <= config.partitions; n += 1) {
    const partition = state.partitions[n];
    if (!partition) continue;
    const partitionIds = ids.partition(gladys, n);
    push(partitionIds, 'mode', partition.mode);
    push(partitionIds, 'alarm', flag(partition.alarm));
    push(partitionIds, 'ready', flag(partition.ready));
  }
  for (const { zone: number, type } of zoneList(config, state)) {
    const zone = state.zones[number];
    if (!zone) continue;
    const zoneIds = ids.zone(gladys, number);
    if (zone.open !== undefined) {
      push(
        zoneIds,
        type,
        type === 'opening'
          ? zone.open
            ? OPENING_SENSOR_STATE.OPEN
            : OPENING_SENSOR_STATE.CLOSE
          : flag(zone.open),
      );
    }
    push(zoneIds, 'alarm', flag(zone.alarm));
    push(zoneIds, 'tamper', flag(zone.tamper));
    push(zoneIds, 'fault', flag(zone.fault));
  }
  return states;
}
