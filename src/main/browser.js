'use strict';
const { WebContentsView, nativeImage } = require('electron');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { normalizeUrl } = require('./url');

const PAGE_SCRIPT = fs.readFileSync(path.join(__dirname, 'page-script.js'), 'utf8');
const RING = 300;
// In-flight requests only. A page that polls (an HMR socket, a dashboard) would
// otherwise leave one entry here per request for as long as the window is open.
const MAX_INFLIGHT = 500;
// Every screenshot the agent takes lands on disk and nothing ever collected
// them. Keep a working set; the agent only ever looks at the recent ones.
const MAX_SHOTS = 60;

const KEY_ALIASES = {
  enter: 'Return', esc: 'Escape', escape: 'Escape', tab: 'Tab', backspace: 'Backspace',
  delete: 'Delete', up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  pageup: 'PageUp', pagedown: 'PageDown', home: 'Home', end: 'End', space: 'Space',
};

class BrowserPane extends EventEmitter {
  constructor(win, homeUrl) {
    super();
    this.win = win;
    this.console = [];
    this.network = [];
    this.pending = new Set();
    this.reqs = new Map();          // requestId -> the bits needed to log a failure
    this.lastActivity = Date.now();
    this.debuggerAttached = false;
    this.shotDir = path.join(os.tmpdir(), 'tandem-shots');
    fs.mkdirSync(this.shotDir, { recursive: true });
    this.#pruneShots();

    this.view = new WebContentsView({
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
    });
    this.wc = this.view.webContents;
    this.wc.setBackgroundThrottling(false); // it runs parked offscreen when the pane is closed
    win.contentView.addChildView(this.view);
    // Parked offscreen at a real size: the renderer refines this once it has
    // measured, but the page always has a viewport to lay out in.
    this.view.setBounds({ x: 4000, y: 40, width: 900, height: 760 });

    this.#wireEvents();
    this.#attachDebugger();
    if (homeUrl) this.navigate(homeUrl).catch(() => {});
  }

  #wireEvents() {
    const wc = this.wc;
    const push = () => this.emit('state', this.state());

    wc.on('did-start-loading', push);
    wc.on('did-stop-loading', push);
    wc.on('page-title-updated', push);
    wc.on('did-navigate', push);
    wc.on('did-navigate-in-page', push);
    wc.on('did-finish-load', () => { this.#inject(); push(); });
    wc.on('dom-ready', () => this.#inject());
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (isMainFrame && code !== -3) {
        this.network.push({ t: Date.now(), kind: 'navigation-failed', url, code, desc });
        // failedUrl matters: after a failed load getURL() can still report the
        // previous page, and the error card needs the address that broke.
        this.emit('state', { ...this.state(), error: `${desc} (${code})`, failedUrl: url });
      }
    });
    wc.on('console-message', (_e, level, message, line, sourceId) => {
      const levels = ['debug', 'info', 'warning', 'error'];
      this.console.push({ t: Date.now(), level: levels[level] || String(level), message, source: `${sourceId}:${line}` });
      if (this.console.length > RING) this.console.shift();
      this.emit('console', this.console[this.console.length - 1]);
    });
    // Open target=_blank in the same pane rather than a detached window.
    wc.setWindowOpenHandler(({ url }) => {
      this.navigate(url).catch(() => {});
      return { action: 'deny' };
    });
  }

  async #attachDebugger() {
    try {
      this.wc.debugger.attach('1.3');
      this.debuggerAttached = true;
      await this.wc.debugger.sendCommand('Network.enable');
      this.wc.debugger.on('message', (_e, method, params) => this.#onCdp(method, params));
      this.wc.debugger.on('detach', () => { this.debuggerAttached = false; });
    } catch (err) {
      this.debuggerAttached = false;
    }
  }

