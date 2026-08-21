'use strict';
// Where a running window advertises its bridge. One file per project plus a
// "most recent" pointer, so two open projects do not fight over one path and a
// shell in project A keeps talking to project A's window.
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(os.homedir(), '.preview-browser-for-agent');
const PROJECTS = path.join(DIR, 'projects');
const LAST = path.join(DIR, 'bridge.json');

const slug = (cwd) => cwd.replace(/[/.]/g, '-').replace(/^-+/, '') || 'root';
const projectFile = (cwd) => path.join(PROJECTS, slug(path.resolve(cwd)) + '.json');

function read(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return s && s.url && s.token ? s : null;
  } catch { return null; }
}

// A window that crashed leaves its file behind. EPERM means the pid exists but
// belongs to someone else, which still counts as alive.
function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function write(state) {
  fs.mkdirSync(PROJECTS, { recursive: true });
  const body = JSON.stringify(state, null, 2);
  if (state.cwd) fs.writeFileSync(projectFile(state.cwd), body, { mode: 0o600 });
  fs.writeFileSync(LAST, body, { mode: 0o600 });
}

function clear(state) {
  try { if (state.cwd) fs.unlinkSync(projectFile(state.cwd)); } catch {}
  const last = read(LAST);
  if (last && last.pid === state.pid) { try { fs.unlinkSync(LAST); } catch {} }
}

// The window opened on exactly this directory, if it is still running.
function forDir(cwd) {
  const s = read(projectFile(path.resolve(cwd)));
  return s && alive(s.pid) ? s : null;
}

// Nearest window for this directory: walk up so a subdirectory still resolves
// to the project that owns it, then fall back to the most recent window.
function find(cwd) {
  let dir = path.resolve(cwd || '.');
  for (;;) {
    const s = read(projectFile(dir));
    if (s && alive(s.pid)) return s;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  const last = read(LAST);
  return last && alive(last.pid) ? last : null;
}

module.exports = { find, forDir, write, clear, projectFile, slug, DIR, LAST };
