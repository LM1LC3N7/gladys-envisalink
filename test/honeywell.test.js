// The Honeywell messages: keypad updates, zone and partition bitfields,
// Contact ID events, commands (pure).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decode, encode } from '../src/tpi/honeywell.js';

const pad = (text) => text.padEnd(32, ' ');

test('login and command replies', () => {
  assert.deepEqual(decode('Login:'), [{ type: 'login', result: 'prompt' }]);
  assert.deepEqual(decode('OK'), [{ type: 'login', result: 'ok' }]);
  assert.deepEqual(decode('FAILED'), [{ type: 'login', result: 'refused' }]);
  assert.deepEqual(decode('Timed Out!'), [{ type: 'login', result: 'timeout' }]);
  assert.deepEqual(decode('^00,00$'), [{ type: 'ack', command: '00' }]);
  assert.deepEqual(decode('^03,24$'), [{ type: 'error', code: '24', command: '03' }]);
  assert.deepEqual(decode('garbage'), []);
});

test('keypad update: disarmed and ready, AC present', () => {
  // 0x1008 = ready (0x1000) + AC present (0x0008).
  const [partition, system, clear] = decode(
    `%00,01,1008,000,00,${pad('****DISARMED****  Ready to Arm')}$`,
  );
  assert.deepEqual(partition, {
    type: 'partition',
    partition: 1,
    mode: 'disarmed',
    ready: true,
    alarm: false,
    exitDelay: false,
  });
  assert.deepEqual(system, { type: 'system', ac: true, batteryLow: false, trouble: false });
  assert.deepEqual(clear, { type: 'keypad_clear', partition: 1 });
});

test('keypad update: armed modes from the icons', () => {
  const mode = (icons, text = 'ARMED') => decode(`%00,01,${icons},000,00,${pad(text)}$`)[0].mode;
  assert.equal(mode('0008'), 'disarmed');
  assert.equal(mode('000C'), 'armed_away');
  assert.equal(mode('8008'), 'armed_stay');
  assert.equal(mode('8088'), 'armed_night', 'stay without entry delay (instant)');
  assert.equal(mode('008C'), 'armed_night', 'away without entry delay (maximum)');
  const exit = decode(`%00,01,000C,000,00,${pad('ARMED ***AWAY***May Exit Now  60')}$`)[0];
  assert.equal(exit.exitDelay, true);
});

test('keypad update: a faulted zone, an alarm, a trouble', () => {
  const fault = decode(`%00,01,0008,005,00,${pad('FAULT 05 FRONT DOOR')}$`);
  assert.deepEqual(fault[2], {
    type: 'zone',
    zone: 5,
    partition: 1,
    open: true,
    source: 'keypad',
  });
  assert.equal(fault.length, 3, 'not ready: no keypad_clear');
  const alarm = decode(`%00,01,000D,012,00,${pad('ALARM 012 KITCHEN')}$`);
  assert.equal(alarm[0].alarm, true);
  assert.deepEqual(alarm[2], {
    type: 'zone',
    zone: 12,
    partition: 1,
    alarm: true,
    source: 'keypad',
  });
  // The memory of a disarmed keypad ("ALARM 12" without the alarm bit) is no alarm.
  const memory = decode(`%00,01,0008,012,00,${pad('ALARM 12 KITCHEN')}$`);
  assert.equal(memory.length, 2);
  // Armed, alarm bit not set yet: taken.
  assert.equal(decode(`%00,01,000C,012,00,${pad('ALARM 12 KITCHEN')}$`)[2].alarm, true);
  // A fire alarm says so.
  assert.equal(decode(`%00,01,0108,003,00,${pad('FIRE 03')}$`)[0].fire, true);
  const check = decode(`%00,02,0208,007,00,${pad('CHECK 07')}$`);
  assert.equal(check[1].trouble, true);
  assert.deepEqual(check[2], {
    type: 'zone',
    zone: 7,
    partition: 2,
    fault: true,
    source: 'keypad',
  });
  const battery = decode(`%00,01,4000,000,00,${pad('AC LOSS')}$`);
  assert.deepEqual(battery[1], { type: 'system', ac: false, batteryLow: true, trouble: false });
});

