'use strict';
// Which folders this window works in, and the folders it has worked in before.
// Launching from the app grid gives us cwd "/", so the choice has to come from
// somewhere else: an explicit folder, the folder we were started in, the one
// used last, or the person picking one from the menu.
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(os.homedir(), '.tandem');
const LAST = path.join(DIR, 'last-project');
const RECENT = path.join(DIR, 'recent-projects.json');
const OPEN = path.join(DIR, 'open-projects.json');
const MAX_RECENT = 12;

// A window holds a strip of projects, not a tab bar of files. Each one costs a
// watcher and a live agent, and past a handful the strip is too small to read a
// name in, so the set is capped. At the cap the oldest end falls off instead of
// the open being refused, because refusing to open a folder someone asked for is
// worse than quietly closing one they stopped using.
const MAX_OPEN = 8;

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

function writeJson(file, value) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
  } catch {}
}

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
  writeJson(RECENT, list);
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

// The projects this window has open, in the order they sit in the strip, as
// absolute paths. Same rule as the recents list: a folder that has been deleted,
// renamed or unmounted since it was saved is dropped on read, so this never
// hands back a path that is gone.
function openProjects() {
  let raw = [];
  try { raw = JSON.parse(fs.readFileSync(OPEN, 'utf8')); } catch {}
  if (!Array.isArray(raw)) return [];

  const out = [];
  const seen = new Set();
  for (const entry of raw) {
    const dir = typeof entry === 'string' ? entry : entry?.path;
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    if (!isDir(dir)) continue;
    out.push(dir);
    if (out.length === MAX_OPEN) break;
  }
  return out;
}

// The whole strip at once, for a drag that reorders it or a restore at startup.
// The order given is the order kept, minus duplicates and folders that are gone.
function setOpenProjects(list) {
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(list) ? list : []) {
    const dir = typeof entry === 'string' ? entry : entry?.path;
    if (!dir) continue;
    const full = path.resolve(dir);
    if (seen.has(full) || !isDir(full)) continue;
    seen.add(full);
    out.push(full);
  }
  const capped = out.slice(-MAX_OPEN);
  writeJson(OPEN, capped);
  return capped;
}

// A newly opened project goes on the end, where a new tab goes. Opening one that
// is already in the strip is a focus change and nothing more, so the order it
// was put in is left alone.
function openProject(dir) {
  const open = openProjects();
  const full = path.resolve(dir);
  if (open.includes(full)) return open;
  return setOpenProjects([...open, full]);
}

// Closing the last project leaves the strip empty, and empty is a state the
// window already handles: it is the one startProject reports with `chosen`
// false, where nothing is rooted and the person is asked to pick a folder. The
// LAST pointer is left alone on purpose, so someone who closes everything and
// quits comes back to the folder they were working in rather than to a blank
// window.
const closeProject = (dir) => setOpenProjects(openProjects().filter((p) => p !== path.resolve(dir)));

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

// A folder someone asked for by name, from the environment or the command line.
// Both mean the same thing, so both start and reopen read them through here.
function namedFolder() {
  const explicit = process.env.TANDEM_CWD;
  if (explicit && isDir(explicit)) return path.resolve(explicit);
  return folderArg();
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

// The folder to start in. `chosen` is false only when we had nothing to go on
// and fell back to home, which is what puts the window in its empty state
// instead of quietly rooting an agent at the person's home directory.
//
// `reopen` is the startup setting. Off, the last folder is still remembered for
// the recents list; it just stops being where a bare launch lands.
function startProject({ reopen = true } = {}) {
  const named = namedFolder();
  if (named) return { dir: named, chosen: true };

  const here = process.cwd();
  if (usableCwd(here)) return { dir: here, chosen: true };

  let remembered = null;
  if (reopen) { try { remembered = fs.readFileSync(LAST, 'utf8').trim(); } catch {} }
  if (remembered && isDir(remembered)) return { dir: remembered, chosen: true };

  return { dir: os.homedir(), chosen: false };
}

// Which projects a window opens on launch, and which of them has focus. Nothing
// is written here; main decides when the window is really up and saves the strip
// then.
//
// With `reopen` off a bare launch comes up on one project, the way it always
// has, not on everything that happened to be open last time. With it on the
// saved strip is the answer, and a folder asked for by name joins the strip and
// takes focus, because someone who names a folder wants to look at that one.
//
// An empty saved strip means "nothing to reopen", not "come back to a blank
// window". We do not try to tell a first launch from someone who closed
// everything before quitting, since that would take another file to record and
// landing on the remembered folder is the better of the two answers anyway.
function startProjects({ reopen = true } = {}) {
  const first = startProject({ reopen });
  const alone = { open: first.chosen ? [first.dir] : [], focus: first.dir, chosen: first.chosen };
  if (!reopen) return alone;

  const saved = openProjects();
  const named = namedFolder();
  if (named) {
    const open = saved.includes(named) ? saved : [...saved, named].slice(-MAX_OPEN);
    return { open, focus: named, chosen: true };
  }
  if (!saved.length) return alone;

  // The remembered folder is written on every switch, so it is the one that had
  // focus. If it is no longer in the strip, the head of the strip gets it.
  const focus = first.chosen && saved.includes(first.dir) ? first.dir : saved[0];
  return { open: saved, focus, chosen: true };
}

module.exports = {
  recents, remember, forget, clearRecents,
  openProjects, openProject, closeProject, setOpenProjects,
  startProject, startProjects,
  isDir, DIR, LAST, RECENT, OPEN, MAX_OPEN,
};
