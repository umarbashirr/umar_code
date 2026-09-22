'use strict';
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const shellEnv = require('../shell-env');

const HANDSHAKE_MS = 20000;

class AcpRpc extends EventEmitter {
  constructor({ bin, argv = ['acp'], cwd, env }) {
    super();
    this.bin = bin;
    this.argv = argv;
    this.cwd = cwd;
    this.env = env;
    this.seq = 0;
    this.pending = new Map();
    this.buf = '';
    this.headers = null;
    this.need = 0;
    this.child = null;
    this.closed = false;
  }

  async start() {
    const viaShell = /\.(cmd|bat)$/i.test(this.bin);
    this.child = spawn(viaShell ? `"${this.bin}"` : this.bin, this.argv, {
      cwd: this.cwd,
      env: { ...shellEnv.env(), ...(this.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: viaShell,
    });

    this.child.stdout.on('data', (d) => this.#read(d));
    this.child.stderr.on('data', (d) => this.emit('stderr', String(d)));
    this.child.on('error', (e) => this.#die(e.message));
    this.child.on('exit', (code, signal) => {
      this.#die(signal ? `agent exited (${signal})` : `agent exited (${code})`);
    });
  }

  #read(chunk) {
    this.buf += chunk;
    if (this.headers == null && this.buf.startsWith('Content-Length:')) {
      this.#readFramed();
      return;
    }
    if (this.headers) {
      this.#readFramed();
      return;
    }
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      if (line.startsWith('Content-Length:')) {
        this.buf = `${line}\n${this.buf}`;
        this.#readFramed();
        return;
      }
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      this.#dispatch(msg);
    }
  }

  #readFramed() {
    while (true) {
      if (!this.headers) {
        const split = this.buf.indexOf('\r\n\r\n') >= 0 ? '\r\n\r\n' : (this.buf.indexOf('\n\n') >= 0 ? '\n\n' : null);
        if (!split) return;
        const i = this.buf.indexOf(split);
        const head = this.buf.slice(0, i);
        const len = Number(/Content-Length:\s*(\d+)/i.exec(head)?.[1]);
        if (!Number.isFinite(len)) {
          this.buf = this.buf.slice(i + split.length);
          continue;
        }
        this.need = len;
        this.headers = true;
        this.buf = this.buf.slice(i + split.length);
      }
      if (Buffer.byteLength(this.buf) < this.need) return;
      const raw = this.buf.slice(0, this.need);
      this.buf = this.buf.slice(this.need);
      this.headers = null;
      this.need = 0;
      let msg;
      try { msg = JSON.parse(raw); } catch { continue; }
      this.#dispatch(msg);
    }
  }

  #dispatch(msg) {
    if (msg.id !== undefined && msg.method === undefined) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(msg.error.message || 'agent refused the request'));
      else entry.resolve(msg.result);
      return;
    }
    if (msg.id !== undefined && msg.method) {
      const respond = {
        result: (value) => this.#send({ jsonrpc: '2.0', id: msg.id, result: value ?? null }),
        error: (err) => this.#send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: err?.code || -32603, message: err?.message || String(err) },
        }),
      };
      this.emit('request', msg.method, msg.params || {}, respond);
      return;
    }
    if (msg.method) this.emit('notification', msg.method, msg.params || {});
  }

  #send(obj) {
    if (this.closed || !this.child?.stdin.writable) return;
    try { this.child.stdin.write(`${JSON.stringify(obj)}\n`); } catch {}
  }

  request(method, params = {}, timeout = 0) {
    if (this.closed) return Promise.reject(new Error('agent is not running'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = timeout
        ? setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`agent did not answer ${method} in time`));
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
    if (this.closed) {
      try { this.child?.kill(); } catch {}
      return;
    }
    this.closed = true;
    for (const [, entry] of this.pending) clearTimeout(entry.timer);
    this.pending.clear();
    try { this.child?.kill(); } catch {}
  }
}

module.exports = { AcpRpc, HANDSHAKE_MS };
