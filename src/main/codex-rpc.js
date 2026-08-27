'use strict';
/* JSON-RPC over stdio to `codex app-server`.
 *
 * This is the Codex answer to what the Agent SDK does for claude, with one
 * difference worth the whole file: the protocol is published. `codex app-server
 * generate-json-schema --out <dir>` writes it, so the method names and payload
 * shapes below are copied from a contract rather than guessed at from a stream.
 *
 * The server talks three ways at once. Responses to our requests, notifications
 * we never asked for, and requests of its own that expect an answer, which is
 * how every approval arrives. All three land on one stdout, one JSON object per
 * line.
 */
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const shellEnv = require('./shell-env');

// Long enough for a cold start on a slow disk, short enough that a binary which
// will never answer does not hold a chat open forever.
const HANDSHAKE_MS = 20000;

class AppServer extends EventEmitter {
  constructor({ bin, cwd, config = [] }) {
    super();
    this.bin = bin;
    this.cwd = cwd;
    this.config = config;
    this.seq = 0;
    this.pending = new Map();      // request id -> { resolve, reject }
    this.buf = '';
    this.child = null;
    this.closed = false;
  }

  async start({ clientInfo }) {
    const args = ['app-server'];
    // Config overrides are how anything gets into the session that is not a
    // protocol field: the MCP server carrying the preview tools, mostly.
    for (const kv of this.config) args.push('-c', kv);

    this.child = spawn(this.bin, args, {
      cwd: this.cwd,
      // Same reason as the claude side: launched from a desktop entry the app
      // has almost no environment, and codex reads CODEX_HOME and the login
      // out of it. See shell-env.js.
      env: shellEnv.env(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout.on('data', (d) => this.#read(d));
    this.child.stderr.on('data', (d) => {
      const s = String(d);
      // The Linux sandbox complains on every start when bubblewrap cannot make
      // a user namespace. It is noise on a machine where that is never going to
      // work, and it would be the first thing in every transcript.
      if (/bubblewrap|user namespaces/.test(s)) return;
      this.emit('stderr', s);
    });
    this.child.on('error', (e) => this.#die(e.message));
    this.child.on('exit', (code) => this.#die(`codex app-server exited (${code})`));

    return this.request('initialize', { clientInfo }, HANDSHAKE_MS);
  }

  #read(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      this.#dispatch(msg);
    }
  }

  #dispatch(msg) {
    // A response: it carries an id we handed out and no method.
    if (msg.id !== undefined && msg.method === undefined) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(msg.error.message || 'codex refused the request'));
      else entry.resolve(msg.result);
      return;
    }
    // A request from the server. Something has to answer it or the turn stops
    // there, so these are kept apart from notifications.
    if (msg.id !== undefined && msg.method) {
      this.emit('request', msg.method, msg.params || {}, (result) => this.#send({
        jsonrpc: '2.0', id: msg.id, result,
      }));
      return;
    }
    if (msg.method) this.emit('notification', msg.method, msg.params || {});
  }

  #send(obj) {
    if (this.closed || !this.child?.stdin.writable) return;
    try { this.child.stdin.write(`${JSON.stringify(obj)}\n`); } catch {}
  }

  request(method, params = {}, timeout = 0) {
    if (this.closed) return Promise.reject(new Error('codex app-server is not running'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = timeout
        ? setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`codex did not answer ${method} in time`));
        }, timeout)
        : null;
      this.pending.set(id, { resolve, reject, timer });
      this.#send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params = {}) {
    this.#send({ jsonrpc: '2.0', method, params });
  }

  #die(why) {
    if (this.closed) return;
    this.closed = true;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(why));
    }
    this.pending.clear();
    this.emit('closed', why);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const [, entry] of this.pending) clearTimeout(entry.timer);
    this.pending.clear();
    try { this.child?.kill(); } catch {}
  }
}

module.exports = { AppServer };
