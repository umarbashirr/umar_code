'use strict';
// What the panel knows about skills and MCP servers without a session running.
//
// Same rule as driver.js: nothing the UI draws may cost a spawn of the ~360MB
// claude binary. A skill is a folder with a SKILL.md in it and an MCP server is
// a JSON entry in a config file, so both lists can be read off disk in a few
// milliseconds. A live session knows more (the built-in commands, whether a
// server actually connected), and when one is running it corrects what was read
// here.
//
// Where things live:
//   skills    <project>/.claude/skills/*/SKILL.md      project
//             ~/.claude/skills/*/SKILL.md              user
//             ~/.claude/skills/synced/*/SKILL.md       synced from claude.ai
//             <plugin>/skills/*/SKILL.md               plugin, named plugin:skill
//   commands  <project|~>/.claude/commands/**.md, <plugin>/commands/*.md
//   mcp       <project>/.mcp.json                      project
//             ~/.claude.json  mcpServers               user
//             ~/.claude.json  projects[dir].mcpServers local
//             <plugin>/.mcp.json                       plugin
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const CLAUDE_JSON = path.join(HOME, '.claude.json');
const SCAN_TTL_MS = 5000;

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};

// SKILL.md files run to tens of kilobytes and only the frontmatter is wanted,
// so stop at the first few of them rather than pulling the body into memory.
function readHead(file, bytes = 8192) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.slice(0, n).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

const unquote = (v) => {
  const s = v.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
};

// Enough YAML for a skill header: top-level scalars plus the folded blocks that
// long descriptions are written in. Nested keys are indented, so the
// start-of-line anchor skips them and `metadata:` cannot leak a `type:` out.
function frontmatter(text) {
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end < 0) return {};
  const lines = text.slice(text.indexOf('\n') + 1, end).split('\n');
  const out = {};

  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const [, key, raw] = m;
    let value = raw.trim();

    if (/^[>|]-?$/.test(value)) {
      const folded = value[0] === '>';
      const parts = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
        parts.push(lines[++i].trim());
      }
      value = (folded ? parts.join(' ') : parts.join('\n')).trim();
    } else {
      value = unquote(value);
    }
    out[key] = value;
  }
  return out;
}

// A skill folder is often a symlink to somewhere else on disk, which readdir
// reports as a link rather than a directory. Follow it before deciding.
function kindOf(root, entry) {
  if (entry.isDirectory()) return 'dir';
  if (entry.isFile()) return 'file';
  if (!entry.isSymbolicLink()) return null;
  try { return fs.statSync(path.join(root, entry.name)).isDirectory() ? 'dir' : 'file'; } catch { return null; }
}

const entries = (root, kind) => {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.') && kindOf(root, e) === kind)
      .map((e) => e.name);
  } catch { return []; }
};

const dirs = (root) => entries(root, 'dir');

function readSkill(dir, source, prefix, plugin) {
  const file = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(file)) return null;
  const meta = frontmatter(readHead(file));
  return {
    kind: 'skill',
    name: prefix + (meta.name || path.basename(dir)),
    description: meta.description || '',
    argumentHint: meta['argument-hint'] || '',
    source,
    path: file,
    ...(plugin ? { plugin } : {}),
  };
}

// A folder with a SKILL.md in it is the skill. A folder of folders is a shelf
// of them, which is how people group a set under one directory, so look one
// level further before giving up.
function skillsIn(root, source, prefix = '', depth = 0) {
  const out = [];
  for (const name of dirs(root)) {
    const dir = path.join(root, name);
    const skill = readSkill(dir, source, prefix);
    if (skill) out.push(skill);
    else if (depth < 1) out.push(...skillsIn(dir, source, prefix, depth + 1));
  }
  return out;
}

