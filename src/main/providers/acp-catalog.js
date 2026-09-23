'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const mcpRegistry = require('../mcp-registry');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { AcpRpc, HANDSHAKE_MS } = require('./acp-rpc');
const { CLIENT } = require('./acp-session');
const shellEnv = require('../shell-env');
const { ANSI } = require('../sniff');

const TTL_MS = 30 * 60 * 1000;
const SESSION_MS = 30000;
// Commands arrive a few seconds after session/new, and Cursor has been seen to
// take fifteen. Past this the probe keeps what it has.
const LISTEN_MS = 25000;
const CLI_MS = 20000;

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};

async function listen({ bin, argv, dir, done }) {
  const rpc = new AcpRpc({ bin, argv, cwd: dir });
  const heard = { commands: null, servers: null, status: new Map(), mcpDone: false };
  let wake = () => {};
  rpc.on('notification', (method, params) => {
    const update = params?.update;
    if (method === 'session/update' && update?.sessionUpdate === 'available_commands_update') {
      heard.commands = update.availableCommands || [];
    } else if (method === '_x.ai/mcp/servers_updated') {
      heard.servers = params.mcpServers || [];
    } else if (method === '_x.ai/mcp/server_status' && params?.name) {
      heard.status.set(params.name, params);
    } else if (method === '_x.ai/mcp_initialized') {
      heard.mcpDone = true;
    }
    if (done(heard)) wake();
  });
  try {
    await rpc.start();
    await rpc.request('initialize', {
      protocolVersion: 1,
      clientInfo: CLIENT,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    }, HANDSHAKE_MS);
    await rpc.request('session/new', { cwd: dir, mcpServers: [] }, SESSION_MS);
    if (!done(heard)) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, LISTEN_MS);
        wake = () => { clearTimeout(timer); resolve(); };
      });
    }
    return heard;
  } finally {
    rpc.close();
  }
}

function run(bin, args, cwd) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(bin, args, { cwd, env: shellEnv.env(), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: -1, out: e.message });
    }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, CLI_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

const targetOf = (s) => s.url || [s.command, ...(s.args || [])].filter(Boolean).join(' ');
const typeOf = (s) => s.type || (s.url ? 'http' : 'stdio');

function grokEntry(c) {
  const meta = c._meta || {};
  // `bundled` is what ships inside Grok, not what a folder ships.
  const scope = meta.pluginName ? 'plugin'
    : meta.scope === 'user' ? 'user'
      : /^(project|repo|local|workspace)$/.test(meta.scope || '') ? 'project'
        : 'builtin';
  return {
    kind: meta.path ? 'skill' : 'command',
    name: c.name,
    description: c.description || '',
    argumentHint: c.input?.hint || '',
    source: scope,
    path: meta.path || '',
    ...(meta.pluginName ? { plugin: meta.pluginName } : {}),
    enabled: true,
  };
}

const CURSOR_TAG = /\s*\(((?:user|project|builtin|plugin|team) skill|global|project)\)\s*$/;

function cursorEntry(c) {
  const desc = String(c.description || '').trim();
  const tag = CURSOR_TAG.exec(desc)?.[1] || '';
  const where = tag.split(' ')[0];
  const source = where === 'global' || where === 'user' ? 'user'
    : where === 'project' ? 'project'
      : where === 'plugin' || where === 'team' ? 'plugin'
        : 'builtin';
  return {
    kind: tag.endsWith('skill') ? 'skill' : 'command',
    name: c.name,
    description: desc.replace(CURSOR_TAG, ''),
    argumentHint: c.input?.hint || '',
    source,
    path: '',
    enabled: true,
  };
}

function grokStatus(s) {
  if (!s) return 'configured';
  const word = `${s.status || ''} ${s.reason || ''}`.toLowerCase();
  if (/auth/.test(word)) return 'needs-auth';
  if (/disabled/.test(word)) return 'disabled';
  if (/connected|ready|available/.test(word) && !/unavailable/.test(word)) return 'connected';
  if (/connecting|starting|pending/.test(word)) return 'pending';
  return 'failed';
}

function cursorStatus(word) {
  const w = String(word || '').toLowerCase();
  if (!w) return 'configured';
  if (/auth/.test(w)) return 'needs-auth';
  if (/disabled|not.approved/.test(w)) return 'disabled';
  if (/ready|connected|loaded|ok/.test(w)) return 'connected';
  if (/connecting|starting|pending/.test(w)) return 'pending';
  if (/error|fail/.test(w)) return 'failed';
  return 'configured';
}

// OpenCode's two built-in commands. Everything else it lists is a skill.
const OPENCODE_COMMANDS = new Set(['init', 'review']);

