/* The Files view: the project folder as a tree, and a read-only look at
   whatever you click. It shares the right column with the preview browser and
   is switched to from the same row of tabs, so only one of the two is on screen
   at a time. Nothing here writes to disk. */
'use strict';
import { $, el, icons, iconMark, toast } from './app.js';

const tree = {
  open: new Set(['']),   // folders currently expanded; '' is the project root
  kids: new Map(),       // folder path -> the listing main sent back
  loading: new Set(),
  showHidden: false,
  selected: null,
};

const view = { path: null, data: null, pending: null };
const search = { query: '', result: null, seq: 0 };

let started = false;

// ------------------------------------------------------------------ helpers

const KB = 1024;
function size(n) {
  if (n < KB) return `${n} B`;
  if (n < KB * KB) return `${(n / KB).toFixed(n < 10 * KB ? 1 : 0)} KB`;
  return `${(n / KB / KB).toFixed(1)} MB`;
}

const CODE = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'vue', 'svelte', 'astro',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp',
  'cs', 'php', 'lua', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'sql', 'graphql',
  'css', 'scss', 'less', 'html', 'htm', 'xml', 'ex', 'exs', 'hs', 'clj', 'scala',
]);
const IMAGES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg']);
const TEXTISH = new Set(['md', 'mdx', 'markdown', 'txt', 'log', 'yml', 'yaml', 'toml', 'ini', 'env', 'csv']);

function fileIcon(name) {
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  if (ext === 'json' || ext === 'jsonc') return 'file-json';
  if (IMAGES.has(ext)) return 'file-image';
  if (CODE.has(ext)) return 'file-code';
  if (TEXTISH.has(ext)) return 'file-text';
  return 'file';
}

// ---------------------------------------------------------------- the tree

// A folder that changes while its listing is still in flight would otherwise
// lose that change: main coalesces a burst into one event, so there is no second
// event coming to fix it. Mark it and read it again when the first read lands.
const stale = new Set();

async function loadDir(rel) {
  if (tree.loading.has(rel)) { stale.add(rel); return; }
  tree.loading.add(rel);
  render();
  const res = await window.tandem.files.list(rel);
  tree.loading.delete(rel);
  tree.kids.set(rel, res);
  render();
  if (stale.delete(rel)) loadDir(rel);
}

function toggleDir(rel) {
  if (tree.open.has(rel)) tree.open.delete(rel);
  else {
    tree.open.add(rel);
    if (!tree.kids.has(rel)) loadDir(rel);
  }
  render();
  syncWatch();
}

// Main keeps one watch per expanded folder. Sending the whole set on every
// change is cheaper than tracking the difference on this side.
const syncWatch = () => window.tandem.files.watch([...tree.open]);

// Reload everything already on screen. Folders that were collapsed are dropped
// so a refresh does not quietly keep a stale listing around for later.
function refreshAll() {
  for (const rel of [...tree.kids.keys()]) {
    if (tree.open.has(rel)) loadDir(rel);
    else tree.kids.delete(rel);
  }
  if (view.path) openFile(view.path, { keepScroll: true });
  if (search.query) runSearch(search.query);
}

function visibleRows() {
  const rows = [];

  const walk = (rel, depth) => {
    const node = tree.kids.get(rel);
    if (!node) {
      if (tree.loading.has(rel)) rows.push({ kind: 'note', depth, text: 'reading…' });
      return;
    }
    if (node.error) { rows.push({ kind: 'note', depth, text: node.error, bad: true }); return; }

    let shown = 0;
    for (const entry of node.entries) {
      if (entry.hidden && !tree.showHidden) continue;
      shown += 1;
      rows.push({ kind: 'entry', depth, entry });
      if (entry.dir && tree.open.has(entry.path)) walk(entry.path, depth + 1);
    }
    if (!shown) {
      rows.push({
        kind: 'note',
        depth,
        text: node.entries.length ? 'only dotfiles in here' : 'empty folder',
      });
    }
    if (node.truncated) rows.push({ kind: 'note', depth, text: 'too many entries to list them all' });
  };

  walk('', 0);
  return rows;
}

function renderTree() {
  const box = $('#file-tree');
  box.innerHTML = '';

  for (const row of visibleRows()) {
    if (row.kind === 'note') {
      const note = el('div', 'ftree-note' + (row.bad ? ' bad' : ''), row.text);
      note.style.paddingLeft = `${10 + row.depth * 14}px`;
      box.appendChild(note);
      continue;
    }

    const { entry } = row;
    const node = el('div', 'ftree-row'
      + (entry.dir ? ' dir' : '')
      + (entry.hidden ? ' faint' : '')
      + (tree.selected === entry.path ? ' on' : ''));
    node.style.paddingLeft = `${8 + row.depth * 14}px`;

    if (entry.dir) {
      node.appendChild(iconMark(tree.open.has(entry.path) ? 'chevron-down' : 'chevron-right'));
      node.appendChild(iconMark(tree.open.has(entry.path) ? 'folder-open' : 'folder'));
    } else {
      node.appendChild(el('span', 'ftree-gap'));
      node.appendChild(iconMark(fileIcon(entry.name)));
    }

    node.appendChild(el('span', 'ftree-name', entry.name));
    if (!entry.dir) node.appendChild(el('span', 'ftree-size', size(entry.size)));
    node.title = entry.link ? `${entry.path} (symlink)` : entry.path;
    node.onclick = () => (entry.dir ? toggleDir(entry.path) : openFile(entry.path));
    box.appendChild(node);
  }

  icons();
}