test('zone state change: byte i bit b is zone 8i+b+1', () => {
  // 16 = zones 2, 3, 5; 01 in the second byte = zone 9 (homebridge-envisalink-ademco order).
  const [{ open }] = decode('%01,1601000000000080$');
  const faulted = open.flatMap((value, i) => (value ? [i + 1] : []));
  assert.deepEqual(faulted, [2, 3, 5, 9, 64]);
  assert.equal(open.length, 64);
  // 128 zones on the larger panels.
  const [{ open: wide }] = decode(`%01,${'0'.repeat(30)}80$`);
  assert.equal(wide.length, 128);
  assert.equal(wide[127], true);
  assert.deepEqual(decode('%01,12$'), [], 'a short bitfield is ignored');
  assert.deepEqual(decode(`%01,${'0'.repeat(20)}$`), [], 'not a multiple of 16');
});

test('partition state change', () => {
  const events = decode('%02,0105040800000000$');
  assert.deepEqual(events, [
    { type: 'partition', partition: 1, ready: true, mode: 'disarmed' },
    { type: 'partition', partition: 2, mode: 'armed_away', ready: false, exitDelay: false },
    { type: 'partition', partition: 3, mode: 'armed_stay', ready: false, exitDelay: false },
    { type: 'partition', partition: 4, alarm: true },
  ]);
  assert.deepEqual(decode('%02,0900000000000000$')[0], {
    type: 'partition',
    partition: 1,
    alarm: false,
    mode: 'disarmed',
  });
});

test('Contact ID events', () => {
  // Q EEE PP ZZZ
  assert.deepEqual(decode('%03,344101003$'), [
    { type: 'user', partition: 1, action: 'arm', user: 3 },
  ]);
  assert.deepEqual(decode('%03,140101004$'), [
    { type: 'user', partition: 1, action: 'disarm', user: 4 },
  ]);
  assert.deepEqual(decode('%03,112001000$'), [
    { type: 'panic', kind: 'panic', active: true, partition: 1 },
  ]);
  assert.equal(decode('%03,1120010000$')[0].kind, 'panic', 'a padding digit is tolerated');
  assert.deepEqual(decode('%03,111001009$'), [
    { type: 'panic', kind: 'fire', active: true, partition: 1, zone: 9 },
  ]);
  assert.deepEqual(decode('%03,130100000$'), [{ type: 'system', ac: false }]);
  assert.deepEqual(decode('%03,330100000$'), [{ type: 'system', ac: true }]);
  assert.deepEqual(decode('%03,130200000$'), [{ type: 'system', batteryLow: true }]);
  assert.deepEqual(decode('%03,138301006$'), [{ type: 'zone', zone: 6, tamper: true }]);
  assert.deepEqual(decode('%03,113701000$'), [{ type: 'system', tamper: true }]);
  assert.deepEqual(decode('%03,199901000$'), []);
  // Qualifier 6 (still present): a state, no user action; 406 (cancel) is no arm.
  assert.deepEqual(decode('%03,630200000$'), [{ type: 'system', batteryLow: true }]);
  assert.deepEqual(decode('%03,640101003$'), []);
  assert.deepEqual(decode('%03,140601003$'), []);
  assert.equal(decode('%03,340701002$')[0].action, 'arm', '407 remote arming');
});

test('commands are keypad sequences', () => {
  assert.equal(encode.login('user'), 'user\r\n');
  assert.equal(encode.poll(), '^00,$\r\n');
  assert.equal(encode.arm(1, 'armed_away', '1234'), '^03,1,12342$\r\n');
  assert.equal(encode.arm(2, 'armed_stay', '1234'), '^03,2,12343$\r\n');
  assert.equal(encode.arm(1, 'armed_night', '1234'), '^03,1,12347$\r\n');
  assert.equal(encode.disarm(1, '1234'), '^03,1,12341$\r\n');
  assert.equal(encode.panic('police'), '^03,1,C$\r\n', 'one key, as pyenvisalink');
});
