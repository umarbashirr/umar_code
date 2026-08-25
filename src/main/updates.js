'use strict';
// Two questions the settings page asks, and one it asks on launch: is there a
// newer Tandem, and is there a newer Claude CLI than the one the agent runs.
//
// There is no auto-updater here on purpose. Tandem ships as a .deb and an
// AppImage; electron-updater can only replace an AppImage in place, and a .deb
// has to go through the system's package manager either way. So this fetches
// the release, downloads the asset that matches how the app was installed, and
// hands the file to whatever the desktop uses to install packages. The last
// step is the person's, which is also the only step that needs their password.
const fs = require('fs');
const path = require('path');
const https = require('https');
const { EventEmitter } = require('events');

const { DIR } = require('./projects');
const { compareVersions, probeVersion, bundledBinary, systemBinary } = require('./driver');

const CACHE = path.join(DIR, 'update-check.json');
const TTL_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15000;
const CLAUDE_PACKAGE = '@anthropic-ai/claude-code';

// GitHub sends the release JSON from api.github.com and the asset bytes from a
// signed URL on another host, so every request here has to be prepared to be
// told to go somewhere else.
//
// The Accept header is per-host and not a formality: npm answers 406 to
// GitHub's vendor type, which is a silent "no update for you" if it is sent
// everywhere.
function fetchJson(url, { redirects = 5, accept = 'application/json' } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { accept, 'user-agent': 'tandem-update-check' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(fetchJson(new URL(res.headers.location, url).toString(), { redirects: redirects - 1, accept }));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`${res.statusCode} from ${new URL(url).host}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (body.length < 2_000_000) body += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

// owner/repo out of whatever package.json says, so this file has no address of
// its own to go stale.
function repoSlug() {
  let pkg = {};
  try { pkg = require('../../package.json'); } catch {}
  const raw = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url || '';
  const m = String(raw).match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  return m ? `${m[1]}/${m[2]}` : null;
}

// How this copy got onto the machine, which decides both which asset to fetch
// and what to do with it once it is here.
function installKind() {
  if (process.env.APPIMAGE) return 'appimage';
  let packaged = false;
  try { packaged = require('electron').app.isPackaged; } catch {}
  if (!packaged) return 'dev';
  if (process.platform === 'darwin') return 'dmg';
  if (process.platform === 'win32') return 'nsis';
  return 'deb';
}

const EXT = { appimage: '.appimage', deb: '.deb', dmg: '.dmg', nsis: '.exe' };
const ARCH_WORDS = {
  x64: ['x86_64', 'amd64', 'x64'],
  arm64: ['arm64', 'aarch64'],
};

// Releases have been named pba-* and are now named tandem-*, so match on the
// extension and the architecture rather than on whatever the product was called
// the day it was built.
function pickAsset(assets, kind) {
  const ext = EXT[kind];
  if (!ext) return null;
  const candidates = assets.filter((a) => a.name.toLowerCase().endsWith(ext));
  if (candidates.length <= 1) return candidates[0] || null;
  const words = ARCH_WORDS[process.arch] || [process.arch];
  return candidates.find((a) => words.some((w) => a.name.toLowerCase().includes(w))) || candidates[0];
}

const currentVersion = () => {
  try { return require('electron').app.getVersion(); } catch {}
  try { return require('../../package.json').version; } catch { return '0.0.0'; }
};

const readCache = () => { try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return null; } };

function writeCache(data) {
  try {
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify(data, null, 2));
  } catch {}
  return data;
}

class Updates extends EventEmitter {
  // `usingSystem` answers whether the agent is set to run the person's own
  // claude rather than the bundled one. It is a callback because the setting can
  // change under us and the answer decides what counts as out of date.
  constructor({ usingSystem = () => false } = {}) {
    super();
    this.usingSystem = usingSystem;
    this.cache = readCache() || {};
    this.downloading = null;
  }

  get stale() {
    return !this.cache.checkedAt || Date.now() - this.cache.checkedAt > TTL_MS;
  }

  // What the settings page draws on open: the last answer, straight away. A
  // stale one is refreshed behind the caller.
  current({ refresh = true } = {}) {
    if (refresh && this.stale) this.check().catch(() => {});
    return this.snapshot();
  }

  snapshot() {
    return {
      app: this.cache.app || { current: currentVersion(), latest: null, behind: false },
      claude: this.claudeFor(this.usingSystem()),
      kind: installKind(),
      checkedAt: this.cache.checkedAt || null,
      error: this.cache.error || null,
      downloading: this.downloading,
    };
  }

  async check() {
    if (this.inflight) return this.inflight;
    this.inflight = this.#check().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async #check() {
    const [app, claude] = await Promise.all([this.#checkApp(), this.#checkClaude()]);
    this.cache = writeCache({
      app: app.value,
      claude: claude.value,
      checkedAt: Date.now(),
      error: app.error || claude.error || null,
    });
    const snap = this.snapshot();
    this.emit('changed', snap);
    return snap;
  }

  async #checkApp() {
    const current = currentVersion();
    const kind = installKind();
    const slug = repoSlug();
    if (!slug) {
      return { value: { current, latest: null, behind: false }, error: 'No repository is set in package.json.' };
    }

    try {
      const rel = await fetchJson(`https://api.github.com/repos/${slug}/releases/latest`, {
        accept: 'application/vnd.github+json',
      });
      const latest = String(rel.tag_name || '').replace(/^v/, '');
      const asset = pickAsset(rel.assets || [], kind);
      const behind = !!latest && compareVersions(latest, current) > 0;
      return {
        value: {
          current,
          latest: latest || null,
          behind,
          name: rel.name || rel.tag_name || null,
          notes: String(rel.body || '').slice(0, 4000) || null,
          publishedAt: rel.published_at || null,
          page: rel.html_url || null,
          // A release with no asset for this install is still worth reporting;
          // it just cannot be downloaded from here.
          asset: asset ? { name: asset.name, url: asset.browser_download_url, size: asset.size } : null,
        },
        error: null,
      };
    } catch (e) {
      return { value: { current, latest: null, behind: false }, error: `Could not reach GitHub: ${e.message}` };
    }
  }

  // The CLI the agent runs is the one bundled in the app, so a newer release on
  // npm normally means "wait for the next Tandem". The exception is a claude the
  // person installed themselves, which settings can switch to today.
  async #checkClaude() {
    const bundledPath = bundledBinary();
    const systemPath = systemBinary();

    const [bundled, system, latest] = await Promise.all([
      bundledPath ? probeVersion(bundledPath) : null,
      systemPath ? probeVersion(systemPath) : null,
      fetchJson(`https://registry.npmjs.org/${CLAUDE_PACKAGE}/latest`)
        .then((j) => j.version || null)
        .catch(() => null),
    ]);

    // Whether any of this counts as "behind" depends on which binary the agent
    // is set to run, and that setting lives elsewhere. See claudeFor.
    return {
      value: {
        bundled: bundledPath ? { path: bundledPath, version: bundled } : null,
        system: systemPath ? { path: systemPath, version: system } : null,
        latest,
      },
      error: null,
    };
  }

  // The running version depends on the setting, which lives outside this file,
  // so the comparison is finished here rather than baked into the cache.
  claudeFor(usingSystem) {
    const c = this.cache.claude || {};
    const running = (usingSystem ? c.system : c.bundled) || c.bundled || null;
    const canSwitch = !!(c.system?.version && running?.version
      && compareVersions(c.system.version, running.version) > 0);
    const behind = !!(c.latest && running?.version && compareVersions(c.latest, running.version) > 0);
    return { ...c, running, behind, canSwitch };
  }

  // Streams the asset into the downloads folder, reporting progress as it goes.
  // A finished file of the right size is reused rather than pulled again: these
  // are a quarter of a gigabyte.
  async download(onProgress) {
    if (this.downloading) throw new Error('A download is already running.');
    const asset = this.cache.app?.asset;
    if (!asset?.url) throw new Error('This release has no file for how Tandem was installed.');

    const { app } = require('electron');
    const dir = app.getPath('downloads');
    const target = path.join(dir, asset.name);

    try {
      if (fs.statSync(target).size === asset.size) {
        this.downloading = null;
        return { path: target, reused: true };
      }
    } catch {}

    const part = `${target}.part`;
    this.downloading = { name: asset.name, received: 0, total: asset.size, done: false };

    try {
      await pipe(asset.url, part, (received) => {
        this.downloading = { name: asset.name, received, total: asset.size, done: false };
        onProgress?.(this.downloading);
      });
      fs.renameSync(part, target);
      // An AppImage arrives without the bit that lets anyone run it.
      if (installKind() === 'appimage') { try { fs.chmodSync(target, 0o755); } catch {} }
      this.downloading = null;
      onProgress?.({ name: asset.name, received: asset.size, total: asset.size, done: true });
      return { path: target, reused: false };
    } catch (e) {
      try { fs.unlinkSync(part); } catch {}
      this.downloading = null;
      onProgress?.({ name: asset.name, received: 0, total: asset.size, done: true, error: e.message });
      throw e;
    }
  }

  // An AppImage is just a file: showing it in the file manager is more honest
  // than pretending we replaced the running one.
  //
  // A .deb needs root, and Tandem does not have it. Handing the file to the
  // desktop's default handler used to be the polite way to ask for it, but on
  // Ubuntu 24.04 that handler is App Center, which matches the package name,
  // sees the copy you are running, greys out its own button and stops. Every
  // upgrade dead-ended there, which is to say it dead-ended for exactly the
  // people the update flow is for.
  //
  // pkexec puts the same question to polkit instead. The prompt is still the
  // system's and Tandem still never sees the password, but apt-get on the other
  // side of it can actually replace an installed package. Desktops without
  // pkexec keep the old handoff, because it is still better than nothing.
  async install(file) {
    const { shell } = require('electron');
    if (installKind() === 'appimage') {
      shell.showItemInFolder(file);
      return { ok: true, action: 'revealed' };
    }

    const handOff = () => { shell.openPath(file); return { ok: true, action: 'opened' }; };
    if (!which('pkexec')) return handOff();

    const res = await aptInstall(file);
    // 127 is pkexec failing to run at all, which on a desktop usually means no
    // authentication agent is listening. Nothing was asked, so ask the old way.
    if (res.code === 127) return handOff();
    if (res.code === 126) return { error: 'The password prompt was dismissed, so nothing was installed.' };
    if (res.code !== 0) return { error: aptError(res) };
    return { ok: true, action: 'installed' };
  }
}

