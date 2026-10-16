// -----------------------------------------------------------------------------
// The DSC PowerSeries flavour of the Envisalink TPI (pure).
//
// Frames are ASCII lines: a 3-digit command, its data, a 2-character checksum
// (the sum of the bytes of command + data, low byte, upper-case hex), CR LF.
// The codes and their data layout follow the EyezOn "Envisalink TPI
// Programmer's Document" for DSC and the behaviour of ufodone/pyenvisalink
// (MIT): login 005 / 505, poll 000, status 001, arm 030 / 031 / 032, disarm
// 040, panic 060, code send 200; zone 601-610, partition 650-673, user
// 700 / 750, system 800-849, code required 900.
//
// decode() turns one received line into the protocol-neutral events of
// src/model.js; the encoders build the frames the client sends.
// -----------------------------------------------------------------------------

export function checksum(text) {
  let sum = 0;
  for (const char of text) {
    sum += char.charCodeAt(0);
  }
  return (sum & 0xff).toString(16).toUpperCase().padStart(2, '0');
}

export const frame = (command, data = '') => `${command}${data}${checksum(command + data)}\r\n`;

/** `6501` + checksum -> { command: '650', data: '1' }; undefined when the checksum is wrong. */
export function parseFrame(line) {
  const text = String(line ?? '').trim();
  if (!/^\d{3}[\x20-\x7e]*[0-9A-F]{2}$/i.test(text) || text.length < 5) {
    return undefined;
  }
  const body = text.slice(0, -2);
  if (checksum(body) !== text.slice(-2).toUpperCase()) {
    return undefined;
  }
  return { command: body.slice(0, 3), data: body.slice(3) };
}

export const COMMANDS = {
  POLL: '000',
  STATUS: '001',
  LOGIN: '005',
  ARM_AWAY: '030',
  ARM_STAY: '031',
  ARM_ZERO_ENTRY: '032',
  DISARM: '040',
  PANIC: '060',
  CODE: '200',
};

/** Commands whose data holds a password or a user code: never logged. */
export const SECRET_COMMANDS = new Set([COMMANDS.LOGIN, COMMANDS.DISARM, COMMANDS.CODE]);

const ARM_COMMANDS = {
  armed_away: COMMANDS.ARM_AWAY,
  armed_stay: COMMANDS.ARM_STAY,
  armed_night: COMMANDS.ARM_ZERO_ENTRY,
};
const PANIC_DATA = { fire: '1', medical: '2', police: '3' };

export const encode = {
  login: (password) => frame(COMMANDS.LOGIN, password),
  poll: () => frame(COMMANDS.POLL),
  status: () => frame(COMMANDS.STATUS),
  arm: (partition, mode) => frame(ARM_COMMANDS[mode], String(partition)),
  disarm: (partition, code) => frame(COMMANDS.DISARM, `${partition}${code}`),
  panic: (kind) => frame(COMMANDS.PANIC, PANIC_DATA[kind]),
  // The code send of a "code required" wants 6 digits: a 4-digit code is padded with 00.
  code: (code) => frame(COMMANDS.CODE, code.length === 4 ? `${code}00` : code),
};

/** 652 armed modes (descriptive arming, recent firmwares; absent on older ones). */
const ARMED_MODES = {
  0: 'armed_away',
  1: 'armed_stay',
  2: 'armed_night',
  3: 'armed_night',
};

/** 502 system error codes worth a readable log line. */
export const SYSTEM_ERRORS = {
  '017': 'keybus busy, installer mode',
  '021': 'requested partition is out of bounds',
  '023': 'partition is not armed',
  '024': 'partition is not ready to arm',
  '026': 'user code not required',
  '028': 'virtual keypad is disabled',
  '029': 'not valid parameter',
  '030': 'keypad does not come out of blank mode',
  '031': 'IT-100 is already in thermostat menu',
  '032': 'IT-100 is not in thermostat menu',
  '033': 'IT-100 did not get a response from the thermostat',
};

const zone = (text) => Number.parseInt(text, 10);
const partition = (text) => Number.parseInt(text, 10);

/**
 * One frame -> the events it carries (src/model.js), plus the protocol
 * replies the client handles itself (`login`, `ack`, `error`, `code_required`).
 */
