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

/**
 * @param {object} state the panel state (not modified)
 * @param {object} event a decoded TPI event
 * @param {{ at: number }} options the time of the event (ms)
 * @returns {{ state: object, effects: object[] }}
 */
export function applyEvent(state, event, { at }) {
  const next = structuredClone(state);
  const effects = [];

  switch (event.type) {
    case 'partition': {
      const before = next.partitions[event.partition] ?? {};
      const { type: _type, partition: _p, ...values } = event;
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
          if (zone.alarm && (zone.partition === undefined || zone.partition === event.partition)) {
            zone.alarm = false;
          }
        }
      }
      if (after.alarm === true && before.alarm !== true) {
        const inAlarm = Object.values(next.zones).find(
          (zone) =>
            zone.alarm && (zone.partition === undefined || zone.partition === event.partition),
        );
        effects.push({
          type: 'alarm',
          kind: 'intrusion',
          partition: event.partition,
          zone: inAlarm?.zone ?? null,
        });
      }
      break;
    }
    case 'zone': {
      if (!Number.isInteger(event.zone) || event.zone < 1) break;
      const zone = zoneOf(next, event.zone);
      for (const key of ['open', 'alarm', 'tamper', 'fault']) {
        if (event[key] !== undefined) zone[key] = event[key];
      }
      if (event.partition !== undefined) zone.partition = event.partition;
      if (event.source === 'keypad') {
        zone.seen = at;
        // A zone the keypad showed stays the keypad's until a bitfield confirms it.
        if (event.open || event.fault) zone.source = 'keypad';
      } else if (event.open !== undefined) {
        zone.source = 'tpi';
      }
      break;
    }
    case 'zones': {
      event.open.forEach((open, index) => {
        const number = index + 1;
        if (!open && !next.zones[number]) return;
        const zone = zoneOf(next, number);
        zone.open = open;
        zone.source = 'tpi';
      });
      break;
    }
    case 'keypad_clear': {
      for (const zone of Object.values(next.zones)) {
        if (
          zone.source === 'keypad' &&
          (zone.partition === undefined || zone.partition === event.partition)
        ) {
          zone.open = false;
          zone.fault = false;
          delete zone.source;
        }
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

/** Honeywell: the zones the keypad stopped showing are closed again. */
export function expireKeypadFaults(state, { at }) {
  let changed = false;
  const next = structuredClone(state);
  for (const zone of Object.values(next.zones)) {
    if (zone.source === 'keypad' && at - (zone.seen ?? 0) > TIMINGS.keypadFaultExpiry) {
      zone.open = false;
      zone.fault = false;
      delete zone.source;
      changed = true;
    }
  }
  return { state: next, changed };
}

/** True when any panic, fire or medical alarm raised from a key is active. */
export const panicActive = (state) => Object.values(state.system.panic ?? {}).some(Boolean);
