/* The Changes view: everything in the project folder that git has not been
   told about yet, which after an agent has been working is most of what you
   want to look at. It shares the right column with the preview browser and the
   file tree, and reads nothing until you first switch to it.

   The list is on top, the selected file's patch fills the rest. Nothing here
   writes: staging, discarding and committing stay in the terminal, where the
   command you ran is the one you can find again tomorrow. */
'use strict';
import { $, el, icons, iconMark, toast } from './app.js';

const state = {
  files: [],
  repo: true,
  reason: null,
  error: null,
  capped: 0,
  selected: null,
  patch: null,
  mode: 'full',        // the whole file with its changes in place, or just the hunks
  blockAt: 0,
  loadingList: false,
  loadingPatch: false,
};

let started = false;
let timer = null;
let listSeq = 0;
let patchSeq = 0;

const POLL_MS = 5000;
const MAX_ROWS = 6000;   // a whole file, not three lines around each change

// ------------------------------------------------------------------ reading

async function refresh({ quiet = false } = {}) {
  const seq = ++listSeq;
  if (!quiet) { state.loadingList = true; render(); }

  const res = await window.tandem.changes.list();
  if (seq !== listSeq) return;   // a newer read already answered

  state.loadingList = false;
  state.repo = !!res?.repo;
  state.reason = res?.reason || null;
  state.error = res?.error || null;
  state.files = res?.files || [];
  state.capped = res?.capped || 0;

  // A file that stopped being changed takes the diff pane with it. One that is
  // still changed keeps its place, so a refresh under your cursor does not move
  // what you are reading.
  const still = state.files.find((f) => f.path === state.selected);
  if (!still) {
    state.selected = state.files[0]?.path || null;
    state.patch = null;
    if (state.selected) loadPatch(state.selected);
  } else {
    // The line counts are not enough to tell a stale patch from a current one:
    // swapping one line for another leaves them identical. So the open file is
    // read again on every pass, and the pane is only redrawn if what came back
    // is different from what is on screen.
    loadPatch(state.selected, { quiet: true });
  }

  render();
  window.tandemStrip?.();
}

async function loadPatch(rel, { quiet = false } = {}) {
  const seq = ++patchSeq;
  if (!quiet) { state.loadingPatch = true; renderDiff(); }

  const res = await window.tandem.changes.patch(rel, state.mode);
  if (seq !== patchSeq) return;

  const same = quiet
    && state.patch?.path === res?.path
    && state.patch?.patch === res?.patch
    && state.patch?.error === res?.error;

  state.loadingPatch = false;
  state.patch = res || null;
  if (!same) renderDiff();
}

function select(rel) {
  if (state.selected === rel) return;
  state.selected = rel;
  state.patch = null;
  renderList();
  loadPatch(rel);
}

// ------------------------------------------------------------ patch parsing

// git writes a header nobody reads on screen: the a/b paths are already in the
// row that was clicked, and the blob hashes belong to a tool, not a person.
const SKIP = /^(diff --git |index |--- |\+\+\+ |old mode |new mode |new file mode |deleted file mode |similarity index |rename |copy |Binary files )/;

function parsePatch(text) {
  const rows = [];
  let oldNo = 0;
  let newNo = 0;

  for (const line of (text || '').split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      rows.push({ kind: '@', text: hunk[3].trim() });
      continue;
    }
    if (SKIP.test(line)) continue;
    if (line.startsWith('\\')) { rows.push({ kind: '\\', text: line.slice(2) }); continue; }
    const sign = line[0];
    const body = line.slice(1);
    if (sign === '+') rows.push({ kind: '+', text: body, newNo: newNo++ });
    else if (sign === '-') rows.push({ kind: '-', text: body, oldNo: oldNo++ });
    else if (sign === ' ') rows.push({ kind: ' ', text: body, oldNo: oldNo++, newNo: newNo++ });
    else if (line === '') continue;
    else rows.push({ kind: ' ', text: line, oldNo: oldNo++, newNo: newNo++ });
  }

  // A patch that ends on its last hunk line leaves a trailing empty row.
  while (rows.length && rows[rows.length - 1].kind === ' ' && rows[rows.length - 1].text === '') rows.pop();
  return rows;
}

// ------------------------------------------------------------------ drawing

const MARK = { new: 'A', added: 'A', edited: 'M', deleted: 'D', renamed: 'R', copied: 'C', conflict: 'U' };

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function summary() {
  if (!state.repo) return '';
  if (state.error) return 'git said no';
  if (!state.files.length) return state.loadingList ? 'Reading the working tree' : 'Nothing changed';
  let added = 0;
  let removed = 0;
  for (const f of state.files) { added += f.added || 0; removed += f.removed || 0; }
  return `${plural(state.files.length, 'file', 'files')}  +${added} −${removed}`;
}

