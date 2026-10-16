// The configuration: address, code, zone list, defaults.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, parseHost, parseZones, sessionKey } from '../src/config.js';

test('defaults', () => {
  const config = normalizeConfig();
  assert.equal(config.host, '');
  assert.equal(config.port, 4025);
  assert.equal(config.panelType, 'auto');
  assert.equal(config.partitions, 1);
  assert.equal(config.allowArm, true);
  assert.equal(config.allowDisarm, false, 'disarming is opt-in');
  assert.equal(config.allowPanic, false, 'panic is opt-in');
  assert.equal(config.code, '');
  assert.equal(config.language, 'fr');
});

test('the address', () => {
  assert.deepEqual(parseHost(' 192.168.1.40 '), { host: '192.168.1.40', port: undefined });
  assert.deepEqual(parseHost('evl.lan:4026'), { host: 'evl.lan', port: 4026 });
  assert.deepEqual(parseHost('tcp://192.168.1.40:4025/'), { host: '192.168.1.40', port: 4025 });
  assert.deepEqual(parseHost('[fd00::12]:4025'), { host: 'fd00::12', port: 4025 });
  assert.deepEqual(parseHost(''), { host: '' });
  assert.deepEqual(parseHost('a b'), { host: '' });
  assert.equal(normalizeConfig({ host: 'evl:5000', port: 4025 }).port, 5000);
  assert.equal(normalizeConfig({ host: 'evl', port: 4030 }).port, 4030);
  assert.equal(normalizeConfig({ host: 'evl', port: 99999 }).port, 65535);
});

test('the user code: 4 to 8 digits, else ignored and flagged', () => {
  assert.equal(normalizeConfig({ user_code: ' 1234 ' }).code, '1234');
  assert.equal(normalizeConfig({ user_code: '123456' }).code, '123456');
  const bad = normalizeConfig({ user_code: '12a4' });
  assert.equal(bad.code, '');
  assert.equal(bad.codeInvalid, true);
  assert.equal(normalizeConfig({}).codeInvalid, false);
});

test('the zone list', () => {
  const { zones, errors } = parseZones(
    "1=Porte d'entrée, 2=Couloir:motion; 3:smoke\n5=Cuisine:leak, 10-12, 13=motion, bad, 300",
  );
  assert.deepEqual(zones, [
    { zone: 1, name: "Porte d'entrée", type: 'opening' },
    { zone: 2, name: 'Couloir', type: 'motion' },
    { zone: 3, name: '', type: 'smoke' },
    { zone: 5, name: 'Cuisine', type: 'leak' },
    { zone: 10, name: '', type: 'opening' },
    { zone: 11, name: '', type: 'opening' },
    { zone: 12, name: '', type: 'opening' },
    { zone: 13, name: 'motion', type: 'opening' },
  ]);
  assert.deepEqual(errors, ['bad', '300']);
  assert.deepEqual(parseZones('4-2').errors, ['4-2']);
  assert.deepEqual(parseZones(undefined), { zones: [], errors: [] });
  assert.deepEqual(parseZones('7=Garage:Window').zones, [
    { zone: 7, name: 'Garage:Window', type: 'opening' },
  ]);
});

test('partitions are bounded, unknown values fall back', () => {
  assert.equal(normalizeConfig({ partitions: 12 }).partitions, 8);
  assert.equal(normalizeConfig({ partitions: 0 }).partitions, 1);
  assert.equal(normalizeConfig({ panel_type: 'ademco' }).panelType, 'auto');
  assert.equal(normalizeConfig({ panel_type: 'Honeywell' }).panelType, 'honeywell');
  assert.equal(normalizeConfig({ language: 'de' }).language, 'fr');
});

test('only the link settings reconnect', () => {
  const a = normalizeConfig({ host: 'evl', password: 'user' });
  const b = normalizeConfig({ host: 'evl', password: 'user', zones: '1', allow_disarm: true });
  const c = normalizeConfig({ host: 'evl', password: 'other' });
  assert.equal(sessionKey(a), sessionKey(b));
  assert.notEqual(sessionKey(a), sessionKey(c));
});
