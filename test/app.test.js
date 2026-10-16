// -----------------------------------------------------------------------------
// EnvisalinkApp with the SDK's fake Gladys (createFakeGladys) and the
// in-memory Envisalink (test/helpers/fakeEnvisalink.js): the whole chain from
// the TPI lines to the Gladys devices, states, scene events and commands.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { EnvisalinkApp } from '../src/app.js';
import { LIMITS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { frame } from '../src/tpi/dsc.js';
import { FakeEnvisalink, quietLogger, settle } from './helpers/fakeEnvisalink.js';

const BASE = { host: '192.0.2.10', password: 'user', language: 'en' };

async function setup(t, { config = {}, type = 'dsc' } = {}) {
  const gladys = createFakeGladys({ config: { ...BASE, ...config } });
  const server = new FakeEnvisalink({ type });
  const logger = quietLogger();
  const app = new EnvisalinkApp({ gladys, logger, connect: server.connect });
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  t.after(() => app.stop());
  await settle();
  const device = (externalId) =>
    gladys.fake.discoveredDevices.find((d) => d.external_id === externalId);
  return {
    gladys,
    server,
    app,
    logger,
    device,
    panel: gladys.externalIds('panel', 'envisalink'),
    partition: (n = 1) => gladys.externalIds('partition', String(n)),
    zone: (n) => gladys.externalIds('zone', String(n)),
    state: (id) => gladys.fake.lastState(id),
  };
}

const modeFeature = (ctx, n = 1) => {
  const device = ctx.device(ctx.partition(n).device);
  return { device, feature: device.features.find((f) => f.external_id.endsWith(':mode')) };
};

test('start: the devices, the link up, the status', async (t) => {
  const ctx = await setup(t, { config: { zones: '1=Front door, 2=Hall:motion' } });
  const { gladys, panel, partition, zone } = ctx;
  assert.deepEqual(
    gladys.fake.discoveredDevices.map((d) => [d.external_id, d.name]),
    [
      [panel.device, 'Envisalink panel'],
      [partition(1).device, 'Alarm partition 1'],
      [zone(1).device, 'Front door'],
      [zone(2).device, 'Hall'],
    ],
  );
  const hall = ctx.device(zone(2).device);
  assert.equal(hall.features[0].category, 'motion-sensor');
  assert.equal(ctx.device(zone(1).device).features[0].category, 'opening-sensor');
  const { feature } = modeFeature(ctx);
  assert.equal(feature.read_only, false);
  assert.deepEqual(
    feature.supported_options.map((o) => o.value),
    ['disarmed', 'armed_away', 'armed_stay', 'armed_night'],
  );
  assert.equal(ctx.state(panel.feature('online')), 1);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(gladys.fake.connectionStatus.message.en, /DSC PowerSeries panel \(1: \?\)/);
  assert.equal(ctx.device(panel.device).params[0].value, 'dsc');
  assert.ok(gladys.fake.transports.every((entry) => entry.transport === 'local'));
});

test('DSC events become states', async (t) => {
  const ctx = await setup(t, { config: { zones: '1, 2=Hall:motion' } });
  const { server, panel, partition, zone } = ctx;
  server.dsc('650', '1');
  server.dsc('609', '001');
  server.dsc('609', '002');
  server.dsc('603', '1002');
  server.dsc('605', '001');
  server.dsc('802');
  server.dsc('800');
  server.dsc('829');
  server.dsc('840', '1');
  await settle();
  assert.equal(ctx.state(partition().feature('mode')), 'disarmed');
  assert.equal(ctx.state(partition().feature('ready')), 1);
  assert.equal(ctx.state(zone(1).feature('state')), 0, 'opening: 0 = open (core convention)');
  assert.equal(ctx.state(zone(2).feature('state')), 1, 'motion: 1 = motion');
  assert.equal(ctx.state(zone(2).feature('tamper')), 1);
  assert.equal(ctx.state(zone(1).feature('fault')), 1);
  assert.equal(ctx.state(panel.feature('ac-power')), 0);
  assert.equal(ctx.state(panel.feature('battery-low')), 1);
  assert.equal(ctx.state(panel.feature('tamper')), 1);
  assert.equal(ctx.state(panel.feature('trouble')), 1);
  server.dsc('610', '001');
  await settle();
  assert.equal(ctx.state(zone(1).feature('state')), 1, 'closed');
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /\(1: disarmed\)/);
});

