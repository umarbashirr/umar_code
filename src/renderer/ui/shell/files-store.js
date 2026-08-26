/* Everything the Files view knows: which folders are expanded, what main sent
   back for each of them, what the filter matched, and the one file being read.
   Nothing here writes to disk.

   Same shape as browser-store: a mutable object, a version counter for
   useSyncExternalStore, and changed() to bump it. */
'use strict';
import { act } from './layout-store.js';

export const filesState = {
  tree: {
    open: new Set(['']),   // folders currently expanded; '' is the project root
    kids: new Map(),       // folder path -> the listing main sent back
    loading: new Set(),
    showHidden: false,
    selected: null,
  },
  // The file on screen and what main read back for it. `data` is null while the
  // read is out.
  view: { path: null, data: null },
  search: { query: '', result: null },
};

const { search, tree, view } = filesState;

let started = false;

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

// ---------------------------------------------------------------- the tree

// A folder that changes while its listing is still in flight would otherwise
// lose that change: main coalesces a burst into one event, so there is no second
// event coming to fix it. Mark it and read it again when the first read lands.
const stale = new Set();

async function loadDir(rel) {
  if (tree.loading.has(rel)) { stale.add(rel); return; }
  tree.loading.add(rel);
  changed();
  const res = await window.tandem.files.list(rel);
  tree.loading.delete(rel);
  tree.kids.set(rel, res);
  changed();
  if (stale.delete(rel)) loadDir(rel);
}

// Main keeps one watch per expanded folder. Sending the whole set on every
// change is cheaper than tracking the difference on this side.
const syncWatch = () => window.tandem.files.watch([...tree.open]);

export function toggleDir(rel) {
  if (tree.open.has(rel)) tree.open.delete(rel);
  else {
    tree.open.add(rel);
    if (!tree.kids.has(rel)) loadDir(rel);
  }
  changed();
  syncWatch();
}

export function toggleHidden() {
  tree.showHidden = !tree.showHidden;
  changed();
}

// Reload everything already on screen. Folders that were collapsed are dropped
// so a refresh does not quietly keep a stale listing around for later.
export function refreshAll() {
  for (const rel of [...tree.kids.keys()]) {
    if (tree.open.has(rel)) loadDir(rel);
    else tree.kids.delete(rel);
  }
  if (view.path) openFile(view.path, { keepScroll: true });
  if (search.query.trim()) runSearch(search.query.trim());
}

/* The expanded tree flattened into the rows to draw, depth included. Every row
   carries a key, because a folder can contribute two notes of its own and React
   needs to tell them apart from its children's. */
export function visibleRows() {
  const rows = [];

  const walk = (rel, depth) => {
    const node = tree.kids.get(rel);
    if (!node) {
      if (tree.loading.has(rel)) rows.push({ kind: 'note', key: `${rel}:reading`, depth, text: 'reading…', loading: true });
      return;
    }
    if (node.error) { rows.push({ kind: 'note', key: `${rel}:error`, depth, text: node.error, bad: true }); return; }

    let shown = 0;
    for (const entry of node.entries) {
      if (entry.hidden && !tree.showHidden) continue;
      shown += 1;
      rows.push({ kind: 'entry', key: entry.path, depth, entry });
      if (entry.dir && tree.open.has(entry.path)) walk(entry.path, depth + 1);
    }
    if (!shown) {
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

let seq = 0;
let typing = null;

async function runSearch(query) {
  const mine = ++seq;
  if (!query) { search.result = null; changed(); return; }

  const res = await window.tandem.files.search(query);
  // Results belong to the query that asked for them. Holding the old ones while
  // a new query is in flight is how Enter opens the wrong file.
  if (mine !== seq || search.query.trim() !== query) return;
  search.result = res;
  changed();
}

export function setQuery(text) {
  const q = text.trim();
  // Between this keystroke and the debounced search, anything already on screen
  // answers a question nobody is asking any more.
  if (q !== search.query.trim()) search.result = null;
  search.query = text;
  changed();

  clearTimeout(typing);
  // A keystroke costs a walk of the folder on the first press and a scan of a
  // cached list after that, so this only needs to be long enough to skip the
  // middle of a word.
  typing = setTimeout(() => runSearch(q), 90);
}

export function clearQuery() {
  clearTimeout(typing);
  search.query = '';
  runSearch('');
}

// ---------------------------------------------------------------- the file

/* Where the file is drawn, handed over by the view. Re-reading a file because
   it changed on disk should leave you on the line you were reading, and the
   scroll position lives on the element rather than in this object. */
let body = null;
let restoreTo = 0;

export const setFileBody = (el) => { body = el; };
export const restoreScroll = () => { if (body) body.scrollTop = restoreTo; };

export async function openFile(rel, { keepScroll = false } = {}) {
  restoreTo = keepScroll && body ? body.scrollTop : 0;

  view.path = rel;
  view.data = null;
  tree.selected = rel;
  changed();

  let data;
  try {
    data = await window.tandem.files.read(rel);
  } catch (e) {
    data = { error: e.message || 'could not read that file' };
  }
  if (view.path !== rel) return; // another row was clicked while this one read
  view.data = data;
  changed();
}

export function closeFile() {
  view.path = null;
  view.data = null;
  changed();
}

export async function copyPath() {
  await navigator.clipboard.writeText(view.path);
  act('toast', 'Copied', view.path, [{ label: 'ok', primary: true }]);
}

export async function revealFile() {
  const res = await window.tandem.files.reveal(view.path);
  if (res?.error) act('toast', 'Could not show that file', res.error, [{ label: 'ok', primary: true }]);
}

export async function openExternal() {
  const res = await window.tandem.files.openExternal(view.path);
  if (res?.error) act('toast', 'Nothing on this machine opens that', res.error, [{ label: 'ok', primary: true }]);
}

export function askAboutFile() {
  if (!view.path) return;
  window.sendToAgent?.(`Read \`${view.path}\` and tell me what it does.`);
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
// per real change.
window.tandem.files.onChanged(({ dir }) => {
  if (tree.open.has(dir)) loadDir(dir);
  if (search.query.trim()) runSearch(search.query.trim());

  // The file being read may be the one that just changed. Re-reading a file in
  // a folder that did not change would be a waste, so this checks the parent.
  if (view.path) {
    const parent = view.path.includes('/') ? view.path.slice(0, view.path.lastIndexOf('/')) : '';
    if (parent === dir) openFile(view.path, { keepScroll: true });
  }
});

// Switching project folder invalidates the whole tree: different root, different
// files, and main has already dropped its watches.
window.tandem.project.onChanged(() => {
  tree.open = new Set(['']);
  tree.kids.clear();
  tree.selected = null;
  view.path = null;
  view.data = null;
  search.query = '';
  search.result = null;
  if (started) { loadDir(''); syncWatch(); }
  changed();
});

// Nothing is read until the pane is first shown. app.js calls this when the
// Files tab takes the right column.
window.tandemFiles = {
  activate() {
    if (started) return;
    started = true;
    loadDir('');
    syncWatch();
  },
  open(rel) {
    started = true;
    openFile(rel);
  },
};