function renderList() {
  const host = $('#changes-list');
  if (!host) return;
  host.replaceChildren();

  if (!state.repo) {
    host.appendChild(emptyState(
      state.reason === 'nogit' ? 'git is not installed' : 'Not a git repository',
      state.reason === 'nogit'
        ? 'This view reads the working tree with git. Install it and reopen this tab.'
        : 'Run `git init` in the terminal and this fills in with everything you change.',
    ));
    return;
  }
  if (state.error) {
    host.appendChild(emptyState('git could not read the folder', state.error));
    return;
  }
  if (!state.files.length) {
    host.appendChild(emptyState(
      state.loadingList ? 'Reading the working tree' : 'Nothing to review',
      state.loadingList ? '' : 'Every file matches the last commit. Ask the agent for a change and it shows up here.',
    ));
    return;
  }

  for (const f of state.files) {
    const row = el('button', 'crow' + (f.path === state.selected ? ' on' : ''));
    row.appendChild(el('span', `cmark ${f.kind}`, MARK[f.kind] || 'M'));

    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : '';
    const name = f.path.slice(dir.length);
    const label = el('span', 'cpath');
    if (dir) label.appendChild(el('span', 'cdir', dir));
    label.appendChild(el('span', 'cname', name));
    row.appendChild(label);

    if (f.staged) row.appendChild(el('span', 'ctag', 'staged'));
    const nums = el('span', 'cnums');
    if (f.binary) nums.appendChild(el('span', 'cbin', 'binary'));
    else {
      if (f.added) nums.appendChild(el('span', 'cadd', `+${f.added}`));
      if (f.removed) nums.appendChild(el('span', 'cdel', `−${f.removed}`));
    }
    row.appendChild(nums);

    row.title = f.path;
    row.onclick = () => select(f.path);
    host.appendChild(row);
  }

  if (state.capped) {
    host.appendChild(el('div', 'cmore', `${state.capped} more changed files not listed`));
  }
}

function emptyState(title, detail) {
  const box = el('div', 'cempty');
  box.appendChild(el('h2', null, title));
  if (detail) box.appendChild(el('p', null, detail));
  return box;
}

let drawnPath = null;
let blocks = [];

// Where a change sits in the file is most of what makes it readable, so the
// pane shows the whole file with its changed lines marked, and the jump
// buttons walk you between them. "changes only" is still there for a small
// edit in a very long file, where the rest is just scrolling.
function setMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode;
  state.patch = null;
  drawnPath = null;
  if (state.selected) loadPatch(state.selected);
}

// The blocks are the runs of added and removed lines. Everything between them
// is the file as it stands, which is exactly what you want to read past.
function goto(index, behavior = 'smooth') {
  if (!blocks.length) return;
  state.blockAt = (index + blocks.length) % blocks.length;
  blocks.forEach((b, i) => b.classList.toggle('on', i === state.blockAt));
  blocks[state.blockAt].scrollIntoView({ block: 'center', behavior });
  const at = $('#changes-at');
  if (at) at.textContent = `${state.blockAt + 1}/${blocks.length}`;
}