// --------------------------------------------------------------- searching

async function runSearch(query) {
  const seq = ++search.seq;
  const same = query === search.query;
  search.query = query;
  // Results belong to the query that asked for them. Holding the old ones while
  // a new query is in flight is how Enter opens the wrong file.
  if (!same) search.result = null;
  if (!query) { search.result = null; render(); return; }

  const res = await window.tandem.files.search(query);
  if (seq !== search.seq || search.query !== query) return; // a later keystroke won
  search.result = res;
  render();
}

function renderSearch() {
  const box = $('#file-tree');
  box.innerHTML = '';
  const res = search.result;

  if (!res) { box.appendChild(el('div', 'ftree-note', 'looking…')); return; }
  if (!res.matches.length) {
    box.appendChild(el('div', 'ftree-note', `nothing named like "${search.query}"`));
    if (res.capped) box.appendChild(el('div', 'ftree-note', 'the folder was too big to index all of it'));
    return;
  }

  box.appendChild(el('div', 'ftree-note', res.total > res.matches.length
    ? `${res.matches.length} of ${res.total} matches`
    : `${res.total} match${res.total === 1 ? '' : 'es'}`));

  for (const m of res.matches) {
    const dir = m.path.slice(0, m.path.length - m.name.length).replace(/\/$/, '');
    const node = el('div', 'ftree-row' + (tree.selected === m.path ? ' on' : ''));
    node.style.paddingLeft = '8px';
    node.appendChild(el('span', 'ftree-gap'));
    node.appendChild(iconMark(fileIcon(m.name)));
    node.appendChild(el('span', 'ftree-name', m.name));
    if (dir) node.appendChild(el('span', 'ftree-dir', dir));
    node.title = m.path;
    node.onclick = () => openFile(m.path);
    box.appendChild(node);
  }

  icons();
}

// ---------------------------------------------------------------- the file

async function openFile(rel, { keepScroll = false } = {}) {
  const body = $('#file-view');
  const scroll = keepScroll ? body.scrollTop : 0;

  view.path = rel;
  view.data = null;
  tree.selected = rel;
  render();

  let data;
  try {
    data = await window.tandem.files.read(rel);
  } catch (e) {
    data = { error: e.message || 'could not read that file' };
  }
  if (view.path !== rel) return; // another row was clicked while this one read
  view.data = data;
  render();
  body.scrollTop = scroll;
}

function closeFile() {
  view.path = null;
  view.data = null;
  drawn = null;
  render();
}

// Shiki is already in the bundle for the chat pane's code blocks, so this costs
// a chunk load the first time a file is opened and nothing after that. Both
// themes are baked into the markup and the stylesheet picks one, which means
// switching light and dark does not mean highlighting the file again.
//
// The JavaScript regex engine, not the default Oniguruma one: the WASM build
// needs 'wasm-unsafe-eval' in the page's script-src, and this window's CSP does
// not grant it. The JS engine covers every grammar in the bundle and is fast
// enough for a file this pane will agree to open.
const HIGHLIGHT_LIMIT = 200 * 1024;
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

