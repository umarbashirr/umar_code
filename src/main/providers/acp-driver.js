'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { AcpRpc, HANDSHAKE_MS } = require('./acp-rpc');
const { CLIENT } = require('./acp-session');
const { modelsFrom } = require('./acp-models');
const shellEnv = require('../shell-env');

const PROBE_TIMEOUT_MS = 20000;
const TTL_MS = 6 * 60 * 60 * 1000;

const parseVersion = (out) => out.match(/(?:\bv|\b)(\d+\.\d+\.\d+[\w.-]*)\b/)?.[1] || null;

function probeVersion(bin, args = ['--version']) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };

    let child;
    try {
      const viaShell = /\.(cmd|bat)$/i.test(bin);
      child = spawn(viaShell ? `"${bin}"` : bin, args, {
        stdio: ['ignore', 'pipe', 'pipe'], env: shellEnv.env(), shell: viaShell,
      });
    } catch { return finish(null); }

    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish(null); }, 8000);
    const read = (s) => s.on('data', (d) => { if (out.length < 4096) out += d; });
    read(child.stdout);
    read(child.stderr);
    child.on('error', () => { clearTimeout(timer); finish(null); });
    child.on('close', () => { clearTimeout(timer); finish(parseVersion(out)); });
  });
}

function isAuth(err) {
  return err?.code === 'auth' || /auth|login|unauthor/i.test(err?.message || '');
}

async function probeModels(bin, spec) {
  if (typeof spec.discoverModels === 'function') {
    return spec.discoverModels(bin);
  }
  const rpc = new AcpRpc({
    bin,
    argv: spec.argv || ['acp'],
    cwd: os.homedir(),
    env: spec.env ? spec.env() : undefined,
  });
  try {
    await rpc.start();
    await rpc.request('initialize', {
      protocolVersion: 1,
      clientInfo: CLIENT,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    }, HANDSHAKE_MS);
    const ses = await rpc.request('session/new', { cwd: os.homedir(), mcpServers: [] }, PROBE_TIMEOUT_MS);
    const listed = modelsFrom(ses);
    return listed.length ? listed : null;
  } catch (e) {
    if (isAuth(e)) throw e;
    return null;
  } finally {
    rpc.close();
  }
}

class AcpDriver {
  constructor({ spec, cacheDir }) {
    this.spec = spec;
    this.file = path.join(cacheDir, 'drivers', `${spec.id}.json`);
    this.snapshot = this.#read() || {
      installed: false, version: null, status: 'unknown',
      models: [], message: `Checking for ${spec.cli}…`, checkedAt: null,
    };
    this.inflight = null;
  }

  #read() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return null; }
  }

  #write(snapshot) {
    this.snapshot = snapshot;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(snapshot, null, 2));
    } catch {}
    return snapshot;
  }

  get stale() {
    if (!this.snapshot.checkedAt) return true;
    const bin = this.spec.binary();
    if (this.snapshot.installed && (!bin || bin !== this.snapshot.binaryPath)) return true;
    return Date.now() - this.snapshot.checkedAt > TTL_MS;
  }

  current({ refresh = true } = {}) {
    if (refresh && this.stale) this.refresh().catch(() => {});
    return { ...this.snapshot };
  }

  async refresh() {
    if (this.inflight) return this.inflight;
    this.inflight = this.#probe()
      .then(() => this.current({ refresh: false }))
      .finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async #probe() {
    const bin = this.spec.binary();
    const checkedAt = Date.now();
    if (!bin) {
      return this.#write({
        installed: false, version: null, status: 'missing', models: [], checkedAt,
        message: this.spec.missing, binaryPath: null,
      });
    }

    const version = await probeVersion(bin, this.spec.versionArgs || ['--version']);
    let models = null;
    try {
      models = await probeModels(bin, this.spec);
    } catch (e) {
      if (isAuth(e)) {
        return this.#write({
          installed: true, version, status: 'error', models: [], checkedAt, binaryPath: bin,
          message: `${this.spec.cli} is installed but not logged in. Run \`${this.spec.login}\` in a terminal.`,
        });
      }
    }

    const list = (models && models.length) ? models : (this.spec.catalog || []);
    return this.#write({
      installed: true, version, status: list.length ? 'ready' : 'error',
      models: list, checkedAt, binaryPath: bin,
      message: list.length ? null
        : `${this.spec.cli} is installed but did not list any models. Run \`${this.spec.login}\` in a terminal.`,
    });
  }

  learn(models) {
    if (!Array.isArray(models) || !models.length) return;
    const clean = models.map((m) => ({
      value: m.value || m.modelId || m.id,
      displayName: m.displayName || m.name || m.value || m.modelId || m.id,
    })).filter((m) => m.value);
    if (!clean.length) return;
    this.#write({
      ...this.snapshot, models: clean, status: 'ready', message: null, checkedAt: Date.now(),
    });
  }
}

module.exports = { AcpDriver, probeVersion, probeModels, parseVersion };
