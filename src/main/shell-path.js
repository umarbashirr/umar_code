'use strict';
// The PATH the user actually has, rather than the one the app was handed.
//
// Started from a desktop launcher, the app inherits the session's PATH, which
// on most Linux desktops is /usr/bin and little else. Nothing in ~/.local/bin,
// no nvm, no pipx, no uv. That is invisible until an MCP server configured as
// `command: analytics-mcp` fails with "Executable not found in $PATH", or the
// agent's Bash tool cannot find a tool the same shell finds fine.
//
// So ask the login shell what its PATH is, once, and merge it in front of what
// we already have. This is the same trick editors use for the same reason.
const { spawn } = require('child_process');
const path = require('path');

const MARK = '__tandem_path__';
const TIMEOUT_MS = 5000;

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

// -lic: a login, interactive shell, because that is where people put their PATH
// edits. The marker fences off anything the profile prints on the way.
function askShell(shell) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };

    let child;
    try {
      // Braces matter: `$PATH__tandem_path__` is one variable name to a shell, so
      // the marker has to be fenced off from it.
      child = spawn(shell, ['-lic', `echo ${MARK}\${PATH}${MARK}`], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return finish(null);
    }

    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish(null); }, TIMEOUT_MS);
    child.stdout.on('data', (d) => { if (out.length < 65536) out += d; });
    child.on('error', () => { clearTimeout(timer); finish(null); });
    child.on('close', () => {
      clearTimeout(timer);
      const m = out.split(MARK);
      finish(m.length >= 3 ? m[1].trim() : null);
    });
  });
}

let resolved = null;

// Returns the merged PATH, or the one we started with if the shell had nothing
// to add. Runs the shell once per app launch and remembers the answer.
async function shellPath() {
  if (resolved) return resolved;
  const current = (process.env.PATH || '').split(path.delimiter);
  // Windows has no login shell to ask, and PATH there comes from the registry
  // rather than from a profile the app cannot see, so what we were handed is
  // already the answer.
  if (process.platform === 'win32') {
    resolved = process.env.PATH || '';
    return resolved;
  }
  const shell = process.env.SHELL || '/bin/sh';
  const asked = await askShell(shell);
  resolved = asked ? merge(asked.split(path.delimiter), current) : (process.env.PATH || '');
  return resolved;
}

const cached = () => resolved || process.env.PATH || '';

module.exports = { shellPath, cached, merge };