function opencodeEntry(c, dir) {
  const command = OPENCODE_COMMANDS.has(c.name);
  const inProject = ['.opencode', '.claude', '.agents']
    .some((d) => fs.existsSync(path.join(dir, d, 'skills', c.name)));
  return {
    kind: command ? 'command' : 'skill',
    name: c.name,
    description: c.description || '',
    argumentHint: c.input?.hint || '',
    source: command ? 'builtin' : inProject ? 'project' : 'user',
    path: '',
    enabled: true,
  };
}

// `opencode mcp list` draws each server as a marker line with its name and
// status, then indented lines for the reason it failed, if it did, and the
// command or URL it runs.
function opencodeServers(out) {
  const servers = [];
  for (const raw of out.replace(ANSI, '').split('\n')) {
    const head = /^●\s+\S\s+(\S+)\s+(.+?)\s*$/.exec(raw);
    if (head) { servers.push({ name: head[1], word: head[2], detail: [] }); continue; }
    const more = /^│\s{2,}(\S.*?)\s*$/.exec(raw);
    if (more && servers.length) servers[servers.length - 1].detail.push(more[1]);
  }
  return servers;
}

// JSONC as OpenCode writes it: comments and trailing commas, with strings
// left alone so a URL's // survives.
function readJsonc(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const bare = text
    .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str || '')
    .replace(/("(?:\\.|[^"\\])*")|,(\s*[}\]])/g, (m, str, close) => str || close);
  try { return JSON.parse(bare); } catch { return null; }
}

// OpenCode 1.x keeps servers directly under `mcp`; 2.x moved them to
// `mcp.servers`.
function opencodeMcp(base) {
  const conf = readJsonc(path.join(base, 'opencode.jsonc')) || readJsonc(path.join(base, 'opencode.json'));
  const mcp = conf?.mcp || {};
  return mcp.servers && typeof mcp.servers === 'object' ? mcp.servers : mcp;
}

const SOURCES = {
  grok: {
    entry: grokEntry,
    done: (h) => !!h.commands && (h.mcpDone || h.servers?.length === 0),
    async servers(_bin, _dir, heard) {
      return (heard.servers || []).map((s) => {
        const st = heard.status.get(s.name);
        return {
          name: s.name,
          scope: s.source === 'local' || !s.source ? 'user' : s.source,
          type: typeOf(s),
          target: targetOf(s),
          status: grokStatus(st),
          error: st && grokStatus(st) === 'failed' ? (st.detail || st.reason || null) : null,
          tools: Array.isArray(st?.tools) ? st.tools.length : typeof st?.tools === 'number' ? st.tools : null,
        };
      });
    },
    toggle: (name, on) => ['mcp', on ? 'enable' : 'disable', name],
    login: null,
    addHint: 'grok mcp add',
  },
  cursor: {
    entry: cursorEntry,
    done: (h) => !!h.commands,
    async servers(bin, dir) {
      const files = [
        ['project', path.join(dir, '.cursor', 'mcp.json')],
        ['user', path.join(os.homedir(), '.cursor', 'mcp.json')],
      ];
      const found = new Map();
      for (const [scope, file] of files) {
        for (const [name, s] of Object.entries(readJson(file)?.mcpServers || {})) {
          if (!found.has(name)) found.set(name, { name, scope, type: typeOf(s), target: targetOf(s) });
        }
      }
      if (!found.size) return [];
      const { out } = await run(bin, ['mcp', 'list'], dir);
      const state = new Map();
      for (const line of out.split('\n')) {
        const m = /^\s*([^:\s][^:]*):\s*(.+?)\s*$/.exec(line);
        if (m) state.set(m[1], m[2]);
      }
      return [...found.values()].map((s) => {
        const status = cursorStatus(state.get(s.name));
        return { ...s, status, error: status === 'failed' ? state.get(s.name) : null, tools: null };
      });
    },
    toggle: (name, on) => ['mcp', on ? 'enable' : 'disable', name],
    login: (name) => ['mcp', 'login', name],
    addHint: 'a .cursor/mcp.json',
  },
  opencode: {
    entry: opencodeEntry,
    done: (h) => !!h.commands,
    async servers(bin, dir) {
      const found = new Map();
      for (const [scope, base] of [['project', dir], ['user', path.join(os.homedir(), '.config', 'opencode')]]) {
        for (const [name, s] of Object.entries(opencodeMcp(base))) {
          if (found.has(name)) continue;
          const target = s.url || [].concat(s.command || []).join(' ');
          const off = s.enabled === false;
          found.set(name, { name, scope, type: s.url ? 'http' : 'stdio', target, status: off ? 'disabled' : 'configured', error: null, tools: null });
        }
      }
      const { out } = await run(bin, ['mcp', 'list'], dir);
      for (const { name, word, detail } of opencodeServers(out)) {
        const status = cursorStatus(word);
        const target = detail[detail.length - 1] || '';
        found.set(name, {
          ...(found.get(name) || { name, scope: 'user', type: /^https?:/.test(target) ? 'http' : 'stdio', target, tools: null }),
          status,
          error: status === 'failed' && detail.length > 1 ? detail[0] : null,
        });
      }
      return [...found.values()];
    },
    toggle: null,
    login: (name) => ['mcp', 'auth', name],
    addHint: 'opencode mcp add',
  },
};