async function highlight(text, lang) {
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

// The fallback and the Shiki output share a shape, so the line-number rule in
// the stylesheet works for both.
function plainCode(text) {
  const pre = el('pre', 'shiki plain');
  const code = el('code');
  // No trailing newline: the line spans are laid out as blocks, so one would
  // show up as an extra empty row under every line.
  for (const line of text.split('\n')) code.appendChild(el('span', 'line', line));
  pre.appendChild(code);
  return pre;
}

// What the viewer currently has on screen. A folder changing three levels away
// still calls render(), and without this the open file would be torn down,
// rebuilt as plain text and tokenised again every time.
let drawn = null;

function renderFile() {
  const box = $('#file-view');
  const head = $('#file-head');
  head.hidden = false;
  if (drawn && drawn.path === view.path && drawn.data === view.data) return;
  drawn = { path: view.path, data: view.data };

  $('#fh-path').textContent = view.path;
  $('#fh-path').title = view.path;

  const d = view.data;
  if (!d) {
    $('#fh-meta').textContent = '';
    box.replaceChildren(el('div', 'fv-note', 'reading…'));
    return;
  }

  if (d.error) {
    $('#fh-meta').textContent = '';
    box.replaceChildren(el('div', 'fv-note bad', d.error));
    return;
  }

  const bits = [size(d.size)];
  if (d.kind === 'text') bits.push(`${d.lines} line${d.lines === 1 ? '' : 's'}`, d.lang);
  $('#fh-meta').textContent = bits.join(' · ');

  if (d.kind === 'image') {
    const wrap = el('div', 'fv-image');
    const img = el('img');
    img.src = d.dataUrl;
    img.alt = d.name;
    wrap.appendChild(img);
    box.replaceChildren(wrap);
    return;
  }

  if (d.kind === 'binary' || d.kind === 'toobig') {
    const wrap = el('div', 'fv-note');
    wrap.appendChild(iconMark('binary'));
    wrap.appendChild(el('p', null, d.kind === 'binary'
      ? 'This is a binary file, so there is nothing useful to show.'
      : `This file is ${size(d.size)}, past what this pane will read into memory.`));
    const open = el('button', 'fv-action', 'Open with the system app');
    open.onclick = () => window.tandem.files.openExternal(view.path);
    wrap.appendChild(open);
    box.replaceChildren(wrap);
    icons();
    return;
  }

  const parts = [];

  // An SVG is a picture and a file you edit, so it gets both.
  if (d.svg) {
    const wrap = el('div', 'fv-image svg');
    const img = el('img');
    img.src = d.svg;
    img.alt = d.name;
    wrap.appendChild(img);
    parts.push(wrap);
  }

  if (!d.text.length) {
    parts.push(el('div', 'fv-note', 'empty file'));
    box.replaceChildren(...parts);
    return;
  }

  const holder = el('div', 'fv-code');
  holder.appendChild(plainCode(d.text));
  parts.push(holder);
  box.replaceChildren(...parts);

  if (d.text.length > HIGHLIGHT_LIMIT || d.lang === 'text') return;

  const at = view.path;
  highlight(d.text, d.lang).then((html) => {
    // Shiki escapes what it emits, and the only input is the file on disk.
    if (view.path === at) holder.innerHTML = html;
  }).catch(() => { /* a language Shiki does not carry: the plain version stands */ });
}

// ----------------------------------------------------------------- drawing

function render() {
  const showingFile = !!view.path;
  $('#file-view').hidden = !showingFile;
  $('#file-tree').hidden = showingFile;
  $('#file-head').hidden = !showingFile;

  if (showingFile) return renderFile();
  if (search.query) return renderSearch();
  renderTree();
}

// --------------------------------------------------------------- the wiring

const filter = $('#file-filter');
let typing = null;

filter.addEventListener('input', () => {
  const q = filter.value.trim();
  $('#file-filter-clear').hidden = !q;
  // Between this keystroke and the debounced search, anything already on screen
  // answers a question nobody is asking any more.
  if (q !== search.query) { search.query = q; search.result = null; render(); }
  clearTimeout(typing);
  // A keystroke costs a walk of the folder on the first press and a scan of a
  // cached list after that, so this only needs to be long enough to skip the
  // middle of a word.
  typing = setTimeout(() => runSearch(q), 90);
});

filter.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { filter.value = ''; $('#file-filter-clear').hidden = true; runSearch(''); }
  // Enter on a single match is the whole point of typing a filename.
  if (e.key === 'Enter' && search.result?.matches.length) openFile(search.result.matches[0].path);
});

$('#file-filter-clear').onclick = () => {
  filter.value = '';
  $('#file-filter-clear').hidden = true;
  runSearch('');
  filter.focus();
};

$('#files-refresh').onclick = () => refreshAll();

$('#files-hidden').onclick = () => {
  tree.showHidden = !tree.showHidden;
  const btn = $('#files-hidden');
  btn.classList.toggle('armed', tree.showHidden);
  btn.title = tree.showHidden ? 'Hide dotfiles' : 'Show dotfiles';
  btn.replaceChildren(iconMark(tree.showHidden ? 'eye' : 'eye-off'));
  icons();
  render();
};

$('#file-back').onclick = () => closeFile();

$('#file-copy').onclick = async () => {
  await navigator.clipboard.writeText(view.path);
  toast('Copied', view.path, [{ label: 'ok', primary: true }]);
};

$('#file-reveal').onclick = async () => {
  const res = await window.tandem.files.reveal(view.path);
  if (res?.error) toast('Could not show that file', res.error, [{ label: 'ok', primary: true }]);
};

$('#file-external').onclick = async () => {
  const res = await window.tandem.files.openExternal(view.path);
  if (res?.error) toast('Nothing on this machine opens that', res.error, [{ label: 'ok', primary: true }]);
};

$('#file-ask').onclick = () => {
  if (!view.path) return;
  window.sendToAgent?.(`Read \`${view.path}\` and tell me what it does.`);
};

// A folder changing on disk only matters for the folders that are on screen.
// Main debounces the burst an editor makes when it saves, so this is one call
// per real change.
window.tandem.files.onChanged(({ dir }) => {
  if (tree.open.has(dir)) loadDir(dir);
  if (search.query) runSearch(search.query);

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
  filter.value = '';
  $('#file-filter-clear').hidden = true;
  search.query = '';
  search.result = null;
  if (started) { loadDir(''); syncWatch(); }
  render();
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

$('#fh-path').title = '';
render();
