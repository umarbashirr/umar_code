'use strict';
// What the agent panel knows about the claude CLI without starting one.
//
// Populating the model picker used to call query.supportedModels(), which needs
// a live session, which spawns the ~360MB claude binary. That happened on mount,
// so opening the window paid for an agent nobody had talked to yet.
//
// Instead: find the binary, ask it for its version, and filter a catalogue held
// here. The answer is written to userData/drivers/claude.json so the next launch
// shows a picker before the probe has even run.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const shellEnv = require('./shell-path');

const PROBE_TIMEOUT_MS = 4000;
const TTL_MS = 6 * 60 * 60 * 1000;

// The SDK ships its binary in a per-platform package. Inside a packaged app that
// path lands in app.asar, which child_process cannot execute, so look for the
// unpacked copy first. require.resolve is no help: the package's exports map
// hides its internals.
function bundledBinary() {
  let appPath = __dirname;
  try { appPath = require('electron').app.getAppPath(); } catch {}

  const rel = path.join(
    'node_modules', '@anthropic-ai',
    `claude-agent-sdk-${process.platform}-${process.arch}`,
    process.platform === 'win32' ? 'claude.exe' : 'claude',
  );

  const roots = [
    appPath.replace(/app\.asar(?![.\w])/, 'app.asar.unpacked'),
    appPath,
    process.resourcesPath ? path.join(process.resourcesPath, 'app.asar.unpacked') : null,
    path.join(__dirname, '..', '..'),
  ].filter(Boolean);

  for (const root of roots) {
    const candidate = path.join(root, rel);
    try { if (fs.existsSync(candidate)) return candidate; } catch {}
  }
  return null;
}

// A claude the person installed themselves. The bundled copy only moves when the
// app does, so someone who runs `claude` in a terminal every day usually has a
// newer one than the release they are on. Settings can point the agent at it.
function systemBinary() {
  const name = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const bundled = bundledBinary();
  const dirs = (shellEnv.cached() || '').split(path.delimiter);

  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      if (!fs.existsSync(candidate)) continue;
      // Resolve first: a shim in ~/.local/bin that points back into the app is
      // the bundled binary wearing a different name, not a second install.
      const real = fs.realpathSync(candidate);
      if (bundled && real === fs.realpathSync(bundled)) continue;
      return real;
    } catch {}
  }
  return null;
}

// Which binary the agent actually starts. Settings sets this once at boot and
// again whenever the choice changes; null means the bundled one.
let preferred = null;

function preferBinary(p) {
  preferred = p && fs.existsSync(p) ? p : null;
  return preferred;
}

function claudeBinary() {
  if (preferred) {
    try { if (fs.existsSync(preferred)) return preferred; } catch {}
  }
  return bundledBinary();
}

// Models the picker offers, and the CLI version each one needs. A binary older
// than `since` cannot route the slug, so offering it would only produce a send
// that fails. Left open where there is no floor to enforce.
const CATALOG = [
  { value: 'claude-fable-5', displayName: 'Claude Fable 5', since: '2.1.169' },
  { value: 'claude-opus-5', displayName: 'Claude Opus 5', since: '2.1.219' },
  { value: 'claude-sonnet-5', displayName: 'Claude Sonnet 5' },
  { value: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5' },
];

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

const modelsFor = (version) => CATALOG.filter(
  (m) => !m.since || (version && compareVersions(version, m.since) >= 0),
).map(({ value, displayName }) => ({ value, displayName }));

const parseVersion = (out) => out.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] || null;

// `claude --version` and nothing else: it prints a line and exits, so the
// process is gone long before anyone reads the answer.
function probeVersion(bin) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };

    let child;
    try {
      child = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      return finish(null);
    }

    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish(null); }, PROBE_TIMEOUT_MS);
    const read = (s) => s.on('data', (d) => { if (out.length < 4096) out += d; });
    read(child.stdout);
    read(child.stderr);
    child.on('error', () => { clearTimeout(timer); finish(null); });
    child.on('close', (code) => { clearTimeout(timer); finish(code === 0 ? parseVersion(out) : null); });
  });
}

class Driver {
  constructor({ cacheDir }) {
    this.file = path.join(cacheDir, 'drivers', 'claude.json');
    this.snapshot = this.#read() || {
      installed: false, version: null, status: 'unknown',
      models: [], message: 'Checking for the Claude CLI…', checkedAt: null,
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
    return !this.snapshot.checkedAt || Date.now() - this.snapshot.checkedAt > TTL_MS;
  }

  // What the picker gets: whatever is on disk, straight away. A stale entry is
  // refreshed behind the caller rather than made to wait for a spawn.
  current({ refresh = true } = {}) {
    if (refresh && this.stale) this.refresh().catch(() => {});
    return this.snapshot;
  }

  async refresh() {
    if (this.inflight) return this.inflight;
    this.inflight = this.#probe().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async #probe() {
    const bin = claudeBinary();
    const checkedAt = Date.now();

    if (!bin) {
      return this.#write({
        installed: false, version: null, status: 'missing', models: [], checkedAt,
        message: 'The Claude CLI is not installed. Models appear once it is on this machine.',
        binaryPath: null,
      });
    }

    const version = await probeVersion(bin);
    // A list learned from a real session beats anything inferred from a version
    // number, so a later refresh must not overwrite it with guesses.
    const learned = this.snapshot.learned ? this.snapshot.models : null;

    if (!version) {
      return this.#write({
        installed: true, version: null, status: 'error',
        models: learned || modelsFor(null), learned: !!learned, checkedAt,
        message: 'The Claude CLI is installed but did not report a version.',
        binaryPath: bin,
      });
    }

    return this.#write({
      installed: true, version, status: 'ready',
      models: learned || modelsFor(version), learned: !!learned,
      checkedAt, message: null, binaryPath: bin,
    });
  }

  // A live session knows the account's real entitlements, which the catalogue
  // here can only guess at. When one is running, let it correct the cache so the
  // next cold start is closer to the truth.
  learn(models) {
    if (!Array.isArray(models) || !models.length) return;
    const clean = models
      .filter((m) => m && m.value)
      .map((m) => ({ value: m.value, displayName: m.displayName || m.value }));
    if (!clean.length) return;
    this.#write({ ...this.snapshot, models: clean, learned: true, status: 'ready', checkedAt: Date.now() });
  }
}

module.exports = {
  Driver, claudeBinary, bundledBinary, systemBinary, preferBinary,
  modelsFor, compareVersions, parseVersion, probeVersion, CATALOG,
};