function renderDiff() {
  const host = $('#changes-diff');
  if (!host) return;

  // Redrawing the same file, because it was edited again while being read,
  // should not throw away where you were in it.
  const was = host.querySelector('.cdiff');
  const same = drawnPath === state.selected;
  const keep = same ? (was?.scrollTop || 0) : 0;

  host.replaceChildren();
  blocks = [];
  drawnPath = state.selected;
  if (!state.selected) return;

  const head = el('div', 'chead');
  head.appendChild(el('span', 'chead-path', state.selected));

  const jump = el('div', 'cjump');
  const prev = el('button', 'icon tiny');
  prev.appendChild(iconMark('chevron-up'));
  prev.title = 'Previous change (Alt+Up)';
  prev.onclick = () => goto(state.blockAt - 1);
  const at = el('span', 'cat');
  at.id = 'changes-at';
  const next = el('button', 'icon tiny');
  next.appendChild(iconMark('chevron-down'));
  next.title = 'Next change (Alt+Down)';
  next.onclick = () => goto(state.blockAt + 1);
  jump.append(prev, at, next);
  head.appendChild(jump);

  const mode = el('button', 'ctoggle', state.mode === 'full' ? 'whole file' : 'changes only');
  mode.title = state.mode === 'full' ? 'Show only the changed lines' : 'Show the whole file';
  mode.onclick = () => setMode(state.mode === 'full' ? 'hunks' : 'full');
  head.appendChild(mode);

  const nav = el('div', 'nav');

  const open = el('button', 'icon');
  open.appendChild(iconMark('file-code'));
  open.title = 'Open this file in the Files tab';
  open.onclick = () => window.tandemOpenFile?.(state.selected);
  nav.appendChild(open);

  const ask = el('button', 'icon');
  ask.appendChild(iconMark('sparkles'));
  ask.title = 'Ask the agent about this change';
  ask.onclick = () => window.sendToAgent?.(`Review my uncommitted changes to \`${state.selected}\` and tell me what they do.`);
  nav.appendChild(ask);

  const copy = el('button', 'icon');
  copy.appendChild(iconMark('copy'));
  copy.title = 'Copy the patch';
  copy.onclick = async () => {
    if (!state.patch?.patch) return;
    await navigator.clipboard.writeText(state.patch.patch);
    toast('Copied', `${state.selected} as a patch`, [{ label: 'ok', primary: true }]);
  };
  nav.appendChild(copy);

  head.appendChild(nav);
  host.appendChild(head);

  const body = el('div', 'cdiff');
  host.appendChild(body);

  const p = state.patch;
  if (!p) { body.appendChild(el('div', 'cnote', state.loadingPatch ? 'Reading the file' : '')); icons(); return; }
  if (p.error) { body.appendChild(el('div', 'cnote', p.error)); icons(); return; }
  if (p.binary) { body.appendChild(el('div', 'cnote', 'A binary file. There is nothing to read line by line.')); icons(); return; }
  if (p.toobig) { body.appendChild(el('div', 'cnote', 'That file is too large to show here.')); icons(); return; }

  const rows = parsePatch(p.patch);
  if (!rows.length) {
    body.appendChild(el('div', 'cnote', 'No line changes. The file mode or its permissions changed.'));
    icons();
    return;
  }

  let block = null;
  for (const r of rows.slice(0, MAX_ROWS)) {
    const line = el('div', `dline d${r.kind === '@' ? 'hunk' : r.kind === '+' ? 'add' : r.kind === '-' ? 'del' : r.kind === '\\' ? 'note' : 'ctx'}`);
    if (r.kind === '@') {
      line.appendChild(el('span', 'dgut', ''));
      line.appendChild(el('span', 'dtext', r.text ? `⋯ ${r.text}` : '⋯'));
    } else if (r.kind === '\\') {
      line.appendChild(el('span', 'dgut', ''));
      line.appendChild(el('span', 'dtext', `⤶ ${r.text}`));
    } else {
      line.appendChild(el('span', 'dgut', r.oldNo ? String(r.oldNo) : ''));
      line.appendChild(el('span', 'dgut', r.newNo ? String(r.newNo) : ''));
      line.appendChild(el('span', 'dsign', r.kind === ' ' ? '' : r.kind));
      line.appendChild(el('span', 'dtext', r.text || ' '));
    }

    // Added and removed lines that touch each other are one change, which is
    // what the jump buttons step through and what gets the marker in the
    // margin. A file mode line or a hunk header ends the run.
    if (r.kind === '+' || r.kind === '-') {
      if (!block) { block = el('div', 'dblk'); body.appendChild(block); blocks.push(block); }
      block.appendChild(line);
    } else {
      block = null;
      body.appendChild(line);
    }
  }

  if (rows.length > MAX_ROWS) {
    body.appendChild(el('div', 'cnote', `${rows.length - MAX_ROWS} more lines. Open the file to read the rest.`));
  } else if (p.truncated) {
    body.appendChild(el('div', 'cnote', 'The rest of this file was too long to send.'));
  }

  at.textContent = blocks.length ? `${Math.min(state.blockAt, blocks.length - 1) + 1}/${blocks.length}` : '0';
  prev.disabled = next.disabled = blocks.length < 2;

  // A file you just clicked opens on its first change, not on line one: in a
  // long file the changed lines are usually nowhere near the top.
  if (same && keep) {
    requestAnimationFrame(() => { body.scrollTop = keep; });
    if (blocks.length) blocks[Math.min(state.blockAt, blocks.length - 1)].classList.add('on');
  } else {
    state.blockAt = 0;
    requestAnimationFrame(() => goto(0, 'auto'));
  }
  icons();
}

function render() {
  const label = $('#changes-summary');
  if (label) label.textContent = summary();
  renderList();
  renderDiff();
  icons();
}

// ------------------------------------------------------------------- events

$('#changes-refresh').onclick = () => refresh();
$('#close-changes').onclick = () => window.tandemCloseRight?.();

// Alt and an arrow walks the changes in the open file. Plain keys would fight
// with the chat box, which is one Tab away from here.
window.addEventListener('keydown', (e) => {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  if ($('#changes-view')?.hidden) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); goto(state.blockAt + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); goto(state.blockAt - 1); }
});

// One read every few seconds while the pane is on screen. git status on a
// project this size costs a few milliseconds, and the alternative is a pane
// that quietly goes stale while the agent works.
function poll(on) {
  clearInterval(timer);
  timer = on ? setInterval(() => { if (!document.hidden) refresh({ quiet: true }); }, POLL_MS) : null;
}

let burst = null;
window.tandem.files.onChanged(() => {
  if (!started) return;
  clearTimeout(burst);
  burst = setTimeout(() => refresh({ quiet: true }), 400);
});

window.tandem.project.onChanged(() => {
  state.files = [];
  state.selected = null;
  state.patch = null;
  drawnPath = null;
  if (started) refresh();
  else render();
  window.tandemStrip?.();
});

// app.js calls these as the right column switches. Nothing is read until the
// tab is first opened, and the timer only runs while it is the view on screen.
window.tandemChanges = {
  activate() {
    started = true;
    refresh({ quiet: state.files.length > 0 });
    poll(true);
  },
  deactivate() {
    poll(false);
  },
  count: () => (state.repo && !state.error ? state.files.length : 0),
  open(rel) {
    started = true;
    state.selected = rel;
    state.patch = null;
    loadPatch(rel);
    render();
  },
};

render();
