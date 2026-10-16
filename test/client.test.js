// The TPI session against the in-memory Envisalink (test/helpers), and one
// session over loopback TCP (127.0.0.1) to check the real socket wiring.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { TIMINGS } from '../src/constants.js';
import { EnvisalinkClient } from '../src/tpi/client.js';
import { frame } from '../src/tpi/dsc.js';
import { FakeEnvisalink, quietLogger, settle } from './helpers/fakeEnvisalink.js';

function setup(t, { type = 'dsc', password = 'user', panelType = 'auto', ...fake } = {}) {
  const server = new FakeEnvisalink({ type, password: 'user', ...fake });
  const logger = quietLogger();
  const client = new EnvisalinkClient({ connect: server.connect, logger });
  const seen = { up: [], down: [], events: [] };
  client.on('up', (info) => seen.up.push(info));
  client.on('down', (info) => seen.down.push(info));
  client.on('event', (event) => seen.events.push(event));
  client.configure({ host: '192.0.2.10', port: 4025, password, panelType });
  t.after(() => client.stop());
  return { server, client, logger, seen };
}

test('DSC: login, status report, events', async (t) => {
  const { server, client, seen } = setup(t);
  client.start();
  await settle();
  assert.deepEqual(server.options, { host: '192.0.2.10', port: 4025 });
  assert.equal(client.connected, true);
  assert.deepEqual(seen.up, [{ panelType: 'dsc' }]);
  assert.deepEqual(server.commands, ['00191'], 'a status report after the login');
  server.dsc('650', '1');
  server.dsc('609', '005');
  server.current.push('6501CD\r\n'); // wrong checksum: ignored
  await settle();
  assert.deepEqual(seen.events, [
    { type: 'partition', partition: 1, ready: true, mode: 'disarmed' },
    { type: 'zone', zone: 5, open: true },
  ]);
});

test('Honeywell: login, keypad updates', async (t) => {
  const { server, client, seen } = setup(t, { type: 'honeywell' });
  client.start();
  await settle();
  assert.equal(client.connected, true);
  assert.deepEqual(seen.up, [{ panelType: 'honeywell' }]);
  assert.deepEqual(server.commands, [], 'Honeywell sends its states by itself');
  server.honeywell('%02,0100000000000000$');
  await settle();
  assert.equal(seen.events[0].mode, 'disarmed');
});

test('a prompt without its line end, frames split across chunks', async (t) => {
  const { server, client, seen } = setup(t, { type: 'honeywell', prompt: false });
  client.start();
  await settle();
  server.current.push('Login:');
  await settle();
  assert.equal(client.connected, true);
  server.current.push('%02,01000');
  server.current.push('00000000000$\r\n');
  await settle();
  assert.equal(seen.events.length, 1);
});

test('the password is never logged, even at debug level', async (t) => {
  const { client, logger } = setup(t, { password: 's3cr3tpw', type: 'honeywell' });
  // Honeywell password: refused by the fake (it expects "user").
  client.start();
  await settle();
  assert.ok(logger.lines.length > 0);
  assert.ok(
    logger.lines.every((line) => !line.includes('s3cr3tpw')),
    logger.lines.join('\n'),
  );
});

test('a refused password: retried slowly, stopped after three', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { server, client, seen } = setup(t, { password: 'wrong' });
  client.start();
  await settle();
  assert.equal(client.connected, false);
  assert.deepEqual(seen.down.at(-1), {
    reason: 'password refused',
    retryIn: TIMINGS.loginRefusedRetry,
    refused: true,
    stopped: false,
    wasUp: false,
  });
  for (let i = 0; i < 2; i += 1) {
    t.mock.timers.tick(TIMINGS.loginRefusedRetry);
    await settle();
  }
  assert.equal(server.sockets.length, 3);
  assert.equal(seen.down.at(-1).stopped, true);
  assert.equal(client.stopped, true);
  t.mock.timers.tick(TIMINGS.loginRefusedRetry * 10);
  await settle();
  assert.equal(server.sockets.length, 3, 'no more logins');
});

test('reconnection with backoff after a refused connection and a dropped session', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { server, client, seen } = setup(t, { refuseConnections: 2 });
  client.start();
  await settle();
  assert.equal(seen.down.at(-1).retryIn, TIMINGS.backoff[0]);
  t.mock.timers.tick(TIMINGS.backoff[0]);
  await settle();
  assert.equal(seen.down.at(-1).retryIn, TIMINGS.backoff[1]);
  t.mock.timers.tick(TIMINGS.backoff[1]);
  await settle();
  assert.equal(client.connected, true);
  assert.equal(server.sockets.length, 3);

  server.drop();
  await settle();
  assert.equal(client.connected, false);
  assert.equal(seen.down.at(-1).wasUp, true);
  assert.equal(seen.down.at(-1).retryIn, TIMINGS.backoff[0], 'the backoff starts over');
  t.mock.timers.tick(TIMINGS.backoff[0]);
  await settle();
  assert.equal(client.connected, true);
  assert.equal(seen.up.length, 2);
});

