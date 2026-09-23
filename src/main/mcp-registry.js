'use strict';
// The MCP servers Tandem starts every agent session with, whichever CLI runs
// it. Configured once here rather than once per CLI, in the same shape as a
// .mcp.json so an existing config can be pasted in.
const fs = require('fs');
const path = require('path');
const { DIR } = require('./projects');

const FILE = path.join(DIR, 'mcp.json');
// mcp-remote keeps its OAuth tokens here, keyed by a hash of the server URL.
// Every agent process gets the same directory, so one sign-in covers all of them.
const AUTH_DIR = path.join(DIR, 'mcp-auth');
// Kept inside the asar when packaged, like mcp/server.js: the node that runs it
// is electron-as-node, which can read the archive and resolve the packed deps.
const REMOTE = path.join(__dirname, '..', '..', 'node_modules', 'mcp-remote', 'dist');

// Tandem's own servers go by these names in every session.
const RESERVED = new Set(['preview', 'tandem']);
const NAME = /^[A-Za-z0-9_-]+$/;

function read() {
  try {
    const servers = JSON.parse(fs.readFileSync(FILE, 'utf8'))?.mcpServers;
    return servers && typeof servers === 'object' && !Array.isArray(servers) ? servers : {};
  } catch {
    return {};
  }
}

function write(servers) {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ mcpServers: servers }, null, 2) + '\n');
  fs.renameSync(tmp, FILE);
}

const typeOf = (config) => config.command ? 'stdio' : config.type === 'sse' ? 'sse' : 'http';

function add(name, config) {
  const clean = String(name || '').trim();
  if (!NAME.test(clean)) throw new Error('a server name is letters, digits, dash or underscore');
  if (RESERVED.has(clean)) throw new Error(`${clean} is the name of one of Tandem's own servers`);
  if (!config || typeof config !== 'object' || !(config.command || config.url)) {
    throw new Error('a server needs a command to run or a url to reach');
  }
  write({ ...read(), [clean]: config });
  return clean;
}

function remove(name) {
  const servers = read();
  delete servers[name];
  write(servers);
}

// The arguments both mcp-remote entry points take, so the proxy and the sign-in
// hash the server the same way and find the same token.
function remoteArgs(config) {
  const args = [config.url];
  for (const [k, v] of Object.entries(config.headers || {})) args.push('--header', `${k}: ${v}`);
  if (typeOf(config) === 'sse') args.push('--transport', 'sse-only');
  return args;
}

// Every server as a stdio process, the one shape every CLI accepts at session
// start. A remote server runs behind mcp-remote, which is what lets them share
// one token cache instead of each CLI signing in on its own.
function launchList(node) {
  return Object.entries(read()).map(([name, config]) => (typeOf(config) === 'stdio'
    ? { name, command: config.command, args: config.args || [], env: config.env || {} }
    : {
      name,
      command: node,
      args: [path.join(REMOTE, 'proxy.js'), ...remoteArgs(config)],
      env: { MCP_REMOTE_CONFIG_DIR: AUTH_DIR },
    }));
}

// A shell command that runs the browser sign-in for a remote server once.
function loginCommand(name, node) {
  const config = read()[name];
  if (!config) return { error: `${name} is not one of Tandem's servers` };
  if (typeOf(config) === 'stdio') return { error: `${name} runs as a local process, so there is nothing to sign in to` };
  const quote = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
  const argv = [node, path.join(REMOTE, 'client.js'), ...remoteArgs(config)];
  return { command: `MCP_REMOTE_CONFIG_DIR=${quote(AUTH_DIR)} ${argv.map(quote).join(' ')}` };
}

// The servers as catalog rows. A CLI's own server of the same name gives way,
// so the panel shows the entry Tandem hands every session.
function listed(rows) {
  const ours = Object.entries(read()).map(([name, config]) => ({
    name,
    runtime: name,
    scope: 'tandem',
    type: typeOf(config),
    target: config.command ? [config.command, ...(config.args || [])].join(' ') : config.url,
    config,
    enabled: true,
    editable: false,
    removable: true,
    status: 'configured',
    error: null,
    tools: null,
  }));
  const names = new Set(ours.map((s) => s.name));
  return [...rows.filter((s) => !names.has(s.name)), ...ours].sort((a, b) => a.name.localeCompare(b.name));
}

const has = (name) => Object.hasOwn(read(), name);

module.exports = { FILE, read, add, remove, has, launchList, loginCommand, listed };
