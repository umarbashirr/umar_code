/* Everything the Changes view knows: what git says has changed in a project
   folder, the patch for whichever file is open there, and where in that patch
   you are.

   The window holds several folders open at once, so there is one of these per
   folder and `changesState` points at the focused one. Moving focus away and
   back finds the same file, the same patch and the same place in it, because a
   diff you were half way through reading is not something to throw away for
   looking at another project for a minute.

   Nothing here writes. Staging, discarding and committing stay in the terminal,
   where the command you ran is the one you can find again tomorrow. */
'use strict';
import { act } from './layout-store.js';

/* How you want a diff drawn, the whole file with its changes in place or the
   hunks on their own, belongs to the window and not to any one project. It is a
   way of reading rather than a fact about a folder: nothing about the folder
   you switched to says you now want the short form. Two projects each holding
   their own answer would flip the toggle under you as focus moved, which reads
   as a bug rather than as a setting. So it lives here, and every project's
   state reports it. */
let mode = 'full';

// ------------------------------------------------------------------- state

function blankState(dir) {
  return {
    dir,
    files: [],
    repo: true,
    reason: null,
    error: null,
    capped: 0,
    selected: null,
    patch: null,
    blockAt: 0,
    loadingList: false,
    loadingPatch: false,
    // The counters that drop an answer a newer read has overtaken. They sit on
    // the project rather than on the module, so one project's slow reply cannot
    // be measured against another's clock, and it has nowhere to land but the
    // state it was started from.
    listSeq: 0,
    patchSeq: 0,
    // Parsed rows, cached on the patch object. See diffGroups.
    groupedFrom: null,
    grouped: { groups: [], blocks: 0, extra: 0 },
    get mode() { return mode; },
  };
}

const byProject = new Map();

// The focused project's state. The view components read this object directly,
// and it is swapped, not copied into, so they see the new folder's list the
// moment focus moves.
export let changesState = blankState(null);

function stateFor(dir) {
  let st = byProject.get(dir);
  if (!st) { st = blankState(dir); byProject.set(dir, st); }
  return st;
}

// An answer is worth keeping if no newer read has overtaken it and the folder
// it belongs to is still open. A project that was closed while its read was in
// flight has no state left to write to.
const live = (st, seq, field) => seq === st[field] && byProject.get(st.dir) === st;

const listeners = new Set();
let version = 0;

export const getChangesVersion = () => version;

