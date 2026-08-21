'use strict';
// Local control plane. The agent running inside the terminal reaches the
// preview pane through this: cli/pba.js and mcp/server.js are both clients.
const http = require('http');
const crypto = require('crypto');

const state = require('../../cli/state');
const { TOOLS, runTool } = require('./tools');

class Bridge {
  constructor({ getPane, onActivity, captureWindow, showPreview, command, ask, decide, cwd, focusWindow }) {
    this.focusWindow = focusWindow || null;
    this.ask = null;
    this.cwd = cwd || process.cwd();
    this.getPane = getPane;
    this.captureWindow = captureWindow || null;
    this.showPreview = showPreview || null;
    this.command = command || null;
    this.ask = ask || null;
    this.decideFn = decide || null;
    this.onActivity = onActivity || (() => {});
    this.token = crypto.randomBytes(24).toString('hex');
    this.server = null;
    this.port = null;
  }

  async start() {
    this.server = http.createServer((req, res) => this.#handle(req, res));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    this.port = this.server.address().port;
    this.state = { url: this.url, token: this.token, pid: process.pid, cwd: this.cwd, started: Date.now() };
    state.write(this.state);
    return this.port;
  }

  get url() { return `http://127.0.0.1:${this.port}`; }

  // The window switched folders. The port and token survive; the file the CLI
  // looks the window up by has to move with the project.
  setCwd(cwd) {
    if (this.state) state.clear(this.state);
    this.cwd = cwd;
    this.state = { url: this.url, token: this.token, pid: process.pid, cwd, started: Date.now() };
    state.write(this.state);
    return cwd;
  }

  env() { return { PBA_BRIDGE_URL: this.url, PBA_TOKEN: this.token }; }

  stop() {
    try { this.server?.close(); } catch {}
    if (this.state) state.clear(this.state);
  }

  async #handle(req, res) {
    const send = (code, body) => {
      const payload = JSON.stringify(body);
      res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      res.end(payload);
    };

    const url = new URL(req.url, 'http://127.0.0.1');

    if (url.pathname === '/health') return send(200, { ok: true, cwd: this.cwd, tools: Object.keys(TOOLS) });

    if (req.headers['x-pba-token'] !== this.token) return send(401, { error: 'bad or missing x-pba-token' });
    // `pba .` on a folder that already has a window raises that window.
    if (url.pathname === '/focus') {
      if (!this.focusWindow) return send(404, { error: 'no window' });
      this.focusWindow();
      return send(200, { ok: true, cwd: this.cwd });
    }


    // Development aid: capture the app's own chrome, terminal side included.
    if (url.pathname === '/debug/window' && this.captureWindow) {
      const out = await this.captureWindow();
      return send(200, out);
    }

    // Development aid: run one of the window's view commands, the same ones the
    // menu bar and the keyboard go through. This is how the app gets driven
    // while it is being worked on, since its own chrome is not a web page the
    // preview tools can reach.
    if (url.pathname === '/debug/command' && this.command) {
      const name = url.searchParams.get('name');
      if (!name) return send(400, { error: 'name is required' });
      const arg = url.searchParams.get('arg');
      const open = url.searchParams.get('open');
      if (arg !== null) return send(200, this.command(name, arg));
      return send(200, this.command(name, open === null ? undefined : open === 'true'));
    }

    // Development aid: push a prompt into the agent panel.
    if (url.pathname === '/debug/decide' && this.decideFn) {
      return send(200, this.decideFn(url.searchParams.get('decision') || 'deny'));
    }

    if (url.pathname === '/debug/ask' && this.ask) {
      try {
        return send(200, await this.ask(url.searchParams.get('text') || 'hello'));
      } catch (err) {
        return send(500, { error: err?.message || String(err) });
      }
    }

    if (url.pathname === '/tools') {
      return send(200, Object.entries(TOOLS).map(([name, t]) => ({ name, ...t })));
    }

    if (!url.pathname.startsWith('/tool/')) return send(404, { error: 'not found' });
    const name = url.pathname.slice('/tool/'.length);
    if (!TOOLS[name]) return send(404, { error: `unknown tool ${name}`, tools: Object.keys(TOOLS) });

    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 5e6) return send(413, { error: 'body too large' });
    }
    let args = {};
    if (body.trim()) {
      try { args = JSON.parse(body); } catch (e) { return send(400, { error: 'invalid JSON body: ' + e.message }); }
    }

    try {
      const result = await this.#run(name, args);
      this.onActivity(name, args);
      send(200, { ok: true, result });
    } catch (err) {
      send(500, { ok: false, error: err?.message || String(err) });
    }
  }

  async #run(name, a) {
    return runTool(name, a, { getPane: this.getPane, showPreview: this.showPreview });
  }
}

module.exports = { Bridge, TOOLS };
