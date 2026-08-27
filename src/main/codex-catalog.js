'use strict';
// What the panel knows about codex's skills and MCP servers.
//
// catalog.js answers this for claude by reading files, because a skill is a
// folder with a SKILL.md in it and a server is a JSON entry, and neither needs
// the CLI. codex is the other way round. Its skills arrive from plugin caches,
// a bundled system set and the repo at once, and its servers are named in
// config.toml but their tools and their sign-in state are known only to the
// process. So the source here is codex itself, over the app-server protocol,
// and the price is a spawn.
//
// That price is why nothing is read on demand. A folder is probed once, the
// answer is kept beside the driver's model cache, and a cold window draws that
// while the refresh runs behind it and arrives as a `changed` event.
//
// What codex answers, and the method that answers it:
//   skills/list              every skill for a cwd, with scope, plugin, enabled
//   skills/config/write      turns one on or off, and it sticks across sessions
//   mcpServerStatus/list     every server, its tools and its sign-in state
//   config/value/write       adds, removes or disables a server in config.toml
//   config/mcpServer/reload  makes the running server pick that up
//
// There is no method for slash commands and none for subagents, in this version
// or the one before it. Those lists come back empty rather than guessed at.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { AppServer } = require('./codex-rpc');
const { codexBinary, CLIENT } = require('./codex-driver');

const HOME = os.homedir();
// Long, because every refresh is a process. The panel's own refresh button and
// every toggle go straight past this, so the only thing it delays is noticing a
// SKILL.md someone added in another window.
const TTL_MS = 5 * 60 * 1000;
const ASK_MS = 30000;

// codex scopes are not the panel's. The dialog groups skills under claude's
// names, so repo is what a folder ships, system and admin are what the install
// ships, and anything that names a plugin came from one whatever its scope says.
const SOURCE = { repo: 'project', user: 'user', system: 'builtin', admin: 'builtin' };

// A server's connection as a thread sees it, in the words the panel colours by.
const RUNTIME = {
  notStarted: 'configured',
  starting: 'pending',
  connected: 'connected',
  authenticationRequired: 'needs-auth',
  failed: 'failed',
  cancelled: 'absent',
  disabled: 'disabled',
};

// The same thing again for the startup notification a live session hears, which
// has four states rather than seven.
const STARTUP = { starting: 'pending', ready: 'connected', failed: 'failed', cancelled: 'absent' };

// A dotted key path is TOML, so a name that is not a bare key would have to be
// quoted inside it, and codex has never been asked here whether it accepts that.
const BARE_KEY = /^[A-Za-z0-9_-]+$/;

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};

const codexHome = () => process.env.CODEX_HOME || path.join(HOME, '.codex');

const unquote = (v) => {
  const s = v.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
};

/* Enough TOML to answer two questions the protocol does not: how a server is
 * reached, and whether this app is allowed to edit it.
 *
 * A parser would be a dependency this app does not have, for a file whose only
 * interesting shape is `[mcp_servers.<name>]` and four keys under it. Anything
 * deeper, `[mcp_servers.x.env]` included, is a section header this stops at,
 * which is right: those keys belong to the sub-table, not to the server.
 */
function configuredServers(home) {
  const out = new Map();
  let text = '';
  try { text = fs.readFileSync(path.join(home, 'config.toml'), 'utf8'); } catch { return out; }

  let at = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      const m = /^mcp_servers\.("[^"]+"|'[^']+'|[^.\s]+)$/.exec(header[1]);
      at = m ? unquote(m[1]) : null;
      if (at && !out.has(at)) out.set(at, { name: at });
      continue;
    }
    if (!at || line.startsWith('#')) continue;
    const kv = /^([A-Za-z_][\w-]*)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const [, key, value] = kv;
    if (key === 'enabled') out.get(at).enabled = value.trim() !== 'false';
    else if (key === 'command' || key === 'url') out.get(at)[key] = unquote(value);
    else if (key === 'args') {
      out.get(at).args = (value.match(/"[^"]*"|'[^']*'/g) || []).map(unquote);
    }
  }
  return out;
}

