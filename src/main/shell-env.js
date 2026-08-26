'use strict';
// The environment the user actually has, rather than the one the app was handed.
//
// Started from a desktop launcher, the app inherits the session's environment,
// which on most Linux desktops is a PATH of /usr/bin and little else, and none
// of the exports in the user's rc files. Nothing in ~/.local/bin, no nvm, no
// pipx, no uv, and no ANTHROPIC_BASE_URL either. That is invisible until an MCP
// server configured as `command: analytics-mcp` fails with "Executable not found
// in $PATH", or the agent asks someone to log in who is already logged in
// because their key lives in an export the app never saw.
//
// So ask the login shell for its whole environment, once, and take the parts
// that decide how Claude talks to a model. This is the same trick editors use
// for the same reason.
const { spawn } = require('child_process');
const path = require('path');

const MARK = '__tandem_env__';
const TIMEOUT_MS = 5000;

// What is worth carrying over. Everything here changes which endpoint the CLI
// talks to, which credentials it presents, or whether the connection can be
// made at all. Anything else the shell exports is left where it is: this
// process has its own reasons for the environment it was given, and a stale
// value from an rc file should not get to override them.
const ADOPT_PREFIX = ['ANTHROPIC_', 'CLAUDE_', 'AWS_', 'GOOGLE_', 'GCLOUD_', 'VERTEX_'];
const ADOPT_NAME = new Set([
  'CLOUD_ML_REGION',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
]);
// Caught by the prefixes above, but they describe a session rather than a
// configuration: they say a CLI is running, not how to reach a model.
const DENY = new Set(['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT']);

function adoptable(name) {
  if (DENY.has(name) || name.startsWith('TANDEM_')) return false;
  return ADOPT_NAME.has(name) || ADOPT_PREFIX.some((p) => name.startsWith(p));
}

function merge(extra, current) {
  const seen = new Set();
  const out = [];
  for (const dir of [...extra, ...current]) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    out.push(dir);
  }
  return out.join(path.delimiter);
}

// `env` prints one KEY=value per line, except when a value has newlines in it,
// and a certificate pasted into NODE_EXTRA_CA_CERTS does. A line that does not
// start a new name belongs to the value before it.
function parse(block) {
  const out = {};
  let key = null;
  for (const line of block.split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) { key = m[1]; out[key] = m[2]; } else if (key) out[key] += `\n${line}`;
  }
  return out;
}

// -lic: a login, interactive shell, because that is where people put their
// exports. The marker fences off anything the profile prints on the way.
function askShell(shell) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };

    let child;
    try {
      child = spawn(shell, ['-lic', `echo ${MARK}; command env; echo ${MARK}`],
        { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return finish(null);
    }

    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish(null); }, TIMEOUT_MS);
    // A whole environment is bigger than a PATH: a shell with a long history
    // variable or a certificate in it can run to tens of kilobytes.
    child.stdout.on('data', (d) => { if (out.length < 1048576) out += d; });
    child.on('error', () => { clearTimeout(timer); finish(null); });
    child.on('close', () => {
      clearTimeout(timer);
      const m = out.split(MARK);
      finish(m.length >= 3 ? parse(m[1]) : null);
    });
  });
}

let captured = null;      // what the login shell printed, or {} if it said nothing
let resolvedPath = null;  // that shell's PATH, merged in front of ours
let inflight = null;

async function capture() {
  const current = (process.env.PATH || '').split(path.delimiter);
  // Windows has no login shell to ask, and its variables come from the registry
  // rather than from a profile the app cannot see, so what we were handed is
  // already the answer.
  if (process.platform === 'win32') {
    captured = {};
    resolvedPath = process.env.PATH || '';
    return resolvedPath;
  }
  const asked = await askShell(process.env.SHELL || '/bin/sh');
  captured = asked || {};
  resolvedPath = asked?.PATH
    ? merge(asked.PATH.split(path.delimiter), current)
    : (process.env.PATH || '');
  return resolvedPath;
}

// Runs the shell once per app launch and remembers the answer. Everyone who
// needs the environment awaits this rather than racing it.
function ready() {
  if (captured) return Promise.resolve(resolvedPath);
  if (!inflight) inflight = capture().finally(() => { inflight = null; });
  return inflight;
}

const cached = () => resolvedPath || process.env.PATH || '';

// What a child process should run with. A value this process already has wins:
// someone who started the app from a terminal meant that terminal's answer,
// and only someone who started it from a launcher needs the shell's.
function env() {
  const out = { ...process.env };
  for (const [name, value] of Object.entries(captured || {})) {
    if (!value || out[name] || !adoptable(name)) continue;
    out[name] = value;
  }
  out.PATH = cached();
  return out;
}

// Which endpoint the CLI will talk to, empty when that is Anthropic's own.
const baseUrl = () => (env().ANTHROPIC_BASE_URL || '').trim().replace(/\/+$/, '');
const authToken = () => env().ANTHROPIC_AUTH_TOKEN || env().ANTHROPIC_API_KEY || '';

module.exports = { ready, cached, env, merge, baseUrl, authToken };