test('a zone the panel reports is added as a device', async (t) => {
  const ctx = await setup(t);
  assert.equal(ctx.gladys.fake.discoveredDevices.length, 2);
  ctx.server.dsc('609', '017');
  await settle();
  assert.equal(ctx.device(ctx.zone(17).device).name, 'Zone 17');
  assert.equal(ctx.state(ctx.zone(17).feature('state')), 0);
});

test('arming from the keypad, an alarm, a disarm: scene events', async (t) => {
  const ctx = await setup(t);
  const { server, gladys, partition } = ctx;
  server.dsc('650', '1');
  server.dsc('700', '10005');
  server.dsc('652', '10');
  server.dsc('601', '1003');
  server.dsc('654', '1');
  server.dsc('750', '10002');
  server.dsc('655', '1');
  await settle();
  assert.deepEqual(gladys.fake.sceneEvents, [
    { key: 'armed', data: { partition: '1', mode: 'armed_away', user: 5, by_gladys: false } },
    { key: 'alarm_triggered', data: { partition: '1', kind: 'intrusion', zone: 3 } },
    { key: 'disarmed', data: { partition: '1', user: 2, by_gladys: false } },
  ]);
  assert.deepEqual(
    gladys.fake.states
      .filter((s) => s.device_feature_external_id === partition().feature('alarm'))
      .map((s) => s.state),
    [1, 0],
  );
  assert.ok(ctx.logger.lines.some((line) => /ALARM intrusion partition 1 zone 3/.test(line)));
});

test('panic keys: alarm event and panic state', async (t) => {
  const ctx = await setup(t);
  ctx.server.dsc('625');
  await settle();
  assert.equal(ctx.state(ctx.panel.feature('panic')), 1);
  assert.deepEqual(ctx.gladys.fake.sceneEvents.at(-1), {
    key: 'alarm_triggered',
    data: { partition: null, kind: 'panic', zone: null },
  });
  ctx.server.dsc('626');
  await settle();
  assert.equal(ctx.state(ctx.panel.feature('panic')), 0);
});

test('arming from Gladys: the frame, the feedback, by_gladys', async (t) => {
  const ctx = await setup(t);
  const { server, gladys } = ctx;
  server.dsc('650', '1');
  await settle();
  const { device, feature } = modeFeature(ctx);
  const ack = await gladys.fake.setValue(device, feature, 'armed_stay');
  assert.equal(ack.success, true, ack.error);
  await settle();
  assert.equal(server.commands.at(-1), frame('031', '1').trim());
  server.dsc('652', '11');
  await settle();
  assert.equal(ctx.state(feature.external_id), 'armed_stay');
  assert.deepEqual(gladys.fake.sceneEvents.at(-1).data.by_gladys, true);
  assert.ok(
    ctx.logger.lines.some((line) => /ARMING from Gladys: armed stay, partition 1/.test(line)),
  );
  // Already in that mode: nothing sent.
  const count = server.commands.length;
  await gladys.fake.setValue(device, feature, 'armed_stay');
  assert.equal(server.commands.length, count);
  // Another mode while armed: disarm first.
  const other = await gladys.fake.setValue(device, feature, 'armed_away');
  assert.equal(other.success, false);
  assert.match(other.error, /disarm it first/);
});

test('arming can be forbidden', async (t) => {
  const ctx = await setup(t, { config: { allow_arm: false } });
  const { device, feature } = modeFeature(ctx);
  const ack = await ctx.gladys.fake.setValue(device, feature, 'armed_away');
  assert.equal(ack.success, false);
  assert.match(ack.error, /Arming from Gladys is disabled/);
  assert.deepEqual(ctx.server.commands, ['00191']);
});

