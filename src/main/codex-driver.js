'use strict';
/* What the agent panel knows about codex without holding a session open.
 *
 * The same shape as driver.js and for the same reason: the picker is drawn from
 * a cached file so a cold window has models in it before any probe finishes.
 *
 * One thing is better here than on the claude side. `model/list` is a protocol
 * method, so the list is whatever this account can actually run, with the
 * reasoning efforts each model takes. driver.js has to keep a hand-written
 * CATALOG and gate rows on a CLI version, which is guesswork by comparison.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const shellEnv = require('./shell-env');
const { AppServer } = require('./codex-rpc');

const PROBE_TIMEOUT_MS = 25000;
const TTL_MS = 6 * 60 * 60 * 1000;

// The app-server README asks clients to name themselves on initialize, and it
// is how OpenAI attributes traffic to a client rather than to nobody. The
// version tracks the app's, so a bug report names a build.
const CLIENT = {
  name: 'tandem',
  title: 'Tandem',
  version: (() => {
    try { return require('../../package.json').version; } catch { return '0.0.0'; }
  })(),
};

const EXE = process.platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex.bat'] : ['codex'];

/* PATH only, which means the codex the person installed on purpose.
 *
 * This used to also look inside an installed ChatGPT desktop app, which ships a
 * codex at e.g. /usr/lib/chatgpt/resources/codex and never exports it. That was
 * dropped deliberately. The public CLI is Apache-2.0 and the licence is what
 * makes spawning it plainly fine; the copy in the desktop app ships with no
 * LICENSE and no NOTICE, is branded `codexAppBrand: "chatgpt"`, and reports an
 * alpha version. So the grant cannot be established for it, and OpenAI's terms
 * reach "associated software applications", which that binary is part of.
 *
 * Someone who has only the desktop app can still point settings at that path by
 * hand. The difference matters: reaching into another app's internals by
 * default is Tandem's decision, and typing the path is theirs.
 */
function systemBinary() {
  for (const dir of (shellEnv.cached() || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const name of EXE) {
      const candidate = path.join(dir, name);
      try { if (fs.existsSync(candidate)) return fs.realpathSync(candidate); } catch {}
    }
  }
  return null;
}

// A codex somewhere PATH does not reach. Settings holds the path, and this is
// also the way in for anyone whose only copy is inside the ChatGPT app.
let preferred = null;

function preferBinary(p) {
  preferred = p && typeof p === 'string' && fs.existsSync(p) ? p : null;
  return preferred;
}

function codexBinary() {
  if (preferred) {
    try { if (fs.existsSync(preferred)) return preferred; } catch {}
  }
  return systemBinary();
}

const parseVersion = (out) => out.match(/\b(\d+\.\d+\.\d+[\w.-]*)\b/)?.[1] || null;

function probeVersion(bin) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };

    let child;
    try {
      const viaShell = /\.(cmd|bat)$/i.test(bin);
      child = spawn(viaShell ? `"${bin}"` : bin, ['--version'], {
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

/* Start an app-server, ask it what it serves, shut it down. The spawn is the
   whole cost and it is paid once every six hours, which is the same trade
   driver.js makes to run `claude --version`. */
async function probeModels(bin) {
  const rpc = new AppServer({ bin, cwd: os.homedir() });
  try {
    await rpc.start({ clientInfo: CLIENT });
    const res = await rpc.request('model/list', {}, PROBE_TIMEOUT_MS);
    const rows = Array.isArray(res?.data) ? res.data : [];
    return rows
      .filter((m) => m && (m.id || m.model) && !m.hidden)
      .map((m) => {
        const efforts = (m.supportedReasoningEfforts || [])
          .map((e) => (typeof e === 'string' ? e : e.reasoningEffort))
          .filter(Boolean);
        return {
          value: m.id || m.model,
          displayName: m.displayName || m.id || m.model,
          supportsEffort: efforts.length > 0,
          ...(efforts.length ? { effortLevels: efforts } : {}),
          ...(m.defaultReasoningEffort ? { defaultEffort: m.defaultReasoningEffort } : {}),
        };
      });
  } catch {
    return null;
  } finally {
    rpc.close();
  }
}

class CodexDriver {
  constructor({ cacheDir }) {
    this.file = path.join(cacheDir, 'drivers', 'codex.json');
    this.snapshot = this.#read() || {
      installed: false, version: null, status: 'unknown',
      models: [], message: 'Checking for codex…', checkedAt: null,
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
    // The binary it was written against is gone, so the models on it describe a
    // session that cannot start. Happens when codex is uninstalled, and it
    // happened to everyone whose only copy was inside the ChatGPT app when this
    // stopped looking there. Better an empty picker than six names that fail.
    const bin = codexBinary();
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
    const bin = codexBinary();
    const checkedAt = Date.now();

    if (!bin) {
      return this.#write({
        installed: false, version: null, status: 'missing', models: [], checkedAt,
        message: 'No codex on your PATH. Install the Codex CLI from learn.chatgpt.com/docs/cli and the models appear.',
        binaryPath: null,
      });
    }

    const [version, models] = await Promise.all([probeVersion(bin), probeModels(bin)]);

    if (!models) {
      // The binary is there and would not answer. Nearly always a login: codex
      // keeps its credentials in ~/.codex/auth.json and says nothing useful
      // about their absence until something asks it for a model.
      return this.#write({
        installed: true, version, status: 'error', models: [], checkedAt, binaryPath: bin,
        message: 'codex is installed but did not list any models. Run `codex login` in a terminal.',
      });
    }

    return this.#write({
      installed: true, version, status: 'ready', models, checkedAt, binaryPath: bin, message: null,
    });
  }
}

module.exports = { CodexDriver, codexBinary, systemBinary, preferBinary, probeVersion, probeModels, CLIENT };
