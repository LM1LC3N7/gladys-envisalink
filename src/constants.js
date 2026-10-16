// -----------------------------------------------------------------------------
// Fixed values: manifest keys, Gladys value enums, protocol limits and timings.
// The SDK exports the Gladys categories and types, not the state values: the
// ones used here mirror server/utils/constants.js of the core.
// -----------------------------------------------------------------------------

/** Manifest keys: frozen, users store them in scenes and dashboards. */
export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

export const SCENE_ACTIONS = {
  ARM: 'arm',
  DISARM: 'disarm',
  PANIC: 'panic',
};

export const SCENE_TRIGGERS = {
  ALARM_TRIGGERED: 'alarm_triggered',
  ARMED: 'armed',
  DISARMED: 'disarmed',
};

/** Values of the partition mode select (frozen: scenes compare them). */
export const MODES = ['disarmed', 'armed_away', 'armed_stay', 'armed_night'];
export const ARM_MODES = ['armed_away', 'armed_stay', 'armed_night'];

/** Kinds of the alarm_triggered scene event. */
export const ALARM_KINDS = ['intrusion', 'fire', 'medical', 'panic', 'duress'];

/** Panic alarms the panel can raise from the TPI (DSC 060, Honeywell A/B/C keys). */
export const PANIC_KINDS = ['fire', 'medical', 'police'];

/** How a zone shows in Gladys (frozen: stored in the configuration). */
export const ZONE_TYPES = ['opening', 'motion', 'smoke', 'leak'];

export const PANEL_TYPES = ['auto', 'dsc', 'honeywell'];

/** Gladys core values (server/utils/constants.js). */
export const OPENING_SENSOR_STATE = { OPEN: 0, CLOSE: 1 };

export const LIMITS = {
  maxPartitions: 8,
  /** Highest zone number either panel family reports (Vista-250, DSC 3-digit fields). */
  maxZone: 250,
  /** Lines longer than this are not TPI messages: the buffer is dropped. */
  maxLine: 1024,
  /** Refused passwords in a row before the integration stops logging in. */
  maxLoginRefusals: 3,
  /** States per minute sent to Gladys (the core admits 300). */
  statesPerMinute: 240,
  /** Scene events per minute (the core admits 300). */
  eventsPerMinute: 120,
};

export const DEFAULT_PORT = 4025;

export const TIMINGS = {
  /** TCP connection to the Envisalink. */
  connectTimeout: 10_000,
  /** Login prompt, then the answer to the password. */
  loginTimeout: 10_000,
  /** A keep-alive is sent this often (DSC `000`, Honeywell `^00,$`). */
  keepAlive: 60_000,
  /** Nothing received for this long: the link is dead, reconnect. */
  watchdog: 3 * 60_000,
  /** Waits before reconnecting, in a row (the last one repeats). */
  backoff: [5_000, 10_000, 30_000, 60_000, 120_000, 300_000],
  /** After a refused password: slow down, the module may lock the TPI. */
  loginRefusedRetry: 5 * 60_000,
  /** A DSC "code required" (900) is answered only this soon after a Gladys command. */
  codeWindow: 20_000,
  /** A transition seen this long after a Gladys command is credited to it. */
  commandMemory: 2 * 60_000,
  /**
   * Honeywell: a zone shown faulted on the keypad, never confirmed by a zone
   * bitfield, is closed again when the keypad stops showing it for this long
   * (the keypad cycles through the faulted zones every few seconds).
   */
  keypadFaultExpiry: 45_000,
  /** How often the Honeywell keypad faults are checked for expiry. */
  sweep: 10_000,
  /** publishChangedStates heartbeat. */
  stateHeartbeat: 30 * 60_000,
};