test('a module that never answers the connection or the login times out', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { client, seen } = setup(t, { prompt: false });
  client.start();
  await settle();
  t.mock.timers.tick(TIMINGS.loginTimeout);
  await settle();
  assert.equal(seen.down[0].reason, 'no login prompt from the Envisalink');
});

test('keep-alive every minute, watchdog when the module goes silent', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { server, client, seen } = setup(t);
  client.start();
  await settle();
  t.mock.timers.tick(TIMINGS.keepAlive);
  await settle();
  assert.deepEqual(server.commands, ['00191', '00090']);
  // The fake acks every poll: still alive well after the watchdog delay.
  for (let i = 0; i < 5; i += 1) {
    t.mock.timers.tick(TIMINGS.keepAlive);
    await settle();
  }
  assert.equal(client.connected, true);
  assert.equal(seen.down.length, 0);

  // A module that stops answering.
  server.current.push = () => undefined;
  for (let i = 0; i < 5 && seen.down.length === 0; i += 1) {
    t.mock.timers.tick(TIMINGS.keepAlive);
    await settle();
  }
  assert.equal(seen.down.at(-1).reason, 'no answer from the Envisalink');
});

test('DSC arming: the code is sent only when the panel asks for it, soon after', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { server, client, seen, logger } = setup(t);
  client.start();
  await settle();
  client.arm(1, 'armed_stay', '4321');
  server.dsc('900', '14');
  await settle();
  assert.deepEqual(server.commands.slice(1), [
    frame('031', '1').trim(),
    frame('200', '432100').trim(),
  ]);
  // A request nobody waits for: refused, reported.
  server.dsc('900', '14');
  await settle();
  assert.equal(server.commands.length, 3);
  assert.equal(seen.events.at(-1).code, 'code_required');
  // Too late.
  client.arm(1, 'armed_away', '4321');
  t.mock.timers.tick(TIMINGS.codeWindow + 1);
  server.dsc('900', '14');
  await settle();
  assert.equal(server.commands.at(-1), frame('030', '1').trim());
  assert.ok(
    logger.lines.every((line) => !line.includes('4321')),
    'the code is never logged',
  );
});

test('commands need a session, Honeywell arming and any disarm need a code', async (t) => {
  const { server, client } = setup(t, { type: 'honeywell' });
  assert.throws(() => client.arm(1, 'armed_away', '1234'), { kind: 'offline' });
  client.start();
  await settle();
  assert.throws(() => client.arm(1, 'armed_away', ''), { kind: 'no_code' });
  assert.throws(() => client.disarm(1, ''), { kind: 'no_code' });
  client.arm(1, 'armed_away', '1234');
  client.disarm(1, '1234');
  client.panic('fire');
  await settle();
  assert.deepEqual(server.commands, ['^03,1,12342$', '^03,1,12341$', '^03,1,AAA$']);
});

test('a forced panel type skips the detection', async (t) => {
  const { client, seen } = setup(t, { type: 'dsc', panelType: 'dsc' });
  client.start();
  await settle();
  assert.deepEqual(seen.up, [{ panelType: 'dsc' }]);
});

test('loopback TCP: a real socket on 127.0.0.1', async (t) => {
  const received = [];
  const server = createServer((socket) => {
    socket.write(frame('505', '3'));
    socket.on('data', (chunk) => {
      for (const line of chunk.toString('latin1').split('\r\n').filter(Boolean)) {
        received.push(line);
        if (line.startsWith('005')) {
          socket.write(frame('505', '1'));
          socket.write(frame('652', '10'));
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const client = new EnvisalinkClient();
  client.configure({
    host: '127.0.0.1',
    port: server.address().port,
    password: 'user',
    panelType: 'auto',
  });
  const event = new Promise((resolve) => client.once('event', resolve));
  client.start();
  t.after(() => client.stop());
  assert.deepEqual(await event, {
    type: 'partition',
    partition: 1,
    mode: 'armed_away',
    ready: false,
    exitDelay: false,
    entryDelay: false,
  });
  assert.equal(received[0], '005user54');
});