/* One connection per question, closed as soon as it is answered.
 *
 * Holding one open per folder would be cheaper per call and would also mean an
 * idle codex process sitting there for a panel most people open twice a week.
 * A live chat has its own app-server, but it belongs to that chat: borrowing it
 * would put a config write on the same pipe as a turn in flight.
 */
async function connect(cwd, fn) {
  const bin = codexBinary();
  if (!bin) throw new Error('No codex on your PATH, so there is nothing to ask.');
  const rpc = new AppServer({ bin, cwd });
  try {
    const init = await rpc.start({ clientInfo: CLIENT });
    return await fn(rpc, init || {});
  } finally {
    rpc.close();
  }
}

// Only what the panel draws, because the full answer is not worth keeping: one
// server here reports 334 tool schemas and that is a megabyte of JSON to write
// to disk for a number in a column.
function digest(server) {
  return {
    name: server.name,
    tools: Object.keys(server.tools || {}).length,
    auth: server.authStatus || 'unknown',
    runtime: server.runtimeStatus || null,
    plugin: server.pluginId || null,
    info: server.serverInfo ? { name: server.serverInfo.name, version: server.serverInfo.version } : null,
  };
}

async function probe(dir) {
  return connect(dir, async (rpc, init) => {
    const [skills, mcp] = await Promise.all([
      // The cwd is the whole point: repo skills are the ones this folder ships,
      // and codex resolves them per directory rather than per session.
      rpc.request('skills/list', { cwds: [dir] }, ASK_MS),
      // toolsAndAuthOnly rather than full: the panel counts tools and shows
      // whether a server wants signing in, and full adds every resource and
      // resource template on top of that.
      rpc.request('mcpServerStatus/list', { detail: 'toolsAndAuthOnly' }, ASK_MS),
    ]);

    const rows = (skills?.data || []).flatMap((e) => e.skills || []);
    return {
      at: Date.now(),
      codexHome: init.codexHome || codexHome(),
      skills: rows
        .map((s) => ({
          name: s.name,
          description: s.description || '',
          scope: s.scope || 'user',
          plugin: s.pluginId || null,
          path: s.path || '',
          enabled: s.enabled !== false,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      // Every entry codex refused to read, so a broken SKILL.md is visible
      // rather than silently one fewer skill than the folder has.
      errors: (skills?.data || []).flatMap((e) => e.errors || []),
      mcp: (mcp?.data || []).map(digest),
      error: null,
    };
  });
}

function statusOf(now) {
  if (!now) return 'absent';
  if (now.runtime) return RUNTIME[now.runtime] || 'configured';
  if (now.auth === 'notLoggedIn') return 'needs-auth';
  // Outside a thread codex reports no connection state, but it only knows a
  // server's tools because it reached it and asked.
  return now.tools > 0 ? 'connected' : 'configured';
}

class CodexCatalog extends EventEmitter {
  constructor({ cacheDir }) {
    super();
    this.file = path.join(cacheDir, 'drivers', 'codex-catalog.json');
    this.cache = readJson(this.file) || {};   // project dir -> probe result
    this.live = new Map();                    // project dir -> name -> { status, error }
    this.inflight = new Map();                // project dir -> promise
  }

  #save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.cache, null, 2));
    } catch {}
  }

  #stale(snap) {
    if (!snap?.at) return true;
    return Date.now() - snap.at > TTL_MS;
  }

  invalidate(dir) {
    if (dir) delete this.cache[dir]; else this.cache = {};
    this.#save();
  }

  #servers(dir) {
    const snap = this.cache[dir];
    const configured = configuredServers(snap?.codexHome || codexHome());
    const reported = new Map((snap?.mcp || []).map((s) => [s.name, s]));
    const said = this.live.get(dir) || new Map();

    return [...new Set([...configured.keys(), ...reported.keys()])].map((name) => {
      const cfg = configured.get(name);
      const now = reported.get(name);
      const heard = said.get(name);
      const enabled = cfg ? cfg.enabled !== false : true;
      const target = cfg?.url
        || (cfg?.command ? [cfg.command, ...(cfg.args || [])].join(' ') : '')
        || (now?.info ? `${now.info.name} ${now.info.version}, started by codex itself` : '');

      return {
        name,
        // codex knows every server by the name in the file, prefix and all, so
        // there is no second name for the panel to translate to.
        runtime: name,
        scope: cfg ? 'user' : now?.plugin ? 'plugin' : 'session',
        ...(now?.plugin ? { plugin: now.plugin } : {}),
        type: cfg?.url ? 'http' : cfg?.command ? 'stdio' : 'in process',
        target,
        enabled,
        // A server codex was handed by a plugin is not in a file this app is
        // entitled to rewrite, so the switch and the bin are off for it.
        editable: !!cfg,
        removable: !!cfg,
        status: !enabled ? 'disabled' : heard?.status || statusOf(now),
        error: heard?.error || null,
        tools: now?.tools ?? null,
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  // The listing the panel draws, from the last probe. A stale one is refreshed
  // behind the caller and lands as `changed`.
  current(dir, { refresh = true } = {}) {
    const snap = this.cache[dir];
    if (refresh && this.#stale(snap)) this.refresh(dir).catch(() => {});

    return {
      // codex answered, so the statuses are its own rather than a guess from a
      // config file. That is what the panel means by live.
      live: !!snap && !snap.error,
      // There is no ChatGPT account connector set for codex to fetch, so
      // nothing here is being held back. setConnectors says the same out loud.
      connectors: true,
      skills: (snap?.skills || []).map((s) => ({
        kind: 'skill',
        name: s.name,
        description: s.description,
        argumentHint: '',
        source: s.plugin ? 'plugin' : SOURCE[s.scope] || 'user',
        path: s.path,
        ...(s.plugin ? { plugin: s.plugin } : {}),
        enabled: s.enabled,
      })),
      // codex has no subagent definitions to list, the way .claude/agents is a
      // list. An empty tab beats a tab of things it will never run.
      agents: [],
      mcp: this.#servers(dir),
      error: snap?.error || null,
    };
  }

  async refresh(dir) {
    const running = this.inflight.get(dir);
    if (running) return running;

    const run = probe(dir)
      .catch((e) => ({ at: Date.now(), codexHome: codexHome(), skills: [], errors: [], mcp: [], error: e.message }))
      .then((snap) => {
        this.cache[dir] = snap;
        this.#save();
        const next = this.current(dir, { refresh: false });
        this.emit('changed', dir, next);
        return next;
      })
      .finally(() => { this.inflight.delete(dir); });

    this.inflight.set(dir, run);
    return run;
  }

  /* What a running chat heard while it was up. codex sends
     mcpServer/startupStatus/updated per server as a thread starts, which is the
     only place a connection failure is reported with its reason. Commands are
     taken for the same call signature catalog.js has and dropped: codex has no
     command list to learn. */
  learn(dir, { mcp } = {}) {
    if (!mcp?.length) return;
    const said = this.live.get(dir) || new Map();
    for (const s of mcp) {
      if (!s?.name) continue;
      said.set(s.name, { status: STARTUP[s.status] || s.status || null, error: s.error || null });
    }
    this.live.set(dir, said);
  }

  async setSkill(dir, name, on) {
    try {
      await connect(dir, (rpc) => rpc.request('skills/config/write', { name, enabled: !!on }, ASK_MS));
    } catch (e) {
      return { ...this.current(dir, { refresh: false }), error: e.message };
    }
    return this.refresh(dir);
  }

  async setMcp(dir, name, on) {
    const server = this.current(dir, { refresh: false }).mcp.find((s) => s.name === name);
    const stop = (why) => ({ ...this.current(dir, { refresh: false }), error: why });
    if (!server) return stop(`codex has no server called ${name}`);
    if (!server.editable) {
      return stop(`${name} comes from a codex plugin rather than from config.toml, so it is switched off where the plugin is`);
    }
    if (!BARE_KEY.test(name)) return stop(`${name} cannot be addressed in config.toml from here; use \`codex mcp\` in a terminal`);

    try {
      await this.#writeConfig(dir, `mcp_servers.${name}.enabled`, !!on);
    } catch (e) {
      return stop(e.message);
    }
    return this.refresh(dir);
  }

  // Every write goes to the user's config.toml and is followed by a reload, so
  // an app-server that is already up sees the change rather than the file it
  // read at start.
  async #writeConfig(dir, keyPath, value) {
    return connect(dir, async (rpc) => {
      await rpc.request('config/value/write', { keyPath, value, mergeStrategy: value === null ? 'replace' : 'upsert' }, ASK_MS);
      await rpc.request('config/mcpServer/reload', null, ASK_MS);
    });
  }

  async addServer(dir, { name, scope = 'user', config }) {
    const clean = String(name || '').trim();
    if (!BARE_KEY.test(clean)) throw new Error('a codex server name is letters, digits, dash or underscore');
    if (!config || typeof config !== 'object') throw new Error('that server has no configuration');
    // codex keeps its servers in one file per machine. A .codex/config.toml in
    // the repo is a config layer codex reads, but the servers it lists are not
    // in what mcpServerStatus/list answers outside a thread, so a server added
    // there would vanish from this panel the moment it was written.
    if (scope !== 'user') throw new Error(`codex keeps its servers in ~/.codex/config.toml, so ${scope} is not a place to put one; choose yours`);

    const entry = {};
    if (config.command) {
      entry.command = config.command;
      if (config.args?.length) entry.args = config.args;
      if (config.env && Object.keys(config.env).length) entry.env = config.env;
    } else if (config.url) {
      if (config.type === 'sse') throw new Error('codex speaks streamable HTTP to a remote server, not SSE');
      entry.url = config.url;
      // codex takes a bearer token from a named environment variable rather
      // than from headers written into the file.
      if (config.headers && Object.keys(config.headers).length) {
        throw new Error('codex has no headers field; add the server with `codex mcp add --bearer-token-env-var` instead');
      }
    } else {
      throw new Error('a server needs a command or a url');
    }

    await this.#writeConfig(dir, `mcp_servers.${clean}`, entry);
    await this.refresh(dir);
    return { name: clean, scope: 'user', config: entry };
  }

  async removeServer(dir, name) {
    if (!BARE_KEY.test(name)) throw new Error(`${name} cannot be addressed in config.toml from here; use \`codex mcp remove\``);
    const server = this.current(dir, { refresh: false }).mcp.find((s) => s.name === name);
    if (server && !server.removable) throw new Error(`${name} comes from a codex plugin, so it is removed where the plugin is`);
    // A null value with `replace` takes the table out, leaving the file as it
    // was before the server was added.
    await this.#writeConfig(dir, `mcp_servers.${name}`, null);
    return this.refresh(dir);
  }

  /* A remote server behind OAuth is signed into from a terminal, for the reason
     catalog.js hands out `claude mcp login` rather than doing it: the browser
     prompt has to be in front of whoever answers it. The token codex writes is
     the one the next chat reads. */
  mcpLogin(dir, name) {
    const server = this.current(dir, { refresh: false }).mcp.find((s) => s.name === name);
    if (!server) return { error: `${name} is not a server codex knows about` };
    if (server.type !== 'http') return { error: `${name} is not a remote server, so there is nothing to sign in to` };
    const quote = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
    return { command: `${quote(codexBinary() || 'codex')} mcp login ${quote(name)}` };
  }

  // The rest of catalog.js's surface, answered honestly rather than left off,
  // so a caller can hold either object without asking which one it has.

  setConnectors(dir) {
    return { ...this.current(dir, { refresh: false }), error: 'codex has no account connectors to switch off' };
  }

  // Nothing is injected into a codex session: skills and servers are switched
  // in config.toml above, which is the file codex reads at start anyway.
  sessionSettings() { return {}; }

  offAtRuntime() { return []; }

  runtimeName(dir, name) { return name; }
}

module.exports = { CodexCatalog, configuredServers, probe };
