// The state and scene event budgets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS } from '../src/constants.js';
import { Budget, StatePublisher } from '../src/publisher.js';
import { quietLogger, settle } from './helpers/fakeEnvisalink.js';

test('a budget frees what leaves the one-minute window', () => {
  let now = 0;
  const budget = new Budget(10, () => now);
  budget.spend(8);
  now = 30_000;
  budget.spend(2);
  assert.equal(budget.left, 0);
  assert.equal(budget.wait, 30_000);
  now = 60_000;
  assert.equal(budget.left, 8);
});

test('over budget, the latest values wait for the next minute', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const sent = [];
  const gladys = {
    publishChangedStates: async (batch) => {
      sent.push(...batch);
      return { count: batch.length };
    },
  };
  const publisher = new StatePublisher({ gladys, logger: quietLogger() });
  const state = (i, value) => ({ device_feature_external_id: `f${i}`, state: value });
  await publisher.publish(
    Array.from({ length: LIMITS.statesPerMinute + 20 }, (_, i) => state(i, 1)),
  );
  assert.equal(sent.length, LIMITS.statesPerMinute);
  // A newer value of a waiting feature replaces it.
  await publisher.publish([state(LIMITS.statesPerMinute + 5, 2)]);
  assert.equal(sent.length, LIMITS.statesPerMinute);
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(sent.length, LIMITS.statesPerMinute + 20);
  assert.equal(
    sent.find((s) => s.device_feature_external_id === `f${LIMITS.statesPerMinute + 5}`).state,
    2,
  );
  publisher.stop();
});

test('scene events over their budget are dropped and logged', async () => {
  const events = [];
  const logger = quietLogger();
  const publisher = new StatePublisher({
    gladys: { publishSceneEvent: async (key) => events.push(key) },
    logger,
  });
  for (let i = 0; i < LIMITS.eventsPerMinute + 3; i += 1) await publisher.sceneEvent('armed', {});
  assert.equal(events.length, LIMITS.eventsPerMinute);
  assert.equal(logger.lines.filter((l) => /dropped/.test(l)).length, 3);
});