export function subscribeChanges(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function changed() {
  version += 1;
  for (const fn of listeners) fn();
}

// An answer for a folder nobody is looking at has nothing to redraw.
const changedIf = (st) => { if (st === changesState) changed(); };

let started = false;     // the pane has been opened at least once
let onScreen = false;    // and it is the view showing now
let timer = null;
let focusedDir = null;

const POLL_MS = 5000;
const MAX_ROWS = 6000;   // a whole file, not three lines around each change

// ------------------------------------------------------------------ reading

export const refresh = (opts) => readList(changesState, opts);

async function readList(st, { quiet = false } = {}) {
  if (!st.dir) return;   // the window has not said which folder it is on yet
  const seq = ++st.listSeq;
  if (!quiet) { st.loadingList = true; changedIf(st); }

  // The folder goes with the question. Letting main fall back to whatever has
  // focus means a reply that raced a focus change arrives as one project's diff
  // under another project's heading.
  const res = await window.tandem.changes.list(st.dir);
  if (!live(st, seq, 'listSeq')) return;

  st.loadingList = false;
  st.repo = !!res?.repo;
  st.reason = res?.reason || null;
  st.error = res?.error || null;
  st.files = res?.files || [];
  st.capped = res?.capped || 0;

  // A file that stopped being changed takes the diff pane with it. One that is
  // still changed keeps its place, so a refresh under your cursor does not move
  // what you are reading.
  const still = st.files.find((f) => f.path === st.selected);
  if (!still) {
    st.selected = st.files[0]?.path || null;
    st.patch = null;
    st.blockAt = 0;
    if (st.selected) readPatch(st, st.selected);
  } else {
    // Quiet because there is something on screen to keep. If the patch went
    // away, a mode change drops them, then say it is reading instead.
    readPatch(st, st.selected, { quiet: st.patch !== null });
  }

  changedIf(st);
}

async function readPatch(st, rel, { quiet = false } = {}) {
  const seq = ++st.patchSeq;
  if (!quiet) { st.loadingPatch = true; changedIf(st); }

  const res = await window.tandem.changes.patch(rel, mode, st.dir);
  if (!live(st, seq, 'patchSeq')) return;

  st.loadingPatch = false;

  // The line counts are not enough to tell a stale patch from a current one:
  // swapping one line for another leaves them identical. So the open file is
  // read again on every pass, and an answer that matches what is already on
  // screen is dropped rather than stored. Keeping the old object keeps its
  // identity, which is what the parse below caches on and what saves React
  // reconciling several thousand rows every five seconds.
  const same = quiet
    && st.patch?.path === res?.path
    && st.patch?.patch === res?.patch
    && st.patch?.error === res?.error;
  if (same) return;

  st.patch = res || null;
  changedIf(st);
}

export function selectFile(rel) {
  const st = changesState;
  if (st.selected === rel) return;
  st.selected = rel;
  st.patch = null;
  st.blockAt = 0;
  changed();
  readPatch(st, rel);
}

// Where a change sits in the file is most of what makes it readable, so the
// pane shows the whole file with its changed lines marked. "changes only" is
// still there for a small edit in a very long file, where the rest is just
// scrolling.
export function setMode(next) {
  // A ToggleGroup hands back an empty string when you click the item that is
  // already on, and there is no third state to fall into.
  if (!next || mode === next) return;
  mode = next;

  const st = changesState;
  st.patch = null;
  st.blockAt = 0;

  // Every other project is holding a patch cut the old way. Which file they
  // have open and where they were in it are still good, the text is not, so it
  // goes and is read again when you next look at that folder. Bumping the
  // counter drops the answers already in flight for the old mode too.
  for (const other of byProject.values()) {
    if (other === st) continue;
    other.patch = null;
    other.patchSeq += 1;
  }

  changed();
  if (st.selected) readPatch(st, st.selected);
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

/* The rows the pane draws, with the runs of added and removed lines gathered
   up. A run that touches itself is one change: it is what the jump buttons step
   through and what wears the marker in the margin. Anything else, a context
   line or a hunk header, ends the run.

   Cached on the patch object, because both the view and the jump buttons ask
   for this and a long file is a few thousand rows. The cache belongs to the
   project so that coming back to a folder you were reading is a lookup rather
   than a parse. */
export function diffGroups() {
  const st = changesState;
  const p = st.patch;
  if (st.groupedFrom === p) return st.grouped;
  st.groupedFrom = p;

  const rows = parsePatch(p?.patch);
  const groups = [];
  let blocks = 0;
  let run = null;

  for (const row of rows.slice(0, MAX_ROWS)) {
    if (row.kind === '+' || row.kind === '-') {
      if (!run) { run = { block: blocks++, lines: [] }; groups.push(run); }
      run.lines.push(row);
    } else {
      run = null;
      groups.push({ block: null, lines: [row] });
    }
  }

  st.grouped = { groups, blocks, extra: Math.max(0, rows.length - MAX_ROWS) };
  return st.grouped;
}

export function jumpBlock(delta) {
  const { blocks } = diffGroups();
  if (!blocks) return;
  changesState.blockAt = (changesState.blockAt + delta + blocks) % blocks;
  changed();
}

// ------------------------------------------------------------------ summary

export const MARK = { new: 'A', added: 'A', edited: 'M', deleted: 'D', renamed: 'R', copied: 'C', conflict: 'U' };

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function summary() {
  const s = changesState;
  if (!s.repo) return '';
  if (s.error) return 'git said no';
  if (!s.files.length) return s.loadingList ? 'Reading the working tree' : 'Nothing changed';
  let added = 0;
  let removed = 0;
  for (const f of s.files) { added += f.added || 0; removed += f.removed || 0; }
  return `${plural(s.files.length, 'file', 'files')}  +${added} −${removed}`;
}

export const changesCount = () => (changesState.repo && !changesState.error ? changesState.files.length : 0);

// ------------------------------------------------------------------- actions

export const openInFiles = () => {
  if (changesState.selected) window.tandemOpenFile?.(changesState.selected);
};

export function askAboutChange() {
  if (!changesState.selected) return;
  window.sendToAgent?.(`Review my uncommitted changes to \`${changesState.selected}\` and tell me what they do.`);
}

export async function copyPatch() {
  if (!changesState.patch?.patch) return;
  await navigator.clipboard.writeText(changesState.patch.patch);
  act('toast', 'Copied', `${changesState.selected} as a patch`, [{ label: 'ok', primary: true }]);
}

// ------------------------------------------------------------------- wiring

/* One read every few seconds, and only for the folder on screen. Polling every
   open project would cost a git status per project per five seconds to keep a
   pane fresh that nobody is looking at, and four of those five answers get
   thrown away.

   So the folders you are not on go stale, and stale here is not just old: an
   agent may have been rewriting one of them the whole time you were away, and
   what is in memory can be a diff of a tree that has since moved a long way.
   The answer is to read the moment focus comes back, before anything else
   happens, and to leave what you were reading on screen for the few
   milliseconds that takes. Drawing the old diff for that long is the right
   trade: it is the thing you were looking at, and the alternative is the empty
   pane this change exists to remove. The comparison in readPatch then keeps the
   patch object when the text turns out to be the same, so a folder nobody
   touched comes back exactly where you left it and React reconciles nothing. */
function poll(on) {
  clearInterval(timer);
  timer = on ? setInterval(() => { if (!document.hidden) refresh({ quiet: true }); }, POLL_MS) : null;
}

let burst = null;
window.tandem.files.onChanged(({ root } = {}) => {
  if (!started) return;
  // The watcher names the project the write landed in. Only the folder on
  // screen is being polled, so a write anywhere else is somebody else's news
  // and gets read when you go back to it.
  if (root && changesState.dir && root !== changesState.dir) return;
  clearTimeout(burst);
  burst = setTimeout(() => refresh({ quiet: true }), 400);
});

// The window says its folders have changed for opens, closes and reorders as
// well as focus moves, so this compares with the folder it last saw.
function applyInfo(info) {
  // A folder that has been closed is not coming back, and its list and patch
  // are only worth the memory while the window still has it open.
  const open = new Set((info?.projects || []).map((p) => p.dir));
  for (const dir of [...byProject.keys()]) if (!open.has(dir)) byProject.delete(dir);

  const next = info?.focused || null;
  if (next === focusedDir) return;
  focusedDir = next;
  changesState = next ? stateFor(next) : blankState(null);
  changed();

  if (onScreen) readList(changesState, { quiet: changesState.files.length > 0 });
}

window.tandem.project.onChanged(applyInfo);

// app.js calls these as the right column switches. Nothing is read until the
// tab is first opened, and the timer only runs while it is the view on screen.
window.tandemChanges = {
  activate() {
    started = true;
    onScreen = true;
    poll(true);

    if (focusedDir) { refresh({ quiet: changesState.files.length > 0 }); return; }

    // First open, and no focus event has arrived yet, so ask which folder the
    // window is on. If an event beats the answer here, the event is the newer
    // of the two and this one is dropped.
    changesState.loadingList = true;
    changed();
    window.tandem.project.info().then((info) => { if (!focusedDir) applyInfo(info); });
  },
  deactivate() {
    onScreen = false;
    poll(false);
  },
  count: changesCount,
};