  #onCdp(method, p) {
    this.lastActivity = Date.now();
    if (method === 'Network.requestWillBeSent') {
      this.pending.add(p.requestId);
      // Chromium does not promise a terminal event for every request: a page
      // torn down mid-flight simply stops reporting. Drop the oldest rather
      // than trust that each entry gets claimed.
      if (this.reqs.size >= MAX_INFLIGHT) {
        const oldest = this.reqs.keys().next().value;
        this.reqs.delete(oldest);
        this.pending.delete(oldest);
      }
      this.reqs.set(p.requestId, { url: p.request.url, method: p.request.method, t: Date.now() });
    } else if (method === 'Network.responseReceived') {
      const r = this.reqs.get(p.requestId);
      if (r) {
        r.status = p.response.status;
        r.type = p.type;
        if (p.response.status >= 400) {
          this.network.push({ t: Date.now(), kind: 'http', ...r });
          if (this.network.length > RING) this.network.shift();
        }
      }
    } else if (method === 'Network.loadingFailed') {
      const r = this.reqs.get(p.requestId) || {};
      this.reqs.delete(p.requestId);
      this.pending.delete(p.requestId);
      if (!p.canceled) {
        this.network.push({ t: Date.now(), kind: 'failed', url: r.url, method: r.method, error: p.errorText });
        if (this.network.length > RING) this.network.shift();
      }
    } else if (method === 'Network.loadingFinished') {
      this.reqs.delete(p.requestId);
      this.pending.delete(p.requestId);
    }
  }

  async #inject() {
    try { await this.wc.executeJavaScript(PAGE_SCRIPT, true); } catch { /* page may be gone */ }
  }

  // executeJavaScript reports every throw as "Script failed to execute", which
  // tells the agent nothing. Catch inside the page and carry the message out.
  async #js(expr) {
    await this.#inject();
    const wrapped = `(async () => { try { return { v: await (${expr}) }; } catch (e) { return { e: String(e && e.message || e) }; } })()`;
    const r = await this.wc.executeJavaScript(wrapped, true);
    if (r && r.e) throw new Error(r.e);
    return r ? r.v : r;
  }

  setBounds(b) {
    this.bounds = b;
    this.view.setBounds({
      x: Math.round(b.x), y: Math.round(b.y),
      width: Math.max(0, Math.round(b.width)), height: Math.max(0, Math.round(b.height)),
    });
  }

  setVisible(v) { this.view.setVisible(v); }

  // A still of the page, for the shell to paint in the pane's place while the
  // real view is hidden. Nothing lands on disk: this is thrown away seconds
  // later, and screenshot() is the one that keeps a file.
  async still() {
    try {
      const img = await this.wc.capturePage();
      return img.isEmpty() ? null : img.toDataURL();
    } catch {
      return null;
    }
  }

  state() {
    return {
      url: this.wc.getURL(),
      title: this.wc.getTitle(),
      loading: this.wc.isLoading(),
      canGoBack: this.wc.navigationHistory.canGoBack(),
      canGoForward: this.wc.navigationHistory.canGoForward(),
    };
  }

  // --- agent-facing tools -------------------------------------------------

  async navigate(url, { timeout = 30000 } = {}) {
    const target = normalizeUrl(url);
    const done = new Promise((res) => {
      const finish = () => { clearTimeout(t); cleanup(); res(); };
      const fail = (_e, code, desc) => { clearTimeout(t); cleanup(); res({ error: `${desc} (${code})` }); };
      const cleanup = () => {
        this.wc.off('did-finish-load', finish);
        this.wc.off('did-fail-load', fail);
      };
      const t = setTimeout(() => { cleanup(); res({ warning: 'load timed out, returning current state' }); }, timeout);
      this.wc.once('did-finish-load', finish);
      this.wc.once('did-fail-load', fail);
    });
    this.console.length = 0;
    this.network.length = 0;
    // These describe the page being left. waitFor({networkIdle}) reads
    // pending.size, so a stale entry here hangs the next wait to its timeout.
    this.reqs.clear();
    this.pending.clear();
    let loadError = null;
    await this.wc.loadURL(target).catch((e) => { loadError = e.message; });
    const r = await done;
    await this.#inject();
    return { ...this.state(), requested: target, ...(loadError ? { error: loadError } : {}), ...(r || {}) };
  }

  async back() {
    if (!this.wc.navigationHistory.canGoBack()) return { ...this.state(), note: 'no earlier entry in history' };
    this.wc.navigationHistory.goBack();
    await settle(this.wc);
    return this.state();
  }
  async forward() {
    if (!this.wc.navigationHistory.canGoForward()) return { ...this.state(), note: 'no later entry in history' };
    this.wc.navigationHistory.goForward();
    await settle(this.wc);
    return this.state();
  }
  async reload() { this.wc.reload(); await settle(this.wc); return this.state(); }

  async snapshot(opts = {}) {
    return this.#js(`window.__tandem.snapshot(${JSON.stringify(opts)})`);
  }

  async text(max) { return this.#js(`window.__tandem.text(${Number(max) || 20000})`); }

  async html(max = 200000) {
    const h = await this.#js('document.documentElement.outerHTML');
    return h.length > max ? h.slice(0, max) + '\n<!-- truncated -->' : h;
  }

  async click(target, { button = 'left', clickCount = 1, modifiers = [] } = {}) {
    const p = await this.#js(`window.__tandem.point(${JSON.stringify(target)}, "click")`);
    const base = { x: Math.round(p.x), y: Math.round(p.y), button, modifiers };
    this.wc.sendInputEvent({ type: 'mouseMove', ...base });
    this.wc.sendInputEvent({ type: 'mouseDown', ...base, clickCount });
    this.wc.sendInputEvent({ type: 'mouseUp', ...base, clickCount });
    await sleep(120);
    return { ok: true, clicked: target, at: base };
  }

  async hover(target) {
    const p = await this.#js(`window.__tandem.point(${JSON.stringify(target)}, "move")`);
    this.wc.sendInputEvent({ type: 'mouseMove', x: Math.round(p.x), y: Math.round(p.y) });
    await sleep(80);
    return { ok: true };
  }

  async fill(target, value) { return this.#js(`window.__tandem.fill(${JSON.stringify(target)}, ${JSON.stringify(value)})`); }
  async select(target, value) { return this.#js(`window.__tandem.select(${JSON.stringify(target)}, ${JSON.stringify(value)})`); }

  async type(text, { target, delay = 12 } = {}) {
    if (target) await this.#js(`window.__tandem.focus(${JSON.stringify(target)})`);
    for (const ch of String(text)) {
      this.wc.sendInputEvent({ type: 'char', keyCode: ch });
      if (delay) await sleep(delay);
    }
    return { ok: true, typed: text.length };
  }

  async press(key, { modifiers = [] } = {}) {
    const parts = String(key).split('+');
    const raw = parts.pop();
    const mods = [...modifiers, ...parts.map((m) => m.toLowerCase().replace('cmd', 'meta').replace('ctrl', 'control'))];
    const keyCode = KEY_ALIASES[raw.toLowerCase()] || raw;
    this.wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers: mods });
    // Chromium only runs the default action (implicit form submit, text entry)
    // when a char event follows the keydown.
    if (keyCode.length === 1) this.wc.sendInputEvent({ type: 'char', keyCode, modifiers: mods });
    else if (keyCode === 'Return') this.wc.sendInputEvent({ type: 'char', keyCode: '\r', modifiers: mods });
    else if (keyCode === 'Tab') this.wc.sendInputEvent({ type: 'char', keyCode: '\t', modifiers: mods });
    this.wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers: mods });
    await sleep(80);
    return { ok: true, key: `${mods.join('+')}${mods.length ? '+' : ''}${keyCode}` };
  }

  async scroll(dy = 400, dx = 0) { return this.#js(`window.__tandem.scroll(${Number(dy)}, ${Number(dx)})`); }
  async scrollTo(target) { return this.#js(`window.__tandem.scrollTo(${JSON.stringify(target)})`); }
  async highlight(target) { return this.#js(`window.__tandem.highlight(${JSON.stringify(target)})`); }

  async pick() {
    this.wc.focus(); // the human is about to move the mouse over the pane
    return this.#js('window.__tandem.pick()');
  }

  async evaluate(code) {
    const wrapped = `(async () => { ${/return|=>|;/.test(code) ? code : `return (${code})`} })()`;
    const value = await this.wc.executeJavaScript(wrapped, true);
    return value === undefined ? null : value;
  }

  async waitFor({ selector, ms, networkIdle, timeout = 10000 } = {}) {
    if (ms) { await sleep(ms); return { ok: true, waited: ms }; }
    if (selector) { await this.#js(`window.__tandem.waitFor(${JSON.stringify(selector)}, ${timeout})`); return { ok: true, selector }; }
    if (networkIdle !== false) {
      const started = Date.now();
      let quietSince = Date.now();
      while (Date.now() - started < timeout) {
        if (this.pending.size === 0 && !this.wc.isLoading()) {
          if (Date.now() - quietSince > 500) return { ok: true, idle: true };
        } else quietSince = Date.now();
        await sleep(100);
      }
      return { ok: true, idle: false, note: 'timed out waiting for network idle' };
    }
    return { ok: true };
  }

  async screenshot({ fullPage = false, target, name } = {}) {
    // The pointer the last action left on the page is for the human watching
    // the pane, not for whoever reads this file.
    await this.#js('window.__tandem.cursorHide()').catch(() => {});
    let image;
    if (target) {
      const p = await this.#js(`window.__tandem.point(${JSON.stringify(target)})`);
      const r = p.rect;
      image = await this.wc.capturePage({
        x: Math.max(0, Math.round(r.x)), y: Math.max(0, Math.round(r.y)),
        width: Math.round(r.w), height: Math.round(r.h),
      });
    } else if (fullPage && this.debuggerAttached) {
      const metrics = await this.wc.debugger.sendCommand('Page.getLayoutMetrics');
      const cs = metrics.cssContentSize || metrics.contentSize;
      const res = await this.wc.debugger.sendCommand('Page.captureScreenshot', {
        format: 'png', captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: cs.width, height: Math.min(cs.height, 20000), scale: 1 },
      });
      image = nativeImage.createFromBuffer(Buffer.from(res.data, 'base64'));
    } else {
      image = await this.wc.capturePage();
    }
    const file = path.join(this.shotDir, `${name || 'shot-' + Date.now()}.png`);
    fs.writeFileSync(file, image.toPNG());
    this.#pruneShots();
    const size = image.getSize();
    return { path: file, width: size.width, height: size.height };
  }

  // Oldest first, by mtime. Cheap enough to run after each capture: the cap is
  // small and readdir on a flat temp folder is not worth scheduling around.
  #pruneShots() {
    try {
      const files = fs.readdirSync(this.shotDir)
        .filter((f) => f.endsWith('.png'))
        .map((f) => {
          const full = path.join(this.shotDir, f);
          try { return { full, at: fs.statSync(full).mtimeMs }; } catch { return null; }
        })
        .filter(Boolean);
      if (files.length <= MAX_SHOTS) return;
      files.sort((a, b) => a.at - b.at);
      for (const { full } of files.slice(0, files.length - MAX_SHOTS)) {
        try { fs.unlinkSync(full); } catch {}
      }
    } catch {}
  }

  async setViewport(width, height) {
    if (!this.debuggerAttached) return { error: 'debugger not attached' };
    await this.wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: Math.round(width), height: Math.round(height), deviceScaleFactor: 0, mobile: false,
    });
    return { ok: true, width, height };
  }

  async clearViewport() {
    if (!this.debuggerAttached) return { ok: true };
    await this.wc.debugger.sendCommand('Emulation.clearDeviceMetricsOverride');
    return { ok: true };
  }

  consoleLog({ level, limit = 50 } = {}) {
    let list = this.console;
    if (level) list = list.filter((c) => c.level === level);
    return list.slice(-limit);
  }

  networkLog({ limit = 50 } = {}) { return this.network.slice(-limit); }

  toggleDevTools() {
    if (this.wc.isDevToolsOpened()) {
      this.wc.closeDevTools();
      if (!this.debuggerAttached) this.#attachDebugger();
    } else {
      if (this.debuggerAttached) { try { this.wc.debugger.detach(); } catch {} this.debuggerAttached = false; }
      this.wc.openDevTools({ mode: 'bottom' });
    }
    return { open: this.wc.isDevToolsOpened() };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = (wc) => new Promise((res) => {
  const t = setTimeout(res, 8000);
  wc.once('did-stop-loading', () => { clearTimeout(t); res(); });
});

module.exports = { BrowserPane, normalizeUrl };