async function probe({ id, spec, bin, dir }) {
  const src = SOURCES[id];
  const heard = await listen({ bin, argv: spec.argv || ['acp'], dir, done: src.done });
  const servers = await src.servers(bin, dir, heard);
  return {
    at: Date.now(),
    skills: (heard.commands || []).map((c) => src.entry(c, dir))
      .sort((a, b) => a.name.localeCompare(b.name)),
    mcp: servers.sort((a, b) => a.name.localeCompare(b.name)),
    error: heard.commands ? null : `${spec.cli} did not list its commands in time`,
  };
}

class AcpCatalog extends EventEmitter {
  constructor({ id, spec, cacheDir }) {
    super();
    this.id = id;
    this.spec = spec;
    this.src = SOURCES[id];
    this.file = path.join(cacheDir, 'drivers', `${id}-catalog.json`);
    this.probesByDir = readJson(this.file) || {};
    this.inflightByDir = new Map();
  }

  #save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.probesByDir, null, 2));
    } catch {}
  }

  invalidate(dir) {
    if (dir) delete this.probesByDir[dir]; else this.probesByDir = {};
    this.#save();
  }

  current(dir, { refresh = true } = {}) {
    const snap = this.probesByDir[dir];
    if (refresh && (!snap?.at || Date.now() - snap.at > TTL_MS)) this.refresh(dir).catch(() => {});
    return {
      live: !!snap && !snap.error,
      connectors: true,
      skills: snap?.skills || [],
      agents: [],
      mcp: mcpRegistry.listed((snap?.mcp || []).map((s) => ({
        ...s,
        runtime: s.name,
        enabled: s.status !== 'disabled',
        editable: true,
        removable: false,
      }))),
      error: snap?.error || null,
    };
  }

  async refresh(dir) {
    const running = this.inflightByDir.get(dir);
    if (running) return running;
    const bin = this.spec.binary();
    const run = (bin
      ? probe({ id: this.id, spec: this.spec, bin, dir })
      : Promise.reject(new Error(this.spec.missing)))
      .catch((e) => ({ at: Date.now(), skills: [], mcp: [], error: e.message }))
      .then((snap) => {
        this.probesByDir[dir] = snap;
        this.#save();
        const next = this.current(dir, { refresh: false });
        this.emit('changed', dir, next);
        return next;
      })
      .finally(() => { this.inflightByDir.delete(dir); });
    this.inflightByDir.set(dir, run);
    return run;
  }

  learn() {}

  async setSkill(dir, name) {
    return { ...this.current(dir, { refresh: false }), error: `${this.spec.cli} has no switch for ${name}; skills are turned off where they are installed` };
  }

  async setMcp(dir, name, on) {
    const bin = this.spec.binary();
    const stop = (why) => ({ ...this.current(dir, { refresh: false }), error: why });
    if (!bin) return stop(this.spec.missing);
    if (!this.src.toggle) return stop(`${this.spec.cli} has no switch for ${name}; set "enabled" on it in opencode.json`);
    const { code, out } = await run(bin, this.src.toggle(name, on), dir);
    if (code !== 0) return stop(out.trim() || `${this.spec.cli} could not ${on ? 'enable' : 'disable'} ${name}`);
    return this.refresh(dir);
  }

  setConnectors(dir) {
    return { ...this.current(dir, { refresh: false }), error: `${this.spec.cli} has no account connectors to switch off` };
  }

  addServer() {
    throw new Error(`Add servers with ${this.src.addHint}, then refresh this list.`);
  }

  removeServer() {
    throw new Error(`Remove servers with ${this.spec.cli} mcp, then refresh this list.`);
  }

  mcpLogin(dir, name) {
    if (!this.src.login) return { error: `${this.spec.cli} signs in to ${name} by itself when a chat starts` };
    const quote = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
    return { command: [this.spec.binary() || this.spec.cli, ...this.src.login(name)].map(quote).join(' ') };
  }

  sessionSettings() { return {}; }

  offAtRuntime() { return []; }

  runtimeName(_dir, name) { return name; }
}

module.exports = { AcpCatalog, grokEntry, cursorEntry, opencodeEntry, opencodeServers, opencodeMcp, grokStatus, cursorStatus };
