// -----------------------------------------------------------------------------
// The panel as its TPI events describe it (pure).
//
// Both panel families are decoded to the same events (src/tpi/dsc.js,
// src/tpi/honeywell.js): `partition`, `zone`, `zones` (Honeywell bitfield),
// `keypad_clear`, `system`, `panic`, `user`. applyEvent() folds one into the
// state and returns the transitions the scene triggers need:
//
// - `armed` / `disarmed`: a partition whose mode was known changes;
// - `alarm`: a partition goes into alarm, or a panic / fire / medical /
//   duress alarm starts.
//
// A value is `undefined` until the panel said something about it: Gladys gets
// no state for it rather than a guess.
// -----------------------------------------------------------------------------

import { TIMINGS } from './constants.js';

export const emptyState = () => ({
  partitions: {},
  zones: {},
  system: { panic: {} },
  users: {},
});

/** A user event this recent is the author of the arm / disarm that follows or precedes it. */
const USER_WINDOW = 30_000;

/** The zone values a Honeywell keypad text can set (and that expire). */
const KEYPAD_KEYS = ['open', 'alarm', 'tamper', 'fault'];

/** The kind of an alarm, from the kind of the zone in alarm. */
const KIND_OF_ZONE = { opening: 'intrusion', motion: 'intrusion', smoke: 'fire', leak: 'leak' };

const defined = (object) =>
  Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));

function zoneOf(next, number) {
  next.zones[number] ??= { zone: number };
  return next.zones[number];
}

function author(next, partition, action, at) {
  const user = next.users[partition];
  return user && user.action === action && at - user.at <= USER_WINDOW ? user.user : null;
}

const ofPartition = (zone, partition) =>
  zone.partition === undefined || zone.partition === partition;

function dropEmptyKeypad(zone) {
  if (zone.keypad && Object.keys(zone.keypad).length === 0) delete zone.keypad;
}

/**
 * @param {object} state the panel state (not modified)
 * @param {object} event a decoded TPI event
 * @param {{ at: number, zoneType?: (zone: number) => string|undefined }} options the
 *   time of the event (ms), and the configured kind of a zone (opening, motion, smoke, leak)
 * @returns {{ state: object, effects: object[] }}
 */
export function applyEvent(state, event, { at, zoneType = () => undefined }) {
  const next = structuredClone(state);
  const effects = [];

  switch (event.type) {
    case 'partition': {
      const before = next.partitions[event.partition] ?? {};
      const { type: _type, partition: _p, fire, ...values } = event;
      const after = { ...before, ...defined(values) };
      next.partitions[event.partition] = after;
      if (before.mode !== undefined && after.mode !== before.mode) {
        if (after.mode === 'disarmed') {
          effects.push({
            type: 'disarmed',
            partition: event.partition,
            previous: before.mode,
            user: author(next, event.partition, 'disarm', at),
          });
        } else {
          effects.push({
            type: 'armed',
            partition: event.partition,
            mode: after.mode,
            previous: before.mode,
            user: author(next, event.partition, 'arm', at),
          });
        }
      }
      if (after.mode === 'disarmed' && before.mode !== 'disarmed') {
        // A disarm ends the zone alarms of the partition (Honeywell sends no restore).
        for (const zone of Object.values(next.zones)) {
          if (zone.alarm && ofPartition(zone, event.partition)) {
            zone.alarm = false;
            if (zone.keypad) delete zone.keypad.alarm;
            dropEmptyKeypad(zone);
          }
        }
      }
      if (after.alarm === true && before.alarm !== true) {
        const inAlarm = Object.values(next.zones).find(
          (zone) => zone.alarm && ofPartition(zone, event.partition),
        );
        // Without a zone of a known kind, the cause is unknown: say so.
        const kind = fire
          ? 'fire'
          : (KIND_OF_ZONE[inAlarm ? zoneType(inAlarm.zone) : undefined] ?? 'partition');
        effects.push({
          type: 'alarm',
          kind,
          partition: event.partition,
          zone: inAlarm?.zone ?? null,
        });
      }
      break;
    }
    case 'zone': {
      if (!Number.isInteger(event.zone) || event.zone < 1) break;
      const zone = zoneOf(next, event.zone);
      for (const key of KEYPAD_KEYS) {
        if (event[key] === undefined) continue;
        zone[key] = event[key];
        if (event.source === 'keypad') {
          // Seen on the keypad now: it expires unless the keypad shows it again.
          zone.keypad = { ...zone.keypad, [key]: at };
        } else if (zone.keypad) {
          // The TPI said it: no longer the keypad's to expire.
          delete zone.keypad[key];
        }
      }
      dropEmptyKeypad(zone);
      if (event.partition !== undefined) zone.partition = event.partition;
      break;
    }
    case 'zones': {
      event.open.forEach((open, index) => {
        const number = index + 1;
        if (!open && !next.zones[number]) return;
        const zone = zoneOf(next, number);
        zone.open = open;
        if (zone.keypad) delete zone.keypad.open;
        dropEmptyKeypad(zone);
      });
      break;
    }
    case 'keypad_clear': {
      // Ready to arm: nothing of this partition is faulted.
      for (const zone of Object.values(next.zones)) {
        if (!zone.keypad || !ofPartition(zone, event.partition)) continue;
        for (const key of ['open', 'fault']) {
          if (zone.keypad[key] !== undefined) {
            zone[key] = false;
            delete zone.keypad[key];
          }
        }
        dropEmptyKeypad(zone);
      }
      break;
    }
    case 'system': {
      const { type: _type, ...values } = event;
      Object.assign(next.system, defined(values));
      break;
    }
    case 'panic': {
      const wasActive = next.system.panic[event.kind] === true;
      if (event.kind !== 'duress') {
        next.system.panic[event.kind] = event.active;
      }
      if (event.active && !wasActive) {
        effects.push({
          type: 'alarm',
          kind: event.kind,
          partition: event.partition ?? null,
          zone: event.zone ?? null,
        });
      }
      break;
    }
    case 'user': {
      next.users[event.partition] = { action: event.action, user: event.user, at };
      break;
    }
    default:
      break;
  }
  return { state: next, effects };
}

/**
 * Honeywell: what the keypad stopped showing for TIMINGS.keypadFaultExpiry
 * (faults, open zones, zones in alarm, tampers) is over.
 */
export function expireKeypadFaults(state, { at }) {
  let changed = false;
  const next = structuredClone(state);
  for (const zone of Object.values(next.zones)) {
    if (!zone.keypad) continue;
    for (const [key, seen] of Object.entries(zone.keypad)) {
      if (at - seen > TIMINGS.keypadFaultExpiry) {
        zone[key] = false;
        delete zone.keypad[key];
        changed = true;
      }
    }
    dropEmptyKeypad(zone);
  }
  return { state: next, changed };
}

/** True when any panic, fire or medical alarm raised from a key is active. */
export const panicActive = (state) => Object.values(state.system.panic ?? {}).some(Boolean);
