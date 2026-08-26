'use strict';
// Local control plane. The agent running inside the terminal reaches the
// preview pane through this: cli/tandem.js and mcp/server.js are both clients.
// One window means one port and one token, but the window can hold several
// projects at once, so every request carries the project it was typed in and
// the bridge hands that along to the window.
const http = require('http');
const crypto = require('crypto');
const path = require('path');

const state = require('../../cli/state');
const { TOOLS, runTool } = require('./tools');

// The same folder can arrive spelled two ways, relative or with a trailing
// slash, and each spelling would earn its own state file. Settle on one form
// here so the set in memory matches the files on disk.
const normalize = (list) => [...new Set((list || []).filter(Boolean).map((c) => path.resolve(c)))];

// Which project is asking. The app's terminals export TANDEM_CWD and the
// clients send it on every request, so a command typed in project B lands in B
// even while another project is the one on screen. A caller from outside the
// app sends nothing and gets null, leaving the window to fall back to whatever
// it is showing.
const callerCwd = (req, url) => {
  const sent = req.headers['x-tandem-cwd'] || url.searchParams.get('cwd');
  return sent ? path.resolve(sent) : null;
};

class Bridge {
  constructor({ getPane, onActivity, captureWindow, showPreview, command, ask, decide, cwd, cwds, focusWindow }) {
    this.focusWindow = focusWindow || null;
    this.cwds = normalize(cwds || [cwd || process.cwd()]);
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
    this.started = null;
  }

  async start() {
    this.server = http.createServer((req, res) => this.#handle(req, res));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    this.port = this.server.address().port;
    this.started = Date.now();
    this.#publish();
    return this.port;
  }

  get url() { return `http://127.0.0.1:${this.port}`; }

  // The project the window opened with. Routes that can only name one path use
  // this, and so does anything written against the old one-folder shape.
  get cwd() { return this.cwds[0] || null; }

  get projects() { return [...this.cwds]; }

  // The whole set at once. The port and the token survive any change to it;
  // what moves is the set of files the CLI looks the window up by. Projects
  // that drop out lose their file, the rest keep theirs untouched.
  setProjects(list) {
    const next = normalize(list);
    const gone = this.cwds.filter((c) => !next.includes(c));
    if (this.state && gone.length) state.clear(this.state, gone);
    this.cwds = next;
    this.#publish();
    return this.projects;
  }

  addProject(cwd) { return this.setProjects([...this.cwds, cwd]); }

  removeProject(cwd) {
    const gone = path.resolve(cwd);
    return this.setProjects(this.cwds.filter((c) => c !== gone));
  }

  env() { return { TANDEM_BRIDGE_URL: this.url, TANDEM_TOKEN: this.token }; }

  stop() {
    try { this.server?.close(); } catch {}
    if (this.state) state.clear(this.state);
  }

  // Nothing is advertised before the port exists, so a project added during
  // construction waits for start() rather than writing a file with no url.
  #publish() {
    if (!this.port) return;
    this.state = { url: this.url, token: this.token, pid: process.pid, cwds: this.cwds, started: this.started };
    state.write(this.state);
  }

  async #handle(req, res) {
    const send = (code, body) => {
      const payload = JSON.stringify(body);
      res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      res.end(payload);
    };

    const url = new URL(req.url, 'http://127.0.0.1');
    const from = callerCwd(req, url);

    // cwd stays alongside projects. It is the first of them, so a client built
    // against the old shape still reads a real path rather than nothing.
    if (url.pathname === '/health') {
      return send(200, { ok: true, cwd: this.cwd, projects: this.projects, tools: Object.keys(TOOLS) });
    }

    if (req.headers['x-tandem-token'] !== this.token) return send(401, { error: 'bad or missing x-tandem-token' });
    // `tandem .` on a folder that already has a window raises that window, and
    // says which folder it meant so the window can bring that project forward.
    if (url.pathname === '/focus') {
      if (!this.focusWindow) return send(404, { error: 'no window' });
      this.focusWindow(from);
      return send(200, { ok: true, cwd: from || this.cwd });
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
      if (arg !== null) return send(200, this.command(name, arg, from));
      return send(200, this.command(name, open === null ? undefined : open === 'true', from));
    }

    // Development aid: push a prompt into the agent panel.
    if (url.pathname === '/debug/decide' && this.decideFn) {
      return send(200, this.decideFn(url.searchParams.get('decision') || 'deny', from));
    }

    if (url.pathname === '/debug/ask' && this.ask) {
      try {
        return send(200, await this.ask(url.searchParams.get('text') || 'hello', from));
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
      const result = await this.#run(name, args, from);
      this.onActivity(name, args, from);
      send(200, { ok: true, result });
    } catch (err) {
      send(500, { ok: false, error: err?.message || String(err) });
    }
  }

  // A project has its own pane, so the tools have to be pointed at the pane of
  // the project that asked before they run.
  async #run(name, a, from) {
    return runTool(name, a, {
      getPane: () => this.getPane(from),
      showPreview: this.showPreview ? (open) => this.showPreview(open, from) : null,
    });
  }
}

module.exports = { Bridge, TOOLS };
