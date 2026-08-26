'use strict';
// Where a running window advertises its bridge. One file per open project plus
// a "most recent" pointer, so a shell in project A keeps talking to the window
// that has A open, even when that window has three other projects open beside
// it. Every file a window writes carries the same url, token and pid; only the
// cwd differs, so whichever one a caller lands on it reaches the same window.
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(os.homedir(), '.tandem');
const PROJECTS = path.join(DIR, 'projects');
const LAST = path.join(DIR, 'bridge.json');

// A Windows path arrives as C:\\Users\\me\\proj, and a colon and a backslash are
// both illegal in a filename there, so the separators and the drive colon go
// the same way the dots do.
const slug = (cwd) => cwd.replace(/[/\\:.]/g, '-').replace(/^-+/, '') || 'root';
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

// An entry is { url, token, pid, cwds, started }. The single cwd of the old
// one-folder-per-window shape is still accepted, since it means a set of one.
const projects = (entry) =>
  [...new Set((entry.cwds || (entry.cwd ? [entry.cwd] : [])).filter(Boolean).map((c) => path.resolve(c)))];

// Drop the pointer, but only if this window is the one it names. Another
// window may have opened since and taken it over.
function dropLast(pid) {
  const last = read(LAST);
  if (last && last.pid === pid) { try { fs.unlinkSync(LAST); } catch {} }
}

// Publish the window's whole set: one file per project, then the pointer.
function write(entry) {
  fs.mkdirSync(PROJECTS, { recursive: true });
  const cwds = projects(entry);
  for (const cwd of cwds) {
    fs.writeFileSync(projectFile(cwd), JSON.stringify({ ...entry, cwds, cwd }, null, 2), { mode: 0o600 });
  }
  // The pointer is the fallback for a shell that sits outside every open
  // project, and it can no longer name "the" project of a window that holds
  // several. So it carries the whole set, and keeps cwd pointing at the first,
  // which is the project the window opened with. Any of them would serve: a
  // caller that got here only needs a url and a token.
  if (!cwds.length) return dropLast(entry.pid); // a window with nothing open is nobody's fallback
  fs.writeFileSync(LAST, JSON.stringify({ ...entry, cwds, cwd: cwds[0] }, null, 2), { mode: 0o600 });
}

// Take back some or all of what write() published. Handing back a few projects
// of many leaves the pointer alone, because the window is still up and still
// the most recent one; the caller republishes the shrunken set straight after.
// The pointer only goes when the window lets go of everything it had, which is
// what stopping the bridge does.
function clear(entry, cwds) {
  const all = projects(entry);
  const gone = cwds ? [...new Set(cwds.filter(Boolean).map((c) => path.resolve(c)))] : all;
  for (const cwd of gone) { try { fs.unlinkSync(projectFile(cwd)); } catch {} }
  if (gone.length >= all.length) dropLast(entry.pid);
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