test('disarming is off by default: refused, logged, the real mode sent again', async (t) => {
  const ctx = await setup(t, { config: { user_code: '1234' } });
  const { server, gladys } = ctx;
  server.dsc('652', '10');
  await settle();
  const { device, feature } = modeFeature(ctx);
  const before = gladys.fake.states.length;
  const ack = await gladys.fake.setValue(device, feature, 'disarmed');
  assert.equal(ack.success, false);
  assert.match(ack.error, /Disarming from Gladys is disabled/);
  assert.deepEqual(server.commands, ['00191'], 'nothing sent');
  assert.ok(ctx.logger.lines.some((line) => /^warn Disarm REFUSED/.test(line)));
  const resent = gladys.fake.states.slice(before);
  assert.deepEqual(resent, [
    { device_feature_external_id: feature.external_id, text: 'armed_away' },
  ]);
  const scene = await gladys.fake.sceneAction('disarm', { partition: '1' });
  assert.equal(scene.success, false);
});

test('disarming when allowed: the code is sent, never logged', async (t) => {
  const ctx = await setup(t, { config: { user_code: '864209', allow_disarm: true } });
  const { server, gladys } = ctx;
  server.dsc('652', '10');
  await settle();
  const { device, feature } = modeFeature(ctx);
  const ack = await gladys.fake.setValue(device, feature, 'disarmed');
  assert.equal(ack.success, true, ack.error);
  await settle();
  assert.equal(server.commands.at(-1), frame('040', '1864209').trim());
  assert.ok(
    ctx.logger.lines.every((line) => !line.includes('864209')),
    ctx.logger.lines.join('\n'),
  );
  server.dsc('655', '1');
  await settle();
  assert.equal(gladys.fake.sceneEvents.at(-1).data.by_gladys, true);
});

test('disarming needs a valid code', async (t) => {
  const ctx = await setup(t, { config: { allow_disarm: true, user_code: '12' } });
  const ack = await ctx.gladys.fake.sceneAction('disarm', { partition: '1' });
  assert.equal(ack.success, false);
  assert.match(ack.error, /4 to 8 digits/);
});

test('Honeywell: keypad updates, zone bitfield, arming with the code', async (t) => {
  const ctx = await setup(t, {
    type: 'honeywell',
    config: { user_code: '1234', zones: '1, 2, 3', partitions: 2 },
  });
  const { server, gladys, panel, partition, zone } = ctx;
  assert.match(gladys.fake.connectionStatus.message.en, /Honeywell Vista panel/);
  server.honeywell('%01,0300000000000000$');
  server.honeywell('%00,01,0008,005,00,FAULT 05 GARAGE                 $');
  server.honeywell('%02,0301000000000000$');
  await settle();
  assert.equal(ctx.state(partition(1).feature('mode')), 'disarmed');
  assert.equal(ctx.state(partition(1).feature('ready')), 0);
  assert.equal(ctx.state(partition(2).feature('ready')), 1);
  assert.equal(ctx.state(panel.feature('ac-power')), 1);
  assert.equal(ctx.state(zone(1).feature('state')), 0, 'open from the bitfield');
  assert.equal(ctx.state(zone(2).feature('state')), 0);
  assert.equal(ctx.state(zone(5).feature('state')), 0, 'open from the keypad');
  const ack = await gladys.fake.sceneAction('arm', { partition: '2', mode: 'armed_night' });
  assert.equal(ack.success, true, ack.error);
  await settle();
  assert.equal(server.commands.at(-1), '^03,2,12347$');
  assert.ok(ctx.logger.lines.every((line) => !line.includes('12347')));
  // Ready: the keypad fault of partition 1 is cleared.
  server.honeywell('%00,01,1008,000,00,****DISARMED****  Ready to Arm  $');
  await settle();
  assert.equal(ctx.state(zone(5).feature('state')), 1);
});

test('Honeywell arming without a code is refused with a message', async (t) => {
  const ctx = await setup(t, { type: 'honeywell' });
  const ack = await ctx.gladys.fake.sceneAction('arm', {});
  assert.equal(ack.success, false);
  assert.match(ack.error, /needs the user code/);
});

test('panic is off by default, sent when allowed', async (t) => {
  let ctx = await setup(t);
  let ack = await ctx.gladys.fake.sceneAction('panic', { kind: 'police' });
  assert.equal(ack.success, false);
  assert.match(ack.error, /Panic alarms from Gladys are disabled/);
  ctx = await setup(t, { config: { allow_panic: true } });
  ack = await ctx.gladys.fake.sceneAction('panic', { kind: 'police' });
  assert.equal(ack.success, true, ack.error);
  await settle();
  assert.equal(ctx.server.commands.at(-1), frame('060', '3').trim());
});