// A plugin that lists its skills in plugin.json means that list: the folder can
// also hold ones it deliberately does not ship, in a `deprecated` or
// `in-progress` shelf. Without a list, the convention is skills/<name>/SKILL.md.
function pluginSkills(plugin) {
  const manifest = readJson(path.join(plugin.root, '.claude-plugin', 'plugin.json'));
  const listed = Array.isArray(manifest?.skills) ? manifest.skills : null;
  const prefix = `${plugin.name}:`;

  if (!listed) {
    return skillsIn(path.join(plugin.root, 'skills'), 'plugin', prefix)
      .map((s) => ({ ...s, plugin: plugin.name }));
  }

  const out = [];
  for (const rel of listed) {
    if (typeof rel !== 'string') continue;
    const dir = path.resolve(plugin.root, rel);
    // A manifest entry that climbs out of its own plugin is not one to follow.
    if (dir !== plugin.root && !dir.startsWith(plugin.root + path.sep)) continue;
    const skill = readSkill(dir, 'plugin', prefix, plugin.name);
    if (skill) out.push(skill);
  }
  return out;
}

// Commands nest: .claude/commands/git/sync.md is /git:sync.
function commandsIn(root, source, prefix = '', depth = 0) {
  const out = [];
  let listing = [];
  try { listing = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }

  for (const e of listing) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(root, e.name);
    const kind = kindOf(root, e);
    if (kind === 'dir') {
      if (depth < 2) out.push(...commandsIn(full, source, `${prefix}${e.name}:`, depth + 1));
      continue;
    }
    if (kind !== 'file' || !e.name.endsWith('.md')) continue;
    const meta = frontmatter(readHead(full, 2048));
    out.push({
      kind: 'command',
      name: prefix + e.name.slice(0, -3),
      description: meta.description || '',
      argumentHint: meta['argument-hint'] || '',
      source,
      path: full,
    });
  }
  return out;
}

// Plugins the settings files have switched on, resolved to the folder their
// files were unpacked into. A plugin can be installed for the user and for one
// project at once; either install path will do, they are the same version.
function enabledPlugins(dir) {
  const enabled = {};
  for (const file of [
    path.join(CLAUDE_DIR, 'settings.json'),
    path.join(dir, '.claude', 'settings.json'),
    path.join(dir, '.claude', 'settings.local.json'),
  ]) {
    const s = readJson(file);
    if (s?.enabledPlugins) Object.assign(enabled, s.enabledPlugins);
  }

  const installed = readJson(path.join(CLAUDE_DIR, 'plugins', 'installed_plugins.json'))?.plugins || {};
  const out = [];
  for (const [id, on] of Object.entries(enabled)) {
    if (!on) continue;
    const installs = installed[id] || [];
    const pick = installs.find((i) => i.scope === 'local' && i.projectPath === dir)
      || installs.find((i) => i.scope === 'user')
      || installs[0];
    if (!pick?.installPath || !fs.existsSync(pick.installPath)) continue;
    out.push({ id, name: id.split('@')[0], root: pick.installPath });
  }
  return out;
}

