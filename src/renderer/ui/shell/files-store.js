/* Everything the Files view knows: which folders are expanded, what main sent
   back for each of them, what the filter matched, and the one file being read.
   Nothing here writes to disk.

   One window holds several projects open and shows one of them at a time, so
   all of that is per project. `filesState` is the window onto whichever folder
   has focus: the view reads `filesState.tree` and friends exactly as it always
   did, and only where those objects come from has moved. Coming back to a
   project puts the same three objects back, so the tree, the file and the
   filter are where you left them.

   Same shape as browser-store: a mutable object, a version counter for
   useSyncExternalStore, and changed() to bump it. */
'use strict';
import { act } from './layout-store.js';

/* Dotfiles are a way of looking rather than a fact about a folder, so this one
   flag is a window preference and not a project one. Asking for them in one
   project and finding them hidden in the next is answering the same question
   twice. It lives out here and the view still reads it off `tree`, where it has
   always been. */
let showHidden = false;

function blank(dir) {
  const tree = {
    open: new Set(['']),   // folders currently expanded; '' is the project root
    kids: new Map(),       // folder path -> the listing main sent back
    loading: new Set(),
    selected: null,
  };
  Object.defineProperty(tree, 'showHidden', { get: () => showHidden, enumerable: true });

  return {
    dir,
    tree,
    // The file on screen and what main read back for it. `data` is null while
    // the read is out.
    view: { path: null, data: null },
    search: { query: '', result: null },
    // A folder that changes while its listing is still in flight would
    // otherwise lose that change: main coalesces a burst into one event, so
    // there is no second event coming to fix it. Mark it and read it again when
    // the first read lands.
    stale: new Set(),
    // Folders that changed while some other project had focus, replayed on the
    // way back.
    dirty: new Set(),
    started: false,   // has this project's root been listed yet
    seq: 0,           // the search this project is waiting on
    typing: null,     // its debounce timer
  };
}

// Every project that is open, and the one on screen.
const projects = new Map();
let current = blank(null);
let shown = false;   // has the pane been looked at at all

export const filesState = {
  tree: current.tree,
  view: current.view,
  search: current.search,
};

const listeners = new Set();
let version = 0;

export const getFilesVersion = () => version;

