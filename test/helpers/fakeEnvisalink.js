// -----------------------------------------------------------------------------
// An in-memory Envisalink TPI server: no socket, no network. `connect` is
// given to the client in place of net.createConnection; each call opens a
// session that behaves like the module (login prompt, password check, acks of
// the DSC commands and Honeywell `^` commands), records what the client sent,
// and lets the test push panel messages.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { frame } from '../../src/tpi/dsc.js';

/** Lets every queued delivery and the promise chains behind it run. */
export async function settle(rounds = 10) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

class FakeSocket extends EventEmitter {
  constructor(server) {
    super();
    this.server = server;
    this.destroyed = false;
    this.buffer = '';
  }

  setNoDelay() {}

  write(text) {
    if (this.destroyed) throw new Error('write after destroy');
    this.server.written.push(text);
    this.buffer += text;
    const lines = this.buffer.split('\r\n');
    this.buffer = lines.pop();
    for (const line of lines) {
      queueMicrotask(() => this.server.receive(this, line));
    }
    return true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    queueMicrotask(() => this.emit('close'));
  }

  /** Server side: a line to the client. */
  push(text) {
    if (!this.destroyed) queueMicrotask(() => this.emit('data', Buffer.from(text, 'latin1')));
  }
}

export class FakeEnvisalink {
  constructor({ type = 'dsc', password = 'user', prompt = true, refuseConnections = 0 } = {}) {
    this.type = type;
    this.password = password;
    this.prompt = prompt;
    this.sockets = [];
    /** Every line the client sent, per session: [{ session, line }]. */
    this.lines = [];
    this.written = [];
    /** The next N connections fail with ECONNREFUSED. */
    this.refuseConnections = refuseConnections;
    this.connect = this.connect.bind(this);
  }

  connect(options) {
    this.options = options;
    const socket = new FakeSocket(this);
    socket.session = this.sockets.length + 1;
    socket.loggedIn = false;
    this.sockets.push(socket);
    if (this.refuseConnections > 0) {
      this.refuseConnections -= 1;
      queueMicrotask(() => {
        const err = new Error('connect ECONNREFUSED');
        err.code = 'ECONNREFUSED';
        socket.emit('error', err);
      });
      return socket;
    }
    queueMicrotask(() => {
      socket.emit('connect');
      if (this.prompt) socket.push(this.type === 'dsc' ? frame('505', '3') : 'Login:\r\n');
    });
    return socket;
  }

  get current() {
    return this.sockets.at(-1);
  }

  /** The lines of the current session after the login. */
  get commands() {
    const session = this.current?.session;
    return this.lines
      .filter((entry) => entry.session === session && entry.afterLogin)
      .map((entry) => entry.line);
  }

  receive(socket, line) {
    const afterLogin = socket.loggedIn;
    this.lines.push({ session: socket.session, line, afterLogin });
    if (this.type === 'dsc') {
      const command = line.slice(0, 3);
      if (command === '005') {
        const ok = line.slice(3, -2) === this.password;
        socket.push(frame('500', '005'));
        socket.push(frame('505', ok ? '1' : '0'));
        if (ok) socket.loggedIn = true;
        else socket.destroy();
        return;
      }
      socket.push(frame('500', command));
      return;
    }
    if (!socket.loggedIn) {
      const ok = line === this.password;
      socket.push(ok ? 'OK\r\n' : 'FAILED\r\n');
      if (ok) socket.loggedIn = true;
      else socket.destroy();
      return;
    }
    const reply = /^\^([0-9A-F]{2}),/i.exec(line);
    if (reply) socket.push(`^${reply[1]},00$\r\n`);
  }

  /** DSC: a frame with its checksum. */
  dsc(command, data = '') {
    this.current.push(frame(command, data));
  }

  /** Honeywell: a raw line. */
  honeywell(line) {
    this.current.push(`${line}\r\n`);
  }

  /** The module closes the session. */
  drop() {
    this.current.destroy();
  }
}

export const quietLogger = () => {
  const lines = [];
  const log = (level) => (message) => lines.push(`${level} ${message}`);
  return {
    lines,
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
  };
};
