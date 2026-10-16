// -----------------------------------------------------------------------------
// The Honeywell / Ademco Vista flavour of the Envisalink TPI (pure).
//
// The module asks `Login:`, takes the password followed by CR LF and answers
// `OK`, `FAILED` or `Timed Out!`. It then sends `%XX,data$` messages and
// answers commands with `^XX,EE$`. Layouts from the EyezOn "Envisalink TPI
// Programmer's Document" for Honeywell and ufodone/pyenvisalink (MIT):
//
// - `%00,PP,IIII,NNN,BB,ALPHA$` virtual keypad update: partition, icon
//   bitfield (hex), zone or user number, beeps, the 32 keypad characters;
// - `%01,<16 hex>$` zone state change: 8 bytes, byte i bit b = zone 8i+b+1
//   faulted (pyenvisalink's byte swapping gives the same order);
// - `%02,<16 hex>$` partition state change: one byte per partition (1-8);
// - `%03,QEEEPPZZZ$` Contact ID event: qualifier (1 new event or opening,
//   3 restore or closing), event code, partition, zone or user.
//
// Commands: `^00,$` keep-alive, `^03,P,keys$` keys to a partition; the alarm
// commands are keypad sequences: code + 2 away, + 3 stay, + 7 instant (stay
// without entry delay: "night" here), + 1 off; A / B / C pressed three times
// fire / medical / police panic, as pyenvisalink does.
// -----------------------------------------------------------------------------

export const ICONS = {
  alarm: 0x0001,
  alarmInMemory: 0x0002,
  armedAway: 0x0004,
  acPresent: 0x0008,
  bypass: 0x0010,
  chime: 0x0020,
  armedZeroEntry: 0x0080,
  alarmFire: 0x0100,
  trouble: 0x0200,
  ready: 0x1000,
  fire: 0x2000,
  lowBattery: 0x4000,
  armedStay: 0x8000,
};

/** %02 partition state codes. */
const PARTITION_STATES = {
  '01': { ready: true, mode: 'disarmed' },
  '02': { ready: true, mode: 'disarmed' },
  '03': { ready: false, mode: 'disarmed' },
  '04': { mode: 'armed_stay', ready: false, exitDelay: false },
  '05': { mode: 'armed_away', ready: false, exitDelay: false },
  '06': { mode: 'armed_night', ready: false, exitDelay: false },
  '07': { exitDelay: true },
  '08': { alarm: true },
  // Alarm in memory: the partition was disarmed after an alarm.
  '09': { alarm: false, mode: 'disarmed' },
};

/** ^XX,EE$ error codes. */
export const COMMAND_ERRORS = {
  '00': undefined,
  '01': 'receive buffer overrun',
  '02': 'receive buffer overflow',
  '03': 'transmit buffer overflow',
  10: 'keybus transmit buffer overrun',
  11: 'keybus transmit time timeout',
  12: 'keybus transmit mode timeout',
  13: 'keybus transmit keystring timeout',
  14: 'keybus interface not functioning',
  15: 'keybus busy (the panel is being programmed)',
  16: 'keybus busy, lockout',
  17: 'keybus busy, installer mode',
  18: 'keybus busy, general busy',
  20: 'API command syntax error',
  21: 'API command partition error',
  22: 'API command not supported',
  23: 'API system not armed',
  24: 'API system not ready to arm',
  25: 'API command invalid length',
  26: 'API user code not required',
  27: 'API invalid characters in command',
};

const ARM_KEYS = { armed_away: '2', armed_stay: '3', armed_night: '7' };
const PANIC_KEYS = { fire: 'A', medical: 'B', police: 'C' };

const keys = (partition, sequence) => `^03,${partition},${sequence}$\r\n`;

export const encode = {
  login: (password) => `${password}\r\n`,
  poll: () => '^00,$\r\n',
  arm: (partition, mode, code) => keys(partition, `${code}${ARM_KEYS[mode]}`),
  disarm: (partition, code) => keys(partition, `${code}1`),
  panic: (kind, partition = 1) => keys(partition, PANIC_KEYS[kind].repeat(3)),
};

/** Keypad texts naming a zone: `FAULT 05 FRONT DOOR`, `ALARM 012`, `CHECK 3`. */
const KEYPAD_ZONE = /^(FAULT|ALARM|CHECK|FIRE|TAMPER)\s+0*(\d{1,3})\b/;