export function subscribeFiles(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function changed() {
  version += 1;
  for (const fn of listeners) fn();
}

// A reply for a project nobody is looking at changes nothing on screen, so it
// does not need to cost a render.
const touch = (st) => { if (st === current) changed(); };

// ---------------------------------------------------------------- the tree

async function loadDir(st, rel) {
  if (st.tree.loading.has(rel)) { st.stale.add(rel); return; }
  st.tree.loading.add(rel);
  touch(st);
  // The project goes with the call. Letting main answer for whatever has focus
  // by the time it reads this is how a reply that raced a focus change pours
  // one project's folders into another's tree.
  const res = await window.tandem.files.list(rel, st.dir);
  st.tree.loading.delete(rel);
  st.tree.kids.set(rel, res);
  touch(st);
  if (st.stale.delete(rel)) loadDir(st, rel);
}

// Main keeps one watch set per project, so each of them syncs its own. Sending
// the whole set on every change is cheaper than tracking the difference here.
const syncWatch = (st) => window.tandem.files.watch([...st.tree.open], st.dir);

// The root is listed the first time somebody looks at the project, not when it
// opens. Four folders in the strip should not mean four folder walks for the
// three of them nobody has asked about.
function start(st) {
  if (!shown || !st.dir || st.started) return;
  st.started = true;
  loadDir(st, '');
  syncWatch(st);
}

/* One folder changed on disk. Reload it if it is expanded, and drop its listing
   if it is not, so a folder opened later is read fresh rather than shown as it
   was an hour ago. The file being read may be the one that changed, and
   re-reading a file in a folder that did not change would be a waste, so this
   checks the parent. */
function absorb(st, dir) {
  if (st.tree.open.has(dir)) loadDir(st, dir);
  else st.tree.kids.delete(dir);

  const path = st.view.path;
  if (!path) return;
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  if (parent === dir) read(st, path, true);
}

/* What landed while this project was off screen. It is replayed on the way back
   rather than as it arrives, because a project can churn for a long time behind
   your back, a build or a branch switch, and reacting live would cost a listing
   per expanded folder for a tree nobody can see. Waiting loses nothing: the
   tree only has to be right where somebody is looking. */
function catchUp(st) {
  if (!st.dirty.size) return;
  const dirs = [...st.dirty];
  st.dirty.clear();
  for (const dir of dirs) absorb(st, dir);
  if (st.search.query.trim()) runSearch(st, st.search.query.trim());
}

export function toggleDir(rel) {
  const st = current;
  if (st.tree.open.has(rel)) st.tree.open.delete(rel);
  else {
    st.tree.open.add(rel);
    if (!st.tree.kids.has(rel)) loadDir(st, rel);
  }
  changed();
  syncWatch(st);
}

export function toggleHidden() {
  showHidden = !showHidden;
  changed();
}

// Reload everything already on screen. Folders that were collapsed are dropped
// so a refresh does not quietly keep a stale listing around for later.
export function refreshAll() {
  const st = current;
  st.dirty.clear();   // all of it is being read again, so there is nothing left to replay
  for (const rel of [...st.tree.kids.keys()]) {
    if (st.tree.open.has(rel)) loadDir(st, rel);
    else st.tree.kids.delete(rel);
  }
  if (st.view.path) read(st, st.view.path, true);
  if (st.search.query.trim()) runSearch(st, st.search.query.trim());
}

/* The expanded tree flattened into the rows to draw, depth included. Every row
   carries a key, because a folder can contribute two notes of its own and React
   needs to tell them apart from its children's. */
export function visibleRows() {
  const { tree } = current;
  const rows = [];

  const walk = (rel, depth) => {
    const node = tree.kids.get(rel);
    if (!node) {
      if (tree.loading.has(rel)) rows.push({ kind: 'note', key: `${rel}:reading`, depth, text: 'reading…', loading: true });
      return;
    }
    if (node.error) { rows.push({ kind: 'note', key: `${rel}:error`, depth, text: node.error, bad: true }); return; }

    let drawn = 0;
    for (const entry of node.entries) {
      if (entry.hidden && !showHidden) continue;
      drawn += 1;
      rows.push({ kind: 'entry', key: entry.path, depth, entry });
      if (entry.dir && tree.open.has(entry.path)) walk(entry.path, depth + 1);
    }
    if (!drawn) {
      rows.push({
        kind: 'note',
        key: `${rel}:none`,
        depth,
        text: node.entries.length ? 'only dotfiles in here' : 'empty folder',
      });
    }
    if (node.truncated) rows.push({ kind: 'note', key: `${rel}:truncated`, depth, text: 'too many entries to list them all' });
  };

  walk('', 0);
  return rows;
}

// --------------------------------------------------------------- searching

async function runSearch(st, query) {
  const mine = ++st.seq;
  if (!query) { st.search.result = null; touch(st); return; }

  const res = await window.tandem.files.search(query, st.dir);
  // Results belong to the query that asked for them, in the project that asked.
  // Holding the old ones while a new query is in flight is how Enter opens the
  // wrong file.
  if (mine !== st.seq || st.search.query.trim() !== query) return;
  st.search.result = res;
  touch(st);
}

export function setQuery(text) {
  const st = current;
  const q = text.trim();
  // Between this keystroke and the debounced search, anything already on screen
  // answers a question nobody is asking any more.
  if (q !== st.search.query.trim()) st.search.result = null;
  st.search.query = text;
  changed();

  clearTimeout(st.typing);
  // A keystroke costs a walk of the folder on the first press and a scan of a
  // cached list after that, so this only needs to be long enough to skip the
  // middle of a word.
  st.typing = setTimeout(() => runSearch(st, q), 90);
}

export function clearQuery() {
  const st = current;
  clearTimeout(st.typing);
  st.search.query = '';
  runSearch(st, '');
}

// ---------------------------------------------------------------- the file

/* Where the file is drawn, handed over by the view. Re-reading a file because
   it changed on disk should leave you on the line you were reading, and the
   scroll position lives on the element rather than in this object. There is one
   element for all the projects, because there is one pane. */
let body = null;
let restoreTo = 0;

export const setFileBody = (el) => { body = el; };
export const restoreScroll = () => { if (body) body.scrollTop = restoreTo; };

async function read(st, rel, keepScroll) {
  restoreTo = keepScroll && body ? body.scrollTop : 0;

  st.view.path = rel;
  st.view.data = null;
  st.tree.selected = rel;
  touch(st);

  let data;
  try {
    data = await window.tandem.files.read(rel, st.dir);
  } catch (e) {
    data = { error: e.message || 'could not read that file' };
  }
  if (st.view.path !== rel) return; // another row was clicked while this one read
  st.view.data = data;
  touch(st);
}

export function openFile(rel, { keepScroll = false } = {}) {
  return read(current, rel, keepScroll);
}

export function closeFile() {
  current.view.path = null;
  current.view.data = null;
  changed();
}

export async function copyPath() {
  const path = current.view.path;
  await navigator.clipboard.writeText(path);
  act('toast', 'Copied', path, [{ label: 'ok', primary: true }]);
}

// reveal, openExternal and absolute act on the focused project, which is the
// one this file came from, so they take a path and nothing else.
export async function revealFile() {
  const res = await window.tandem.files.reveal(current.view.path);
  if (res?.error) act('toast', 'Could not show that file', res.error, [{ label: 'ok', primary: true }]);
}

export async function openExternal() {
  const res = await window.tandem.files.openExternal(current.view.path);
  if (res?.error) act('toast', 'Nothing on this machine opens that', res.error, [{ label: 'ok', primary: true }]);
}

export function askAboutFile() {
  const path = current.view.path;
  if (!path) return;
  window.sendToAgent?.(`Read \`${path}\` and tell me what it does.`);
}

// ------------------------------------------------------------ highlighting

/* Shiki is already in the bundle for the chat pane's code blocks, so this costs
   a chunk load the first time a file is opened and nothing after that. Both
   themes are baked into the markup and the stylesheet picks one, which means
   switching light and dark does not mean highlighting the file again.

   The JavaScript regex engine, not the default Oniguruma one: the WASM build
   needs 'wasm-unsafe-eval' in the page's script-src, and this window's CSP does
   not grant it. The JS engine covers every grammar in the bundle and is fast
   enough for a file this pane will agree to open. */
export const HIGHLIGHT_LIMIT = 200 * 1024;

let shiki = null;
const loaded = new Set();

async function highlighter() {
  if (!shiki) {
    shiki = (async () => {
      const [{ createHighlighter }, { createJavaScriptRegexEngine }] = await Promise.all([
        import('shiki'),
        import('shiki/engine/javascript'),
      ]);
      return createHighlighter({
        themes: ['github-light', 'github-dark'],
        langs: [],
        engine: createJavaScriptRegexEngine({ forgiving: true }),
      });
    })();
  }
  return shiki;
}

export async function highlight(text, lang) {
  const hl = await highlighter();
  if (!loaded.has(lang)) {
    await hl.loadLanguage(lang);
    loaded.add(lang);
  }
  return hl.codeToHtml(text, {
    lang,
    themes: { light: 'github-light', dark: 'github-dark' },
    defaultColor: 'light',
  });
}

// -------------------------------------------------------------- the wiring

// A folder changing on disk only matters for the folders that are on screen.
// Main debounces the burst an editor makes when it saves, so this is one call
// per real change. Every project has a src/, so the folder path does not say
// whose change this is: `root` does.
window.tandem.files.onChanged(({ dir, root }) => {
  const st = projects.get(root);
  if (!st || !st.started) return;   // a project nobody has looked at has no tree to correct
  if (st !== current) { st.dirty.add(dir); return; }

  absorb(st, dir);
  if (st.search.query.trim()) runSearch(st, st.search.query.trim());
});

/* The window announces its projects whenever the set, the order or the focused
   one moves, and most of that is somebody else's business. Focus is this pane's:
   it swaps which project's three objects the view is reading. A project that
   closed is dropped, because there is nothing to come back to and its listings
   would otherwise sit in memory as long as the window does. */
function apply(info) {
  for (const [dir, st] of projects) {
    if ((info?.projects || []).some((p) => p.dir === dir)) continue;
    clearTimeout(st.typing);
    projects.delete(dir);
  }

  const next = info?.focused || null;
  if (next === current.dir) return;

  let st = next ? projects.get(next) : null;
  if (next && !st) { st = blank(next); projects.set(next, st); }

  current = st || blank(null);
  filesState.tree = current.tree;
  filesState.view = current.view;
  filesState.search = current.search;
  changed();

  start(current);
  catchUp(current);
}

/* Nothing can be listed before the window says which folder has focus, because
   every call carries its project. The window is asked once and tells us after
   that, so if it has already told us by the time the answer lands, the answer
   is the older of the two and goes in the bin. */
const ready = window.tandem.project.info()
  .then((info) => { if (!current.dir) apply(info); })
  .catch(() => { /* the next announcement says the same thing */ });

window.tandem.project.onChanged(apply);

// Nothing is read until the pane is first shown. app.js calls this when the
// Files tab takes the right column.
window.tandemFiles = {
  activate() {
    if (shown) return;
    shown = true;
    ready.then(() => start(current));
  },
  open(rel) {
    shown = true;
    // The tree behind the file is listed too, so closing the file leaves you
    // somewhere rather than in an empty pane.
    ready.then(() => { start(current); read(current, rel, false); });
  },
};