const which = (cmd) => {
  for (const dir of (process.env.PATH || '').split(':')) {
    if (!dir) continue;
    try { fs.accessSync(path.join(dir, cmd), fs.constants.X_OK); return true; } catch {}
  }
  return false;
};

// apt reads a bare name as a package to fetch, so the file has to arrive as a
// path. It is absolute already; passing it through resolve says so out loud.
function aptInstall(file) {
  const { execFile } = require('child_process');
  return new Promise((resolve) => {
    execFile(
      'pkexec',
      ['apt-get', 'install', '-y', path.resolve(file)],
      { env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' }, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }),
    );
  });
}

// apt says what went wrong on its E: lines and pads the rest with progress.
const aptError = ({ stderr, stdout }) => {
  const lines = `${stderr || ''}\n${stdout || ''}`.split('\n').map((l) => l.trim()).filter(Boolean);
  const said = lines.filter((l) => l.startsWith('E:'));
  return (said.length ? said : lines.slice(-1)).join(' ') || 'The installer failed and said nothing about why.';
};

function pipe(url, dest, onProgress, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': 'tandem-update-check' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(pipe(new URL(res.headers.location, url).toString(), dest, onProgress, redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`${res.statusCode} while downloading`));
      }

      let received = 0;
      let lastReport = 0;
      const out = fs.createWriteStream(dest);
      res.on('data', (chunk) => {
        received += chunk.length;
        // Ten times a second is plenty for a progress bar and keeps a
        // quarter-gigabyte download from flooding the IPC channel.
        const now = Date.now();
        if (now - lastReport > 100) { lastReport = now; onProgress(received); }
      });
      res.pipe(out);
      out.on('error', reject);
      out.on('finish', () => { onProgress(received); resolve(); });
      res.on('error', reject);
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

module.exports = { Updates, installKind, repoSlug, pickAsset, currentVersion };
