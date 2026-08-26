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
const shellEnv = require('./shell-env');

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
//
// Sonnet leads because the order here decides what forgetModel() falls back to,
// and every paid plan can run Sonnet. Fable and Opus are gated on the account,
// not on the CLI, and nothing on this machine can see which plan someone is on.
const CATALOG = [
  { value: 'claude-sonnet-5', displayName: 'Claude Sonnet 5' },
  { value: 'claude-opus-5', displayName: 'Claude Opus 5', since: '2.1.219' },
  { value: 'claude-fable-5', displayName: 'Claude Fable 5', since: '2.1.169' },
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
      child = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], env: shellEnv.env() });
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

// Which endpoint the models belong to. A proxy hands out access per key, so two
// keys pointed at the same LiteLLM install can serve different lists and the
// same cache file must not answer for both.
const endpoint = () => shellEnv.baseUrl() || 'anthropic';

// Ask a custom endpoint what it serves. LiteLLM and every other OpenAI- or
// Anthropic-shaped proxy answers /v1/models scoped to the key presenting it,
// which is the only honest source for what this person can actually run. The
// header goes on twice because the two shapes disagree about which one to read.
async function probeModels(base, token) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const headers = { 'anthropic-version': '2023-06-01' };
    if (token) { headers['x-api-key'] = token; headers.authorization = `Bearer ${token}`; }
    const res = await fetch(`${base}/v1/models`, { headers, signal: ctrl.signal });
    if (!res.ok) return null;
    const body = await res.json();
    const data = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : null;
    if (!data) return null;
    const list = data
      .map((m) => (typeof m === 'string' ? { value: m, displayName: m } : {
        value: m.id || m.name || m.value,
        displayName: m.display_name || m.displayName || m.id || m.name || m.value,
      }))
      .filter((m) => m.value);
    return list.length ? list : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// `default` is not a model. The CLI lists it as one, resolves it to whatever
// the account happens to default to, and it arrives first, so the picker shows
// it at the top of the list reading as a real choice. Picking it sends
// --model default and the account decides, which is the one thing this picker
// exists to stop. Drop it and let the models it stands for speak for
// themselves. Applied on the way out too, so a cache written before this still
// cannot serve it.
const ALIAS = 'default';
const pickable = (models) => (models || []).filter((m) => m && m.value && m.value !== ALIAS);

// The list the picker shows: what the endpoint or the CLI reported, plus any
// name the user typed in by hand for this endpoint, minus the duplicates.
function withCustom(models, custom) {
  const seen = new Set(models.map((m) => m.value));
  return [...models, ...custom.filter((v) => !seen.has(v)).map((v) => ({ value: v, displayName: v, custom: true }))];
}

