'use strict';
// The MCP servers Tandem starts every agent session with, whichever CLI runs
// it. Configured once here rather than once per CLI, in the same shape as a
// .mcp.json so an existing config can be pasted in.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { DIR } = require('./projects');
const { MCP_GALLERY } = require('../shared/mcp-gallery');

const FILE = path.join(DIR, 'mcp.json');
// mcp-remote keeps its OAuth tokens here, keyed by a hash of the server URL.
// Every agent process gets the same directory, so one sign-in covers all of them.
const AUTH_DIR = path.join(DIR, 'mcp-auth');
// Kept inside the asar when packaged, like mcp/server.js: the node that runs it
// is electron-as-node, which can read the archive and resolve the packed deps.
const REMOTE = path.join(__dirname, '..', '..', 'node_modules', 'mcp-remote', 'dist');
// Electron's node gives each address 250ms to connect before trying the next,
// shorter than the round trip to some of these hosts from far away, and then
// fails every one of them. Newer node waits 500ms.
const NODE_FLAGS = ['--network-family-autoselection-attempt-timeout=500'];

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
  // Only this user can read it, since a server's headers can hold a token. The
  // rename carries the mode over a file an older version left readable.
  fs.writeFileSync(tmp, JSON.stringify({ mcpServers: servers }, null, 2) + '\n', { mode: 0o600 });
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

// A header reaches mcp-remote as a ${VAR} it fills in from its environment,
// since a value on the command line is there for any process list to read.
const headerVar = (key) => `TANDEM_MCP_HEADER_${key.toUpperCase().replace(/-/g, '_')}`;
const headerArg = (key) => `${key}:\${${headerVar(key)}}`;

function headerEnv(config) {
  // A ${VAR} of the user's own is expanded here, where mcp-remote used to do it.
  return Object.fromEntries(Object.entries(config.headers || {}).map(([k, v]) => [
    headerVar(k),
    String(v).replace(/\$\{([^}]+)}/g, (whole, name) => process.env[name] ?? whole),
  ]));
}

// The arguments both mcp-remote entry points take, so the proxy and the sign-in
// hash the server the same way and find the same token.
function remoteArgs(config) {
  const args = [config.url];
  for (const k of Object.keys(config.headers || {})) args.push('--header', headerArg(k));
  if (typeOf(config) === 'sse') args.push('--transport', 'sse-only');
  return args;
}

// What mcp-proxy.js runs mcp-remote's proxy with for one server.
function proxyLaunch(name) {
  const config = read()[name];
  if (!config?.url) throw new Error(`${name} is not one of Tandem's remote servers`);
  return { entry: path.join(REMOTE, 'proxy.js'), args: remoteArgs(config), env: headerEnv(config) };
}

// Every server as a stdio process, the one shape every CLI accepts at session
// start. A remote server runs behind mcp-remote, which is what lets them share
// one token cache instead of each CLI signing in on its own. Its launch line
// names the server and nothing more: claude and codex put the whole line, env
// included, on their own command lines.
//
// A server that signs in with OAuth is left out until it has a token. Without
// one its proxy opens the browser the moment a chat starts, and codex gives a
// server ten seconds to come up, far too short to finish a sign-in. The
// Authenticate button is where that happens instead.
function launchList(node) {
  return Object.entries(read()).filter(([name]) => !awaitingSignIn(name)).map(([name, config]) => (typeOf(config) === 'stdio'
    ? { name, command: config.command, args: config.args || [], env: config.env || {} }
    : {
      name,
      command: node,
      args: [...NODE_FLAGS, path.join(__dirname, 'mcp-proxy.js'), name],
      env: { MCP_REMOTE_CONFIG_DIR: AUTH_DIR },
    }));
}

// mcp-remote's own getServerUrlHash and getConfigDir, for the arguments
// remoteArgs passes: the url, then the headers as mcp-remote parses them back
// out of each --header, keys sorted. It hashes before it fills in the ${VAR}s,
// so a header's value never changes which token file a server uses.
function tokensFile(config) {
  const headers = {};
  for (const k of Object.keys(config.headers || {})) {
    const match = headerArg(k).match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) headers[match[1]] = match[2];
  }
  const parts = [config.url];
  if (Object.keys(headers).length) parts.push(JSON.stringify(headers, Object.keys(headers).sort()));
  const hash = crypto.createHash('md5').update(parts.join('|')).digest('hex');
  return path.join(AUTH_DIR, 'mcp-remote-v1', `${hash}_tokens.json`);
}

// Only the marketplace's servers are known to sign in with OAuth. One added by
// hand could go either way, so it is started as before.
const OAUTH_URLS = new Set(MCP_GALLERY.filter((g) => g.auth === 'oauth').map((g) => g.url));

function awaitingSignIn(name) {
  const config = read()[name];
  return !!config && OAUTH_URLS.has(config.url) && !signedIn(name);
}

function signedIn(name) {
  const config = read()[name];
  return !!config && typeOf(config) !== 'stdio' && fs.existsSync(tokensFile(config));
}

const AUTH_TIMEOUT = 5 * 60 * 1000;
const signIns = new Map();

// Runs mcp-remote's client once. It opens the browser for OAuth itself when the
// server asks for it, saves the token where every agent's proxy looks, lists
// the tools and exits 0. A server without auth goes straight to the listing.
// Electron runs it as node directly, since the node shim is a .cmd on Windows
// and that cannot be spawned without a shell.
function authenticate(name) {
  if (signIns.has(name)) return signIns.get(name).done;
  const config = read()[name];
  if (!config) return Promise.resolve({ error: `${name} is not one of Tandem's servers` });
  if (typeOf(config) === 'stdio') {
    return Promise.resolve({ error: `${name} runs as a local process, so there is nothing to sign in to` });
  }
  // stdin stays open: the client shuts down as soon as it closes.
  const child = spawn(process.execPath, [...NODE_FLAGS, path.join(REMOTE, 'client.js'), ...remoteArgs(config)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', MCP_REMOTE_CONFIG_DIR: AUTH_DIR, ...headerEnv(config) },
    stdio: ['pipe', 'ignore', 'pipe'],
    windowsHide: true,
  });
  // Every line mcp-remote logs starts with its pid in brackets; the lines in
  // between are stack traces.
  let last = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    for (const line of chunk.split('\n')) {
      const said = line.replace(/^(\[\d+\] )+/, '').trim();
      if (said !== line.trim() && said) last = said;
    }
  });
  const timer = setTimeout(() => {
    last = 'the sign-in was not finished within 5 minutes';
    child.kill();
  }, AUTH_TIMEOUT);
  const done = new Promise((resolve) => {
    child.on('error', (e) => { last = e.message; });
    child.on('close', (code) => {
      clearTimeout(timer);
      signIns.delete(name);
      resolve(code === 0 ? { ok: true } : { error: last || `mcp-remote exited with code ${code}` });
    });
  });
  signIns.set(name, { child, done });
  return done;
}

function stopSignIns() {
  for (const { child } of signIns.values()) child.kill();
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
    signedIn: signedIn(name),
  }));
  const names = new Set(ours.map((s) => s.name));
  return [...rows.filter((s) => !names.has(s.name)), ...ours].sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { FILE, read, add, remove, launchList, proxyLaunch, authenticate, stopSignIns, listed };
