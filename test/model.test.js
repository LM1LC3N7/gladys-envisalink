// The panel state and its transitions (pure).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIMINGS } from '../src/constants.js';
import { applyEvent, emptyState, expireKeypadFaults, panicActive } from '../src/model.js';

function run(events, state = emptyState(), at = 1_000) {
  const effects = [];
  for (const event of events) {
    const result = applyEvent(state, event, { at });
    state = result.state;
    effects.push(...result.effects);
  }
  return { state, effects };
}

test('no transition before the mode is known, then armed and disarmed', () => {
  let { state, effects } = run([{ type: 'partition', partition: 1, mode: 'armed_away' }]);
  assert.deepEqual(effects, [], 'first reading: nothing happened');
  ({ state, effects } = run(
    [
      { type: 'partition', partition: 1, mode: 'disarmed', ready: true },
      { type: 'partition', partition: 1, exitDelay: true },
      { type: 'partition', partition: 1, mode: 'armed_stay', exitDelay: false },
    ],
    state,
  ));
  assert.deepEqual(effects, [
    { type: 'disarmed', partition: 1, previous: 'armed_away', user: null },
    { type: 'armed', partition: 1, mode: 'armed_stay', previous: 'disarmed', user: null },
  ]);
  assert.deepEqual(state.partitions[1], {
    mode: 'armed_stay',
    ready: true,
    exitDelay: false,
  });
});

test('the user of a recent user event is credited', () => {
  let { state } = run([{ type: 'partition', partition: 1, mode: 'disarmed' }]);
  const first = run([{ type: 'user', partition: 1, action: 'arm', user: 7 }], state, 10_000);
  const armed = applyEvent(
    first.state,
    { type: 'partition', partition: 1, mode: 'armed_away' },
    { at: 15_000 },
  );
  assert.equal(armed.effects[0].user, 7);
  // Too old, or another action: no author.
  const late = applyEvent(
    first.state,
    { type: 'partition', partition: 1, mode: 'armed_away' },
    { at: 60_000 },
  );
  assert.equal(late.effects[0].user, null);
  state = armed.state;
  const disarmed = applyEvent(
    state,
    { type: 'partition', partition: 1, mode: 'disarmed' },
    { at: 16_000 },
  );
  assert.equal(disarmed.effects[0].user, null);
});

test('an alarm: one event with the zone in alarm, cleared by the disarm', () => {
  let { state, effects } = run([
    { type: 'partition', partition: 1, mode: 'armed_away' },
    { type: 'zone', partition: 1, zone: 4, alarm: true },
    { type: 'partition', partition: 1, alarm: true },
    { type: 'partition', partition: 1, alarm: true },
  ]);
  assert.deepEqual(effects, [{ type: 'alarm', kind: 'intrusion', partition: 1, zone: 4 }]);
  ({ state, effects } = run(
    [{ type: 'partition', partition: 1, mode: 'disarmed', alarm: false }],
    state,
  ));
  assert.equal(state.zones[4].alarm, false);
  assert.equal(effects[0].type, 'disarmed');
});

test('panic: an alarm event when it starts, the state until its restore', () => {
  let { state, effects } = run([
    { type: 'panic', kind: 'panic', active: true },
    { type: 'panic', kind: 'panic', active: true },
  ]);
  assert.deepEqual(effects, [{ type: 'alarm', kind: 'panic', partition: null, zone: null }]);
  assert.equal(panicActive(state), true);
  ({ state } = run([{ type: 'panic', kind: 'panic', active: false }], state));
  assert.equal(panicActive(state), false);
  // Duress: an event, no state (the panel sends no restore).
  ({ state, effects } = run([{ type: 'panic', kind: 'duress', active: true }], state));
  assert.equal(effects[0].kind, 'duress');
  assert.equal(panicActive(state), false);
});

test('zones: TPI states, the Honeywell bitfield, keypad faults that expire', () => {
  let { state } = run([
    { type: 'zone', zone: 3, open: true },
    { type: 'zone', zone: 3, tamper: true },
    { type: 'zone', zone: 3, fault: false },
  ]);
  assert.deepEqual(state.zones[3], {
    zone: 3,
    open: true,
    tamper: true,
    fault: false,
    source: 'tpi',
  });
  const open = Array(64).fill(false);
  open[1] = true;
  ({ state } = run([{ type: 'zones', open }], state));
  assert.equal(state.zones[3].open, false, 'a known zone closes');
  assert.equal(state.zones[2].open, true, 'an open zone is added');
  assert.equal(state.zones[10], undefined, 'closed unknown zones are not added');

  ({ state } = run(
    [{ type: 'zone', zone: 9, partition: 1, open: true, source: 'keypad' }],
    state,
    100_000,
  ));
  assert.equal(state.zones[9].source, 'keypad');
  let expired = expireKeypadFaults(state, { at: 100_000 + TIMINGS.keypadFaultExpiry - 1 });
  assert.equal(expired.changed, false);
  expired = expireKeypadFaults(state, { at: 100_000 + TIMINGS.keypadFaultExpiry + 1 });
  assert.equal(expired.changed, true);
  assert.equal(expired.state.zones[9].open, false);
  assert.equal(expired.state.zones[2].open, true, 'bitfield zones do not expire');

  // Ready to arm: the keypad zones of that partition are closed at once.
  const cleared = run([{ type: 'keypad_clear', partition: 1 }], state).state;
  assert.equal(cleared.zones[9].open, false);
  assert.equal(cleared.zones[2].open, true);
});

test('system values merge, undefined values are ignored', () => {
  const { state } = run([
    { type: 'system', ac: false, batteryLow: true },
    { type: 'system', trouble: true, ac: undefined },
  ]);
  assert.deepEqual(state.system, { panic: {}, ac: false, batteryLow: true, trouble: true });
});

test('the state given is not modified', () => {
  const state = emptyState();
  applyEvent(state, { type: 'zone', zone: 1, open: true }, { at: 0 });
  assert.deepEqual(state, emptyState());
});