class Driver {
  constructor({ cacheDir }) {
    this.file = path.join(cacheDir, 'drivers', 'claude.json');
    this.snapshot = this.#read() || {
      installed: false, version: null, status: 'unknown',
      models: [], message: 'Checking for the Claude CLI…', checkedAt: null,
      endpoint: endpoint(),
    };
    this.inflight = null;
  }

  #read() {
    try {
      const snap = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      // Every cache written before endpoints were a thing was written against
      // Anthropic's own. Saying so keeps an upgrade from throwing away a list a
      // real session had already learned.
      if (snap && !snap.endpoint) snap.endpoint = 'anthropic';
      return snap;
    } catch { return null; }
  }

  #write(snapshot) {
    // Names typed by hand outlive every probe, and belong to the endpoint they
    // were typed against, so they ride along rather than being rewritten.
    this.snapshot = { ...snapshot, custom: snapshot.custom || this.snapshot?.custom || {} };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.snapshot, null, 2));
    } catch {}
    return this.snapshot;
  }

  get stale() {
    if (!this.snapshot.checkedAt) return true;
    if (this.snapshot.endpoint !== endpoint()) return true;
    return Date.now() - this.snapshot.checkedAt > TTL_MS;
  }

  // Whatever this endpoint had last time, plus anything typed by hand for it.
  #custom(ep = endpoint()) {
    const list = this.snapshot.custom?.[ep];
    return Array.isArray(list) ? list : [];
  }

  // What the picker gets: whatever is on disk, straight away. A stale entry is
  // refreshed behind the caller rather than made to wait for a spawn.
  current({ refresh = true } = {}) {
    if (refresh && this.stale) this.refresh().catch(() => {});
    const ep = endpoint();
    // A list cached against a different endpoint describes a different key's
    // access. Better to show only what was typed for this one and wait for the
    // refresh above than to offer models this key cannot run.
    if (this.snapshot.endpoint !== ep) {
      return {
        ...this.snapshot, endpoint: ep, models: withCustom([], this.#custom(ep)),
        message: ep === 'anthropic'
          ? 'Checking which models are available…'
          : `Checking which models ${ep} serves…`,
      };
    }
    return { ...this.snapshot, models: withCustom(pickable(this.snapshot.models), this.#custom(ep)) };
  }

  // Answers with what the picker should show, hand-typed names included, since
  // the panel is handed this result directly as well as through current().
  async refresh() {
    if (this.inflight) return this.inflight;
    this.inflight = this.#probe()
      .then(() => this.current({ refresh: false }))
      .finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async #probe() {
    const bin = claudeBinary();
    const ep = endpoint();
    const checkedAt = Date.now();

    if (!bin) {
      return this.#write({
        installed: false, version: null, status: 'missing',
        models: [], checkedAt, endpoint: ep,
        message: 'The Claude CLI is not installed. Models appear once it is on this machine.',
        binaryPath: null,
      });
    }

    const version = await probeVersion(bin);
    // A list learned from a real session beats anything inferred from a version
    // number, so a later refresh must not overwrite it with guesses. It only
    // counts for the endpoint it was learned against.
    const learned = this.snapshot.learned && this.snapshot.endpoint === ep ? this.snapshot.models : null;

    // A proxy decides what this key may run, and the version floors below are
    // about Anthropic's own API, so they say nothing here. Ask the endpoint.
    if (ep !== 'anthropic') {
      const served = await probeModels(ep, shellEnv.authToken());
      const models = served || learned || [];
      return this.#write({
        installed: true, version, status: 'ready',
        models, learned: !served && !!learned,
        served: !!served, checkedAt, endpoint: ep, binaryPath: bin,
        message: models.length ? null
          : `${ep} did not say which models it serves. Type the name your proxy expects.`,
      });
    }

    if (!version) {
      return this.#write({
        installed: true, version: null, status: 'error',
        models: learned || modelsFor(null), learned: !!learned,
        served: false, checkedAt, endpoint: ep,
        message: 'The Claude CLI is installed but did not report a version.',
        binaryPath: bin,
      });
    }

    return this.#write({
      installed: true, version, status: 'ready',
      models: learned || modelsFor(version), learned: !!learned,
      served: false, checkedAt, endpoint: ep, message: null, binaryPath: bin,
    });
  }

  // A live session knows the account's real entitlements, which the catalogue
  // here can only guess at. When one is running, let it correct the cache so the
  // next cold start is closer to the truth.
  learn(models) {
    if (!Array.isArray(models) || !models.length) return;
    const ep = endpoint();
    // A proxy already told us what it serves, and it knows better than the CLI,
    // which lists what Anthropic offers rather than what this key can reach.
    if (ep !== 'anthropic' && this.snapshot.served && this.snapshot.endpoint === ep) return;
    const clean = pickable(models)
      .map((m) => ({ value: m.value, displayName: m.displayName || m.value }));
    if (!clean.length) return;
    this.#write({
      ...this.snapshot, models: clean, learned: true, served: false,
      status: 'ready', endpoint: ep, checkedAt: Date.now(),
    });
  }

  // A name the user typed because no probe offered it. Kept per endpoint, so
  // the one their proxy routes does not follow them to another one.
  remember(model) {
    const value = String(model || '').trim();
    if (!value) return this.current();
    const ep = endpoint();
    const custom = { ...(this.snapshot.custom || {}) };
    const known = (this.snapshot.endpoint === ep ? this.snapshot.models || [] : []).some((m) => m.value === value);
    if (!known && !this.#custom(ep).includes(value)) {
      custom[ep] = [...this.#custom(ep), value];
      this.#write({ ...this.snapshot, custom });
    }
    return this.current({ refresh: false });
  }

  forget(model) {
    const ep = endpoint();
    if (!this.#custom(ep).includes(model)) return this.current({ refresh: false });
    const custom = { ...(this.snapshot.custom || {}), [ep]: this.#custom(ep).filter((v) => v !== model) };
    this.#write({ ...this.snapshot, custom });
    return this.current({ refresh: false });
  }
}

module.exports = {
  Driver, claudeBinary, bundledBinary, systemBinary, preferBinary,
  modelsFor, compareVersions, parseVersion, probeVersion, probeModels,
  endpoint, CATALOG,
};
