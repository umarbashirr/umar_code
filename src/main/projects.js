'use strict';
// Which folder this window works in, and the folders it has worked in before.
// Launching from the app grid gives us cwd "/", so the choice has to come from
// somewhere else: an explicit folder, the folder we were started in, the one
// used last, or the person picking one from the menu.
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(os.homedir(), '.tandem');
const LAST = path.join(DIR, 'last-project');
const RECENT = path.join(DIR, 'recent-projects.json');
const MAX_RECENT = 12;

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

// Folders get deleted, renamed and unmounted. Anything that is no longer a
// directory is dropped on read rather than offered and then failing.
function recents() {
  let raw = [];
  try { raw = JSON.parse(fs.readFileSync(RECENT, 'utf8')); } catch {}
  if (!Array.isArray(raw)) return [];

  const out = [];
  const seen = new Set();
  for (const entry of raw) {
    const dir = typeof entry === 'string' ? entry : entry?.path;
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    if (!isDir(dir)) continue;
    out.push({ path: dir, name: path.basename(dir) || dir, at: entry?.at || 0 });
    if (out.length === MAX_RECENT) break;
  }
  return out;
}

function save(list) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(RECENT, JSON.stringify(list, null, 2));
  } catch {}
  return list;
}

function remember(dir) {
  const entry = { path: dir, name: path.basename(dir) || dir, at: Date.now() };
  const list = save([entry, ...recents().filter((r) => r.path !== dir)].slice(0, MAX_RECENT));
  try { fs.writeFileSync(LAST, dir); } catch {}
  return list;
}

const forget = (dir) => save(recents().filter((r) => r.path !== dir));

function clearRecents() {
  save([]);
  try { fs.unlinkSync(LAST); } catch {}
}

// The folder to start in. `chosen` is false only when we had nothing to go on
// and fell back to home, which is what puts the window in its empty state
// instead of quietly rooting an agent at the person's home directory.
//
// `reopen` is the startup setting. Off, the last folder is still remembered for
// the recents list; it just stops being where a bare launch lands.
// A folder handed over on the command line: `tandem.exe C:\\code\\shop`, and what
// Explorer's "Open with Tandem" passes. Running from a checkout puts the app
// directory itself in argv, which is a real directory and would win, so that
// one is skipped the way Electron marks it.
function folderArg() {
  const args = process.argv.slice(process.defaultApp ? 2 : 1);
  for (const a of args) {
    if (!a || a.startsWith('-')) continue;
    if (isDir(a)) return path.resolve(a);
  }
  return null;
}

// The working directory is a good guess when the app was started from a shell
// and a useless one when it was started from a shortcut, which on Windows hands
// over the install directory. Neither a drive root, a home directory nor the
// app's own folder is a project.
function usableCwd(here) {
  if (!isDir(here)) return false;
  if (here === path.parse(here).root) return false;
  if (here === os.homedir()) return false;
  try { if (here === path.dirname(process.execPath)) return false; } catch {}
  return true;
}

function startProject({ reopen = true } = {}) {
  const explicit = process.env.TANDEM_CWD;
  if (explicit && isDir(explicit)) return { dir: path.resolve(explicit), chosen: true };

  const named = folderArg();
  if (named) return { dir: named, chosen: true };

  const here = process.cwd();
  if (usableCwd(here)) return { dir: here, chosen: true };

  let remembered = null;
  if (reopen) { try { remembered = fs.readFileSync(LAST, 'utf8').trim(); } catch {} }
  if (remembered && isDir(remembered)) return { dir: remembered, chosen: true };

  return { dir: os.homedir(), chosen: false };
}

module.exports = { recents, remember, forget, clearRecents, startProject, isDir, DIR, LAST, RECENT };
