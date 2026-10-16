// -----------------------------------------------------------------------------
// States and scene events to Gladys, under the host API limits (300 states
// and 300 events per minute per integration).
//
// A panel can be chatty (a motion zone opens and closes all day, a Honeywell
// keypad repeats itself every few seconds): states go through
// publishChangedStates (only changes are sent) and a per-minute budget; over
// it, the latest value of each feature waits for the next minute instead of
// being refused by Gladys. Scene events over their budget are dropped and
// logged (they are transitions: a storm of them is a fault, not news).
// -----------------------------------------------------------------------------

import { LIMITS, TIMINGS } from './constants.js';

const WINDOW = 60_000;

export class Budget {
  constructor(perMinute, now) {
    this.perMinute = perMinute;
    this.now = now;
    this.entries = [];
  }

  prune() {
    const limit = this.now() - WINDOW;
    while (this.entries.length > 0 && this.entries[0].at <= limit) this.entries.shift();
  }

  get left() {
    this.prune();
    return this.perMinute - this.entries.reduce((sum, entry) => sum + entry.count, 0);
  }

  /** When the oldest spending leaves the window (ms from now). */
  get wait() {
    this.prune();
    return this.entries.length === 0 ? 0 : Math.max(1, this.entries[0].at + WINDOW - this.now());
  }

  spend(count) {
    if (count > 0) this.entries.push({ at: this.now(), count });
  }
}

export class StatePublisher {
  constructor({ gladys, logger, now = Date.now, timers = globalThis }) {
    this.gladys = gladys;
    this.logger = logger;
    this.timers = timers;
    this.budget = new Budget(LIMITS.statesPerMinute, now);
    this.events = new Budget(LIMITS.eventsPerMinute, now);
    /** feature external id -> state entry, the latest value only. */
    this.pending = new Map();
    this.chain = Promise.resolve();
    this.timer = undefined;
  }

  publish(states) {
    for (const state of states) {
      // Re-inserted at the end: the order of the changes is kept.
      this.pending.delete(state.device_feature_external_id);
      this.pending.set(state.device_feature_external_id, state);
    }
    return this.flush();
  }

  flush() {
    this.chain = this.chain.then(() => this.send()).catch(() => undefined);
    return this.chain;
  }

  async send() {
    if (this.pending.size === 0) return;
    const left = this.budget.left;
    if (left <= 0) {
      this.later();
      return;
    }
    const batch = [...this.pending.values()].slice(0, left);
    for (const state of batch) this.pending.delete(state.device_feature_external_id);
    try {
      const result = await this.gladys.publishChangedStates(batch, {
        heartbeat: TIMINGS.stateHeartbeat,
      });
      this.budget.spend(result?.count ?? batch.length);
    } catch (err) {
      this.logger.warn(`Publishing the states failed: ${err.message}`);
      // Kept for the next try, unless a newer value arrived meanwhile.
      for (const state of batch) {
        if (!this.pending.has(state.device_feature_external_id)) {
          this.pending.set(state.device_feature_external_id, state);
        }
      }
      this.budget.spend(batch.length);
    }
    if (this.pending.size > 0) this.later();
  }

  later() {
    if (this.timer) return;
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.budget.wait || 1_000);
  }

  async sceneEvent(key, data) {
    if (this.events.left <= 0) {
      this.logger.warn(
        `Scene event ${key} dropped: more than ${LIMITS.eventsPerMinute} per minute`,
      );
      return;
    }
    this.events.spend(1);
    await this.gladys
      .publishSceneEvent(key, data)
      .catch((err) => this.logger.warn(`Scene event ${key} refused: ${err.message}`));
  }

  stop() {
    if (this.timer) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