function scanSkills(dir) {
  const out = [
    ...skillsIn(path.join(dir, '.claude', 'skills'), 'project'),
    ...skillsIn(path.join(CLAUDE_DIR, 'skills'), 'user'),
    ...skillsIn(path.join(CLAUDE_DIR, 'skills', 'synced'), 'synced'),
    ...commandsIn(path.join(dir, '.claude', 'commands'), 'project'),
    ...commandsIn(path.join(CLAUDE_DIR, 'commands'), 'user'),
  ];
  for (const p of enabledPlugins(dir)) {
    out.push(...pluginSkills(p));
    out.push(...commandsIn(path.join(p.root, 'commands'), 'plugin', `${p.name}:`).map((c) => ({ ...c, plugin: p.name })));
  }
  // ~/.claude/skills/synced is also a child of ~/.claude/skills, so it is read
  // twice; the later entry is the one with the right source.
  const seen = new Map();
  for (const s of out) seen.set(s.name, { ...seen.get(s.name), ...s });
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Agents are one markdown file each, frontmatter and a prompt, in the same
// three places skills live. Unlike a skill there is no folder: agents/foo.md is
// the agent called foo.
function agentsIn(root, source, prefix = '') {
  const out = [];
  let listing = [];
  try { listing = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of listing) {
    if (e.name.startsWith('.') || !e.name.endsWith('.md')) continue;
    if (kindOf(root, e) !== 'file') continue;
    const file = path.join(root, e.name);
    const meta = frontmatter(readHead(file));
    out.push({
      kind: 'agent',
      name: prefix + (meta.name || e.name.replace(/\.md$/, '')),
      description: meta.description || '',
      model: meta.model || 'inherit',
      tools: meta.tools || '',
      source,
      path: file,
    });
  }
  return out;
}

function scanAgents(dir) {
  const out = [
    ...agentsIn(path.join(dir, '.claude', 'agents'), 'project'),
    ...agentsIn(path.join(CLAUDE_DIR, 'agents'), 'user'),
  ];
  for (const p of enabledPlugins(dir)) {
    out.push(...agentsIn(path.join(p.root, 'agents'), 'plugin', `${p.name}:`).map((a) => ({ ...a, plugin: p.name })));
  }
  const seen = new Map();
  for (const a of out) seen.set(a.name, { ...seen.get(a.name), ...a });
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// One server, flattened enough for a list: what it is and how to reach it.
const describe = (name, config, scope) => ({
  name,
  runtime: name,
  scope,
  type: config.type || (config.command ? 'stdio' : config.url ? 'http' : 'unknown'),
  target: config.command
    ? [config.command, ...(config.args || [])].join(' ')
    : config.url || '',
  config,
});

function scanMcp(dir) {
  const out = [];
  const add = (servers, scope) => {
    for (const [name, config] of Object.entries(servers || {})) {
      if (config && typeof config === 'object') out.push(describe(name, config, scope));
    }
  };

  add(readJson(path.join(dir, '.mcp.json'))?.mcpServers, 'project');
  const global = readJson(CLAUDE_JSON);
  add(global?.mcpServers, 'user');
  add(global?.projects?.[dir]?.mcpServers, 'local');
  // A plugin's servers are known to the session under a prefixed name, which is
  // the one every runtime call has to use.
  for (const p of enabledPlugins(dir)) {
    const at = out.length;
    add(readJson(path.join(p.root, '.mcp.json'))?.mcpServers, 'plugin');
    for (const s of out.slice(at)) { s.plugin = p.name; s.runtime = `plugin:${p.name}:${s.name}`; }
  }

  const seen = new Map();
  for (const s of out) if (!seen.has(s.name)) seen.set(s.name, s);
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// The session's own list is the only one that carries a connection status, and
// it does not line up with the files: plugin servers are prefixed, the claude.ai
// connectors are not in any file here, and `preview` is this app's own browser
// tools. Match on the bare name, then append whatever is left over.
const EDITABLE = new Set(['project', 'user', 'local']);
const bare = (name) => name.replace(/^plugin:[^:]+:/, '');

function mergeServers(configured, reported, off, live) {
  const seen = new Map(reported.map((s) => [bare(s.name), s]));
  const dressed = configured.map((s) => {
    const now = seen.get(bare(s.runtime || s.name));
    seen.delete(bare(s.runtime || s.name));
    return { ...s, live: now };
  });

  for (const [, now] of seen) {
    const own = now.name === 'preview';
    dressed.push({
      ...describe(now.name, now.config || {}, own ? 'built in' : now.scope || 'session'),
      // The app's own server runs inside this process, so it has no transport
      // and no address to show.
      ...(own ? { type: 'in process', target: 'the preview browser, provided by this app' } : {}),
      live: now,
    });
  }

  return dressed.map(({ live: now, ...s }) => ({
    ...s,
    enabled: !off.has(s.name),
    // Anything but this app's own browser tools can be switched off for the
    // session; only what is written in a config file here can be removed.
    editable: s.name !== 'preview',
    removable: EDITABLE.has(s.scope),
    // A configured server the session never mentioned is not connecting, it is
    // absent: the CLI read its files at startup and this one was not among them.
    status: off.has(s.name) ? 'disabled' : now?.status || (live ? 'absent' : 'configured'),
    error: now?.error || null,
    tools: now?.tools?.length || null,
  })).sort((a, b) => a.name.localeCompare(b.name));
}

// --- writing config back ---------------------------------------------------

// ~/.claude.json is the CLI's own file, it is large, and it is mode 600. Write
// through a temp file beside it so a crash mid-write cannot leave a truncated
// one, and carry the old mode over so a rewrite never widens who can read it.
// A `claude` running at the same time may have written in between; last one
// wins, which is what any other editor of that file would do too.
function writeJson(file, value) {
  let mode;
  try { mode = fs.statSync(file).mode & 0o777; } catch {}
  const tmp = `${file}.tandem-${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', mode === undefined ? undefined : { mode });
  fs.renameSync(tmp, file);
}

function editMcpConfig(dir, scope, mutate) {
  if (scope === 'project') {
    const file = path.join(dir, '.mcp.json');
    const doc = readJson(file) || {};
    doc.mcpServers = doc.mcpServers || {};
    mutate(doc.mcpServers);
    writeJson(file, doc);
    return file;
  }

  const doc = readJson(CLAUDE_JSON) || {};
  if (scope === 'user') {
    doc.mcpServers = doc.mcpServers || {};
    mutate(doc.mcpServers);
  } else if (scope === 'local') {
    doc.projects = doc.projects || {};
    doc.projects[dir] = doc.projects[dir] || {};
    doc.projects[dir].mcpServers = doc.projects[dir].mcpServers || {};
    mutate(doc.projects[dir].mcpServers);
  } else {
    throw new Error(`${scope} servers are owned by their plugin and cannot be edited here`);
  }
  writeJson(CLAUDE_JSON, doc);
  return CLAUDE_JSON;
}

class Catalog {
  constructor({ cacheDir }) {
    this.file = path.join(cacheDir, 'catalog.json');
    this.prefs = readJson(this.file) || {};   // project dir -> { skillsOff, mcpOff }
    this.scans = new Map();                   // project dir -> { at, skills, mcp }
    this.live = new Map();                    // project dir -> { commands, mcp } from a session
  }

  #savePrefs() {
    try { writeJson(this.file, this.prefs); } catch {}
  }

  #for(dir) {
    const p = this.prefs[dir] || (this.prefs[dir] = {});
    p.skillsOff = p.skillsOff || [];
    p.mcpOff = p.mcpOff || [];
    return p;
  }

  // The connectors switched on in the Claude account. The CLI fetches and
  // connects them on its own, and they can crowd out a local server that offers
  // the same thing, so this folder gets a say in whether they are used at all.
  setConnectors(dir, on) {
    const p = this.#for(dir);
    if (on) delete p.connectorsOff; else p.connectorsOff = true;
    this.#savePrefs();
    return this.current(dir);
  }

  #scan(dir) {
    const hit = this.scans.get(dir);
    if (hit && Date.now() - hit.at < SCAN_TTL_MS) return hit;
    const fresh = { at: Date.now(), skills: scanSkills(dir), mcp: scanMcp(dir), agents: scanAgents(dir) };
    this.scans.set(dir, fresh);
    return fresh;
  }

  invalidate(dir) {
    if (dir) this.scans.delete(dir); else this.scans.clear();
  }

  // The list the panel draws: what is on disk, overlaid with whatever a running
  // session has since reported. `live` is false when no session has ever run in
  // this folder, which is what the status column keys off.
  current(dir) {
    const { skills, mcp, agents } = this.#scan(dir);
    const prefs = this.#for(dir);
    const live = this.live.get(dir);
    const off = new Set(prefs.skillsOff);

    // Copies, not the cached scan: the merge below fills in gaps and the cache
    // has to stay as it was read.
    const byName = new Map(skills.map((s) => [s.name, { ...s }]));
    for (const c of live?.commands || []) {
      const known = byName.get(c.name);
      if (known) {
        byName.set(c.name, {
          ...known,
          description: known.description || c.description || '',
          argumentHint: known.argumentHint || c.argumentHint || '',
        });
      } else {
        // Everything the CLI ships with: /compact, /usage, the bundled skills.
        byName.set(c.name, {
          kind: 'skill', name: c.name, description: c.description || '',
          argumentHint: c.argumentHint || '', source: 'builtin',
        });
      }
    }

    const offMcp = new Set(prefs.mcpOff);
    return {
      live: !!live,
      connectors: !prefs.connectorsOff,
      skills: [...byName.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((s) => ({ ...s, enabled: !off.has(s.name) })),
      // Listed, not switchable: no settings key turns an agent off, and a
      // toggle that quietly does nothing is worse than no toggle.
      agents,
      mcp: mergeServers(mcp, live?.mcp || [], offMcp, !!live),
    };
  }

  // A session's own view. Its command list includes the built-ins, and its
  // server list is the only place a connection failure shows up.
  learn(dir, { commands, mcp }) {
    const prev = this.live.get(dir) || {};
    this.live.set(dir, {
      commands: commands?.length ? commands : prev.commands,
      mcp: mcp?.length ? mcp : prev.mcp,
    });
  }

  setSkill(dir, name, on) {
    const p = this.#for(dir);
    p.skillsOff = p.skillsOff.filter((n) => n !== name);
    if (!on) p.skillsOff.push(name);
    this.#savePrefs();
    return this.current(dir);
  }

  setMcp(dir, name, on) {
    const p = this.#for(dir);
    p.mcpOff = p.mcpOff.filter((n) => n !== name);
    if (!on) p.mcpOff.push(name);
    this.#savePrefs();
    return this.current(dir);
  }

  addServer(dir, { name, scope = 'project', config }) {
    const clean = String(name || '').trim();
    if (!/^[A-Za-z0-9_.-]+$/.test(clean)) throw new Error('a server name is letters, digits, dot, dash or underscore');
    if (!config || typeof config !== 'object') throw new Error('that server has no configuration');
    editMcpConfig(dir, scope, (servers) => { servers[clean] = config; });
    this.invalidate(dir);
    return { name: clean, scope, config };
  }

  removeServer(dir, name, scope) {
    editMcpConfig(dir, scope, (servers) => { delete servers[name]; });
    const p = this.#for(dir);
    p.mcpOff = p.mcpOff.filter((n) => n !== name);
    this.#savePrefs();
    this.invalidate(dir);
    return { name, scope };
  }

  // What a query has to be started with to honour the switches above. Skills go
  // through the settings layer the CLI already reads; servers configured in a
  // .mcp.json are rejected there too, so they never connect in the first place.
  sessionSettings(dir) {
    const p = this.#for(dir);
    const settings = {};
    if (p.skillsOff.length) {
      settings.skillOverrides = Object.fromEntries(p.skillsOff.map((n) => [n, 'off']));
    }
    const project = new Set(this.#scan(dir).mcp.filter((s) => s.scope === 'project').map((s) => s.name));
    const rejected = p.mcpOff.filter((n) => project.has(n));
    if (rejected.length) settings.disabledMcpjsonServers = rejected;
    if (p.connectorsOff) settings.disableClaudeAiConnectors = true;
    return settings;
  }

  // The rest: user, local and plugin servers have no settings switch, so a
  // running session is told to drop them once it is up.
  // The name the session knows a server by, which is not always the one the
  // panel shows: a plugin's servers are prefixed with the plugin they came from.
  runtimeName(dir, name) {
    return this.current(dir).mcp.find((s) => s.name === name)?.runtime || name;
  }

  offAtRuntime(dir) {
    const p = this.#for(dir);
    const servers = this.current(dir).mcp;
    const byName = new Map(servers.map((s) => [s.name, s]));
    const off = p.mcpOff
      .filter((n) => byName.get(n)?.scope !== 'project')
      .map((n) => byName.get(n)?.runtime || n);

    // A session that started before the switch was thrown already has the
    // connectors open; drop them the same way any other unwanted server goes.
    if (p.connectorsOff) {
      for (const s of servers) if (s.scope === 'claudeai') off.push(s.runtime);
    }
    return [...new Set(off)];
  }
}

module.exports = { Catalog, frontmatter, scanSkills, scanMcp };