test('commands while the link is down say so', async (t) => {
  const ctx = await setup(t);
  ctx.server.drop();
  await settle();
  assert.equal(ctx.state(ctx.panel.feature('online')), 0);
  assert.equal(ctx.gladys.fake.connectionStatus.connected, false);
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /next try in 5 s/);
  assert.ok(ctx.gladys.fake.transports.some((entry) => entry.transport === 'unreachable'));
  const ack = await ctx.gladys.fake.sceneAction('arm', {});
  assert.equal(ack.success, false);
  assert.match(ack.error, /not connected/);
});

test('unknown partitions and read-only features are refused', async (t) => {
  const ctx = await setup(t);
  const ack = await ctx.gladys.fake.sceneAction('arm', { partition: '3' });
  assert.match(ack.error, /Partition 3 is not in the configuration/);
  const panel = ctx.device(ctx.panel.device);
  const set = await ctx.gladys.fake.setValue(panel, panel.features[0], 1);
  assert.match(set.error, /read-only/);
});

test('test the connection', async (t) => {
  const ctx = await setup(t, { config: { zones: '1-3' } });
  ctx.server.dsc('652', '12');
  await settle();
  const ack = await ctx.gladys.fake.action('test_connection');
  assert.equal(ack.success, true, ack.error);
  assert.equal(
    ack.data.message.en,
    'Connected to the DSC PowerSeries panel (1: armed night), 3 zone(s) known.',
  );
  assert.match(
    ack.data.message.fr,
    /Connecté à la centrale DSC PowerSeries \(1 : |1: armée \(nuit\)/,
  );
  assert.equal(ctx.server.commands.at(-1), '00191', 'a status report');
});

test('configuration problems show in the status, without any connection', async (t) => {
  const ctx = await setup(t, { config: { host: '', password: '' } });
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /Enter the address/);
  assert.equal(ctx.server.sockets.length, 0);
  const ack = await ctx.gladys.fake.action('test_connection');
  assert.equal(ack.success, false);
  await ctx.gladys.fake.configUpdated({ ...BASE });
  await settle();
  assert.equal(ctx.gladys.fake.connectionStatus.connected, true);
});

test('a refused password shows in the status; the test button retries', async (t) => {
  const ctx = await setup(t, { config: { password: 'wrong' } });
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /refused the password/);
  const ack = await ctx.gladys.fake.action('test_connection');
  assert.equal(ack.success, false);
  assert.match(ack.error, /refused the password/);
});

test('a configuration change: names apply at once, a new password reconnects', async (t) => {
  const ctx = await setup(t);
  await ctx.gladys.fake.configUpdated({ ...BASE, language: 'fr', partitions: 2 });
  await settle();
  assert.equal(ctx.device(ctx.partition(2).device).name, 'Alarme partition 2');
  assert.equal(ctx.server.sockets.length, 1, 'same link: no reconnection');
  ctx.server.password = 'other';
  await ctx.gladys.fake.configUpdated({ ...BASE, password: 'other' });
  await settle();
  assert.equal(ctx.server.sockets.length, 2);
  assert.equal(ctx.gladys.fake.connectionStatus.connected, true);
});

test('a created device gets its states again', async (t) => {
  const ctx = await setup(t);
  ctx.server.dsc('650', '1');
  await settle();
  const count = ctx.gladys.fake.states.length;
  await ctx.gladys.fake.deviceCreated(ctx.device(ctx.partition().device));
  await settle();
  const sent = ctx.gladys.fake.states.slice(count).map((s) => s.device_feature_external_id);
  assert.ok(sent.includes(ctx.partition().feature('mode')));
});

test('a storm of zone changes stays under the state budget', async (t) => {
  const ctx = await setup(t);
  const before = ctx.gladys.fake.states.length;
  for (let i = 0; i < 200; i += 1) {
    ctx.server.dsc(i % 2 ? '610' : '609', '004');
  }
  // 200 changes of one zone plus 50 other zones opening.
  for (let z = 10; z < 60; z += 1) ctx.server.dsc('609', String(z).padStart(3, '0'));
  await settle(40);
  const sent = ctx.gladys.fake.states.length - before;
  assert.ok(sent <= LIMITS.statesPerMinute, `${sent} states in a minute`);
  assert.ok(sent > 50);
});