export function decode({ command, data }) {
  const p = partition(data.slice(0, 1));
  switch (command) {
    case '500':
      return [{ type: 'ack', command: data.slice(0, 3) }];
    case '501':
      return [{ type: 'error', code: 'checksum' }];
    case '502':
      return [{ type: 'error', code: data.slice(0, 3) }];
    case '505':
      // 0 refused, 1 accepted, 2 timed out, 3 asks for the password.
      return [
        { type: 'login', result: { 0: 'refused', 1: 'ok', 2: 'timeout', 3: 'prompt' }[data] },
      ];
    case '601':
      return [{ type: 'zone', partition: p, zone: zone(data.slice(1, 4)), alarm: true }];
    case '602':
      return [{ type: 'zone', partition: p, zone: zone(data.slice(1, 4)), alarm: false }];
    case '603':
      return [{ type: 'zone', partition: p, zone: zone(data.slice(1, 4)), tamper: true }];
    case '604':
      return [{ type: 'zone', partition: p, zone: zone(data.slice(1, 4)), tamper: false }];
    case '605':
      return [{ type: 'zone', zone: zone(data.slice(0, 3)), fault: true }];
    case '606':
      return [{ type: 'zone', zone: zone(data.slice(0, 3)), fault: false }];
    case '609':
      return [{ type: 'zone', zone: zone(data.slice(0, 3)), open: true }];
    case '610':
      return [{ type: 'zone', zone: zone(data.slice(0, 3)), open: false }];
    // The keypad keys carry no partition: the keypads of partition 1 send them
    // in most homes, so they are credited to it (a scene filter on 1 matches).
    case '620':
      return [{ type: 'panic', kind: 'duress', active: true, partition: 1 }];
    case '621':
      return [{ type: 'panic', kind: 'fire', active: true, partition: 1 }];
    case '622':
      return [{ type: 'panic', kind: 'fire', active: false, partition: 1 }];
    case '623':
      return [{ type: 'panic', kind: 'medical', active: true, partition: 1 }];
    case '624':
      return [{ type: 'panic', kind: 'medical', active: false, partition: 1 }];
    case '625':
      return [{ type: 'panic', kind: 'panic', active: true, partition: 1 }];
    case '626':
      return [{ type: 'panic', kind: 'panic', active: false, partition: 1 }];
    case '510': {
      // Keypad LEDs of partition 1, bit 0 Ready. Only the ready flag is taken:
      // the Armed LED also lights during the exit delay and blinks in some
      // states, the mode comes from 650 / 652 / 653 / 655 only.
      const leds = Number.parseInt(data.slice(0, 2), 16);
      if (!Number.isFinite(leds)) return [];
      return [{ type: 'partition', partition: 1, ready: (leds & 0x01) !== 0 }];
    }
    case '650':
    case '653':
      // Ready (or ready to force arm): only a disarmed partition is.
      return [{ type: 'partition', partition: p, ready: true, mode: 'disarmed' }];
    case '651':
      return [{ type: 'partition', partition: p, ready: false }];
    case '652':
      return [
        {
          type: 'partition',
          partition: p,
          mode: ARMED_MODES[data.slice(1, 2)] ?? 'armed_away',
          ready: false,
          exitDelay: false,
          entryDelay: false,
        },
      ];
    case '654':
      return [{ type: 'partition', partition: p, alarm: true }];
    case '655':
      return [
        {
          type: 'partition',
          partition: p,
          mode: 'disarmed',
          alarm: false,
          exitDelay: false,
          entryDelay: false,
        },
      ];
    case '656':
      return [{ type: 'partition', partition: p, exitDelay: true }];
    case '657':
      return [{ type: 'partition', partition: p, entryDelay: true }];
    case '659':
    case '672':
      return [{ type: 'error', code: 'arm_failed', partition: p }];
    case '670':
      return [{ type: 'error', code: 'invalid_code', partition: p }];
    case '673':
      return [{ type: 'error', code: 'busy', partition: p }];
    case '700':
      return [{ type: 'user', partition: p, action: 'arm', user: Number(data.slice(1, 5)) }];
    case '701':
    case '702':
      return [{ type: 'user', partition: p, action: 'arm', user: null }];
    case '750':
      return [{ type: 'user', partition: p, action: 'disarm', user: Number(data.slice(1, 5)) }];
    case '751':
      return [{ type: 'user', partition: p, action: 'disarm', user: null }];
    case '800':
      return [{ type: 'system', batteryLow: true }];
    case '801':
      return [{ type: 'system', batteryLow: false }];
    case '802':
      return [{ type: 'system', ac: false }];
    case '803':
      return [{ type: 'system', ac: true }];
    case '829':
      return [{ type: 'system', tamper: true }];
    case '830':
      return [{ type: 'system', tamper: false }];
    case '840':
      return [{ type: 'system', trouble: true }];
    case '841':
      return [{ type: 'system', trouble: false }];
    case '849': {
      // Verbose trouble status: bit 1 = AC lost; any bit = a trouble.
      const bits = Number.parseInt(data.slice(0, 2), 16);
      if (!Number.isFinite(bits)) return [];
      return [{ type: 'system', trouble: bits !== 0, ac: (bits & 0x02) === 0 }];
    }
    case '900':
      return [{ type: 'code_required', partition: p }];
    default:
      return [];
  }
}