function keypadUpdate(fields) {
  const [rawPartition, rawIcons, rawNumber, , ...rest] = fields;
  const partition = Number.parseInt(rawPartition, 10);
  const icons = Number.parseInt(rawIcons, 16);
  if (!Number.isInteger(partition) || !Number.isFinite(icons)) {
    return [];
  }
  const alpha = rest.join(',').replace(/^"|"$/g, '').trim().toUpperCase();
  const has = (bit) => (icons & bit) !== 0;
  let mode = 'disarmed';
  if (has(ICONS.armedStay) && has(ICONS.armedZeroEntry)) mode = 'armed_night';
  else if (has(ICONS.armedAway) && has(ICONS.armedZeroEntry)) mode = 'armed_night';
  else if (has(ICONS.armedStay)) mode = 'armed_stay';
  else if (has(ICONS.armedAway)) mode = 'armed_away';
  const events = [
    {
      type: 'partition',
      partition,
      mode,
      ready: has(ICONS.ready),
      alarm: has(ICONS.alarm) || has(ICONS.alarmFire),
      // The "ARMED ... MAY EXIT NOW" text is the only exit delay sign of the keypad.
      exitDelay: mode !== 'disarmed' && /EXIT/.test(alpha),
    },
    {
      type: 'system',
      ac: has(ICONS.acPresent),
      batteryLow: has(ICONS.lowBattery),
      trouble: has(ICONS.trouble),
    },
  ];
  const match = KEYPAD_ZONE.exec(alpha);
  const number = match ? Number(match[2]) : Number.parseInt(rawNumber, 10);
  if (match && Number.isInteger(number) && number > 0) {
    const what = match[1];
    if (what === 'FAULT') {
      events.push({ type: 'zone', zone: number, partition, open: true, source: 'keypad' });
    } else if (what === 'ALARM' || what === 'FIRE') {
      events.push({ type: 'zone', zone: number, partition, alarm: true, source: 'keypad' });
    } else if (what === 'TAMPER') {
      events.push({ type: 'zone', zone: number, partition, tamper: true, source: 'keypad' });
    } else {
      events.push({ type: 'zone', zone: number, partition, fault: true, source: 'keypad' });
    }
  }
  if (has(ICONS.ready) && mode === 'disarmed') {
    // Ready to arm: no zone of this partition is faulted.
    events.push({ type: 'keypad_clear', partition });
  }
  return events;
}

function zoneStates(hex) {
  if (!/^[0-9A-F]{16}$/i.test(hex)) return [];
  const states = [];
  for (let byte = 0; byte < 8; byte += 1) {
    const value = Number.parseInt(hex.slice(byte * 2, byte * 2 + 2), 16);
    for (let bit = 0; bit < 8; bit += 1) {
      states.push(Boolean(value & (1 << bit)));
    }
  }
  return [{ type: 'zones', open: states }];
}

function partitionStates(hex) {
  if (!/^[0-9A-F]{16}$/i.test(hex)) return [];
  const events = [];
  for (let index = 0; index < 8; index += 1) {
    const state = PARTITION_STATES[hex.slice(index * 2, index * 2 + 2).toUpperCase()];
    if (state) {
      events.push({ type: 'partition', partition: index + 1, ...state });
    }
  }
  return events;
}

/** Contact ID codes used here (SIA DC-05). */
function contactId(text) {
  // QEEEPPZZZ; some firmwares are said to add a padding digit: tolerated.
  const match = /^([136])(\d{3})(\d{2})(\d{3})\d?$/.exec(text);
  if (!match) return [];
  const restore = match[1] === '3';
  const code = Number(match[2]);
  const partition = Number(match[3]) || 1;
  const number = Number(match[4]);
  const active = !restore;
  if ((code >= 400 && code <= 409) || code === 441 || code === 442) {
    // 1 = opening (disarm), 3 = closing (arm); the number is the user.
    return [{ type: 'user', partition, action: restore ? 'arm' : 'disarm', user: number || null }];
  }
  if (code === 120 || code === 122 || code === 123) {
    return [{ type: 'panic', kind: 'panic', active, partition }];
  }
  if (code === 121) return [{ type: 'panic', kind: 'duress', active, partition }];
  if (code >= 110 && code <= 118) {
    return [{ type: 'panic', kind: 'fire', active, partition, zone: number || null }];
  }
  if (code === 100 || code === 101) {
    return [{ type: 'panic', kind: 'medical', active, partition }];
  }
  if (code === 301) return [{ type: 'system', ac: restore }];
  if (code === 302 || code === 309) return [{ type: 'system', batteryLow: active }];
  if (code === 137 || code === 144 || code === 145 || code === 383) {
    return number > 0
      ? [{ type: 'zone', zone: number, tamper: active }]
      : [{ type: 'system', tamper: active }];
  }
  if (code === 380 || code === 381 || code === 384) {
    return number > 0 ? [{ type: 'zone', zone: number, fault: active }] : [];
  }
  return [];
}

/** One line -> its events, plus the protocol replies (`login`, `ack`, `error`). */
export function decode(line) {
  const text = String(line ?? '').trim();
  if (text === 'Login:') return [{ type: 'login', result: 'prompt' }];
  if (text === 'OK') return [{ type: 'login', result: 'ok' }];
  if (text === 'FAILED') return [{ type: 'login', result: 'refused' }];
  if (/^Timed Out/i.test(text)) return [{ type: 'login', result: 'timeout' }];
  const reply = /^\^([0-9A-F]{2}),([0-9A-F]{2})\$$/i.exec(text);
  if (reply) {
    return reply[2] === '00'
      ? [{ type: 'ack', command: reply[1] }]
      : [{ type: 'error', code: reply[2], command: reply[1] }];
  }
  const message = /^%([0-9A-F]{2}),(.*)\$$/i.exec(text);
  if (!message) return [];
  const [, kind, body] = message;
  switch (kind.toUpperCase()) {
    case '00':
      return keypadUpdate(body.split(','));
    case '01':
      return zoneStates(body);
    case '02':
      return partitionStates(body);
    case '03':
      return contactId(body);
    default:
      return [];
  }
}
