// The DSC frames: checksum, parsing, decoding and encoding (pure).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checksum, decode, encode, frame, parseFrame } from '../src/tpi/dsc.js';

const events = (line) => decode(parseFrame(line));

test('checksums of the EyezOn document examples', () => {
  // 505 + 3 (login prompt) and 000 (poll), as the module and pyenvisalink send them.
  assert.equal(checksum('5053'), 'CD');
  assert.equal(checksum('000'), '90');
  assert.equal(frame('005', 'user'), '005user54\r\n');
  assert.equal(frame('030', '1'), '0301C4\r\n');
});

test('a frame with a wrong checksum is ignored', () => {
  assert.deepEqual(parseFrame('5053CD'), { command: '505', data: '3' });
  assert.equal(parseFrame('5053CE'), undefined);
  assert.equal(parseFrame('hello'), undefined);
  assert.equal(parseFrame(''), undefined);
  assert.deepEqual(parseFrame('6501cc'), { command: '650', data: '1' }, 'lower-case checksum');
});

test('login replies', () => {
  assert.deepEqual(events(frame('505', '3').trim()), [{ type: 'login', result: 'prompt' }]);
  assert.deepEqual(events(frame('505', '1').trim()), [{ type: 'login', result: 'ok' }]);
  assert.deepEqual(events(frame('505', '0').trim()), [{ type: 'login', result: 'refused' }]);
  assert.deepEqual(events(frame('505', '2').trim()), [{ type: 'login', result: 'timeout' }]);
});

test('partition states', () => {
  assert.deepEqual(events(frame('650', '1').trim()), [
    { type: 'partition', partition: 1, ready: true, mode: 'disarmed' },
  ]);
  assert.deepEqual(events(frame('651', '2').trim()), [
    { type: 'partition', partition: 2, ready: false },
  ]);
  const modes = ['0', '1', '2', '3'].map((m) => events(frame('652', `1${m}`).trim())[0].mode);
  assert.deepEqual(modes, ['armed_away', 'armed_stay', 'armed_night', 'armed_night']);
  assert.equal(events(frame('652', '1').trim())[0].mode, 'armed_away', 'older firmware: no mode');
  assert.deepEqual(events(frame('654', '1').trim()), [
    { type: 'partition', partition: 1, alarm: true },
  ]);
  assert.equal(events(frame('655', '1').trim())[0].mode, 'disarmed');
  assert.equal(events(frame('655', '1').trim())[0].alarm, false);
  assert.equal(events(frame('656', '1').trim())[0].exitDelay, true);
  assert.equal(events(frame('657', '1').trim())[0].entryDelay, true);
  // 510: keypad LEDs: the ready flag only, never the mode.
  assert.deepEqual(events(frame('510', '81').trim()), [
    { type: 'partition', partition: 1, ready: true },
  ]);
  assert.deepEqual(events(frame('510', '82').trim()), [
    { type: 'partition', partition: 1, ready: false },
  ]);
});

test('zones', () => {
  assert.deepEqual(events(frame('609', '012').trim()), [{ type: 'zone', zone: 12, open: true }]);
  assert.deepEqual(events(frame('610', '012').trim()), [{ type: 'zone', zone: 12, open: false }]);
  assert.deepEqual(events(frame('601', '1005').trim()), [
    { type: 'zone', partition: 1, zone: 5, alarm: true },
  ]);
  assert.deepEqual(events(frame('602', '1005').trim())[0].alarm, false);
  assert.deepEqual(events(frame('603', '2007').trim()), [
    { type: 'zone', partition: 2, zone: 7, tamper: true },
  ]);
  assert.equal(events(frame('604', '2007').trim())[0].tamper, false);
  assert.deepEqual(events(frame('605', '003').trim()), [{ type: 'zone', zone: 3, fault: true }]);
  assert.equal(events(frame('606', '003').trim())[0].fault, false);
});

test('system troubles, panic, users, code required', () => {
  assert.deepEqual(events(frame('802').trim()), [{ type: 'system', ac: false }]);
  assert.deepEqual(events(frame('803').trim()), [{ type: 'system', ac: true }]);
  assert.deepEqual(events(frame('800').trim()), [{ type: 'system', batteryLow: true }]);
  assert.deepEqual(events(frame('829').trim()), [{ type: 'system', tamper: true }]);
  assert.deepEqual(events(frame('840', '1').trim()), [{ type: 'system', trouble: true }]);
  assert.deepEqual(events(frame('849', '02').trim()), [
    { type: 'system', trouble: true, ac: false },
  ]);
  assert.deepEqual(events(frame('849', '00').trim()), [
    { type: 'system', trouble: false, ac: true },
  ]);
  // Keypad panics: credited to partition 1.
  assert.deepEqual(events(frame('625').trim()), [
    { type: 'panic', kind: 'panic', active: true, partition: 1 },
  ]);
  assert.deepEqual(events(frame('622').trim()), [
    { type: 'panic', kind: 'fire', active: false, partition: 1 },
  ]);
  assert.deepEqual(events(frame('700', '10003').trim()), [
    { type: 'user', partition: 1, action: 'arm', user: 3 },
  ]);
  assert.deepEqual(events(frame('750', '10040').trim()), [
    { type: 'user', partition: 1, action: 'disarm', user: 40 },
  ]);
  // A user field that is not digits: no user (never NaN, refused by the SDK).
  assert.deepEqual(events(frame('700', '1ab12').trim()), [
    { type: 'user', partition: 1, action: 'arm', user: null },
  ]);
  assert.deepEqual(events(frame('750', '1').trim()), [
    { type: 'user', partition: 1, action: 'disarm', user: null },
  ]);
  assert.deepEqual(events(frame('900', '14').trim()), [{ type: 'code_required', partition: 1 }]);
  assert.deepEqual(events(frame('670', '1').trim()), [
    { type: 'error', code: 'invalid_code', partition: 1 },
  ]);
  assert.deepEqual(events(frame('500', '030').trim()), [{ type: 'ack', command: '030' }]);
  assert.deepEqual(events(frame('999').trim()), [], 'unknown commands are ignored');
});

test('commands', () => {
  assert.equal(encode.poll(), '00090\r\n');
  assert.equal(encode.status(), '00191\r\n');
  assert.equal(encode.arm(1, 'armed_away'), frame('030', '1'));
  assert.equal(encode.arm(2, 'armed_stay'), frame('031', '2'));
  assert.equal(encode.arm(1, 'armed_night'), frame('032', '1'));
  assert.equal(encode.disarm(1, '1234'), frame('040', '11234'));
  assert.equal(encode.panic('police'), frame('060', '3'));
  assert.equal(encode.panic('fire'), frame('060', '1'));
  assert.equal(encode.code('1234'), frame('200', '123400'), 'a 4-digit code is padded');
  assert.equal(encode.code('123456'), frame('200', '123456'));
});
