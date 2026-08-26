/* Everything the Changes view knows: what git says has changed in the project
   folder, the patch for whichever file is open, and where in that patch you
   are.

   Nothing here writes. Staging, discarding and committing stay in the terminal,
   where the command you ran is the one you can find again tomorrow. */
'use strict';
import { act } from './layout-store.js';

export const changesState = {
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

let started = false;
let timer = null;
let listSeq = 0;
let patchSeq = 0;

const POLL_MS = 5000;
const MAX_ROWS = 6000;   // a whole file, not three lines around each change

// ------------------------------------------------------------------ reading

export async function refresh({ quiet = false } = {}) {
  const seq = ++listSeq;
  if (!quiet) { changesState.loadingList = true; changed(); }

  const res = await window.tandem.changes.list();
  if (seq !== listSeq) return;   // a newer read already answered

  changesState.loadingList = false;
  changesState.repo = !!res?.repo;
  changesState.reason = res?.reason || null;
  changesState.error = res?.error || null;
  changesState.files = res?.files || [];
  changesState.capped = res?.capped || 0;

  // A file that stopped being changed takes the diff pane with it. One that is
  // still changed keeps its place, so a refresh under your cursor does not move
  // what you are reading.
  const still = changesState.files.find((f) => f.path === changesState.selected);
  if (!still) {
    changesState.selected = changesState.files[0]?.path || null;
    changesState.patch = null;
    changesState.blockAt = 0;
    if (changesState.selected) loadPatch(changesState.selected);
  } else {
    loadPatch(changesState.selected, { quiet: true });
  }

  changed();
}

async function loadPatch(rel, { quiet = false } = {}) {
  const seq = ++patchSeq;
  if (!quiet) { changesState.loadingPatch = true; changed(); }

  const res = await window.tandem.changes.patch(rel, changesState.mode);
  if (seq !== patchSeq) return;

  changesState.loadingPatch = false;

  // The line counts are not enough to tell a stale patch from a current one:
  // swapping one line for another leaves them identical. So the open file is
  // read again on every pass, and an answer that matches what is already on
  // screen is dropped rather than stored. Keeping the old object keeps its
  // identity, which is what the parse below caches on and what saves React
  // reconciling several thousand rows every five seconds.
  const same = quiet
    && changesState.patch?.path === res?.path
    && changesState.patch?.patch === res?.patch
    && changesState.patch?.error === res?.error;
  if (same) return;

  changesState.patch = res || null;
  changed();
}

export function selectFile(rel) {
  if (changesState.selected === rel) return;
  changesState.selected = rel;
  changesState.patch = null;
  changesState.blockAt = 0;
  changed();
  loadPatch(rel);
}

// Where a change sits in the file is most of what makes it readable, so the
// pane shows the whole file with its changed lines marked. "changes only" is
// still there for a small edit in a very long file, where the rest is just
// scrolling.
export function setMode(mode) {
  // A ToggleGroup hands back an empty string when you click the item that is
  // already on, and there is no third state to fall into.
  if (!mode || changesState.mode === mode) return;
  changesState.mode = mode;
  changesState.patch = null;
  changesState.blockAt = 0;
  changed();
  if (changesState.selected) loadPatch(changesState.selected);
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

let groupedFrom = null;
let grouped = { groups: [], blocks: 0, extra: 0 };

/* The rows the pane draws, with the runs of added and removed lines gathered
   up. A run that touches itself is one change: it is what the jump buttons step
   through and what wears the marker in the margin. Anything else, a context
   line or a hunk header, ends the run.

   Cached on the patch object, because both the view and the jump buttons ask
   for this and a long file is a few thousand rows. */
export function diffGroups() {
  const p = changesState.patch;
  if (groupedFrom === p) return grouped;
  groupedFrom = p;

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

  grouped = { groups, blocks, extra: Math.max(0, rows.length - MAX_ROWS) };
  return grouped;
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

// Only a move of the focused folder means the diff on screen belongs to another
// project. The window says its folders have changed for opens and reorders too,
// and neither of those touches what this pane is showing.
let showing = null;
window.tandem.project.onChanged((info) => {
  const next = info?.focused || info?.dir || null;
  if (next === showing) return;
  showing = next;
  changesState.files = [];
  changesState.selected = null;
  changesState.patch = null;
  changesState.blockAt = 0;
  if (started) refresh();
  else changed();
});

// app.js calls these as the right column switches. Nothing is read until the
// tab is first opened, and the timer only runs while it is the view on screen.
window.tandemChanges = {
  activate() {
    started = true;
    refresh({ quiet: changesState.files.length > 0 });
    poll(true);
  },
  deactivate() {
    poll(false);
  },
  count: changesCount,
};
