/* The chats in every project the window has open.

   Two sources, merged on every read. `projects` is what claude has written to
   ~/.claude/projects, folder by folder; `live` is every chat open in the chat
   pane, including the ones claude has not written yet. A chat is on screen the
   moment you type in it and on disk a beat later, so a list built on either
   half alone drops rows for a second or two and puts them back.

   Both halves name the folder a chat belongs to, so the merge runs once per
   folder and the rail draws one section each.

   A folder's chats come back in two lists rather than one. Anything the person
   has marked completed is finished work nobody is going back to, and leaving it
   in the rail at the same weight as what is being worked on now is what makes
   the rail useless after a fortnight. Marked chats go in a fold at the bottom
   of their folder, whole and one click away. */
'use strict';

const state = {
  projects: [],
  live: [],
  activeKey: null,
  // session id -> when it was marked. Main owns this and it survives restarts,
  // so a chat you finished with last week is still put away today.
  completed: {},
};

const listeners = new Set();
let version = 0;

export const getRailVersion = () => version;

export function subscribeRail(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function changed() {
  version += 1;
  for (const fn of listeners) fn();
}

// ------------------------------------------------------------ folded folders

const FOLDED_KEY = 'tandem.rail.folded';

/* Which sections are shut. Open is the default, so what gets written down is
   the exceptions, and a folder nobody has folded is simply absent. Folders you
   have since closed keep their entry: pruning them would throw away the answer
   for the folder you are most likely to open again. */
const folded = new Set(loadFolded());

function loadFolded() {
  try {
    const saved = JSON.parse(localStorage.getItem(FOLDED_KEY));
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function saveFolded() {
  // A storage that refuses to write only costs us the folds after a restart,
  // which is not worth failing a click over.
  try {
    localStorage.setItem(FOLDED_KEY, JSON.stringify([...folded]));
  } catch {
    /* not worth reporting */
  }
}

export const projectOpen = (dir) => !folded.has(dir);

/* The Completed fold keeps its own set, and the sense is the other way round:
   what is written down is the folders whose fold you opened. Shut is the
   default because the fold exists to get finished work out of the way, and one
   that came back open on every launch would not be doing that. */
const OPENED_KEY = 'tandem.rail.doneOpen';
const doneOpened = new Set(loadOpened());

function loadOpened() {
  try {
    const saved = JSON.parse(localStorage.getItem(OPENED_KEY));
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

export const doneOpen = (dir) => doneOpened.has(dir);

export function setDoneOpen(dir, open) {
  if (open) doneOpened.add(dir);
  else doneOpened.delete(dir);
  try { localStorage.setItem(OPENED_KEY, JSON.stringify([...doneOpened])); } catch { /* not worth reporting */ }
  changed();
}

export function setProjectOpen(dir, open) {
  if (open) folded.delete(dir);
  else folded.add(dir);
  saveFolded();
  changed();
}

// -------------------------------------------------------------------- rows

// A live chat has no mtime until it lands on disk, and reading the clock at
// render time would keep it pinned at 'now' and shuffle the folders under it.
// First sight wins, and the disk row takes over once there is one.
const firstSeen = new Map();
const seenAt = (key) => {
  if (!firstSeen.has(key)) firstSeen.set(key, Date.now());
  return firstSeen.get(key);
};

export const relative = (ms) => {
  const s = (Date.now() - ms) / 1000;
  if (s < 90) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 604800) return `${Math.floor(s / 86400)}d`;
  return new Date(ms).toISOString().slice(5, 10);
};

export const activeKey = () => state.activeKey;

const folderName = (dir) => dir.split(/[/\\]/).filter(Boolean).pop() || dir;

/* One row per chat in one folder. A live chat claude has already written keeps
   its place in the stored list and only picks up the live half's badges; one it
   has not is pushed on top, which is where a chat you just started belongs
   anyway. */
function rows(dir, sessions) {
  const stored = sessions.map((s) => ({ ...s, project: dir }));
  const bySession = new Map(stored.map((s) => [s.id, s]));
  const fresh = [];

  for (const c of state.live) {
    if (c.project !== dir) continue;
    const row = (c.session && bySession.get(c.session)) || null;
    if (row) {
      row.key = c.key;
      row.busy = c.busy;
      row.agents = c.agents;
      continue;
    }
    fresh.push({
      id: c.session || c.key,
      key: c.key,
      project: dir,
      title: c.title,
      at: seenAt(c.key),
      busy: c.busy,
      agents: c.agents,
    });
  }

  fresh.sort((a, b) => b.at - a.at);
  return [...fresh, ...stored];
}

/* Every folder worth a section, whether or not claude has written anything in
   it yet: open a folder, type once, and it has a live chat and no history. */
function folders() {
  const out = state.projects.map((p) => ({ dir: p.dir, name: p.name, sessions: p.sessions || [] }));
  const byDir = new Map(out.map((p) => [p.dir, p]));

  for (const c of state.live) {
    if (!c.project || byDir.has(c.project)) continue;
    // The live half carries the path and no name, so the last segment stands in
    // until history catches up with the real one.
    const entry = { dir: c.project, name: folderName(c.project), sessions: [] };
    byDir.set(entry.dir, entry);
    out.push(entry);
  }

  return out;
}

const newest = (list) => list.reduce((max, s) => (s.at > max ? s.at : max), 0);

/* The folders in the order they are drawn, each with its chats, newest first.
   Search runs across all of them at once. */
export function grouped(filter = '') {
  const q = String(filter || '').trim().toLowerCase();
  const out = [];

  for (const folder of folders()) {
    let list = rows(folder.dir, folder.sessions);
    if (q) list = list.filter((s) => String(s.title || '').toLowerCase().includes(q));

    /* Marked chats come out of the folder's list and go in its fold. A chat
       still working stays out in the open whatever it is marked: something
       mid-turn is by definition not finished, and hiding a running turn is how
       you lose track of one.

       Searching puts them back. Typing a name is asking where something is, and
       answering by tucking the match inside a fold that is shut by default is
       the same as not answering. A matched chat that has been put away still
       reads as put away: it keeps its tick. */
    const open = [];
    const done = [];
    for (const row of list) (!q && isDone(row) && !row.busy ? done : open).push(row);

    // A folder the search missed leaves altogether. A header sitting over
    // nothing reads as a bug, and there is already an empty state for a search
    // that found nothing anywhere. Unfiltered, a folder with no chats yet does
    // keep its header, because it is open and the rail should say so.
    if (q && !list.length) continue;
    // Newest put away first, which is the order you filed them in and not the
    // order the transcripts were last written to.
    done.sort((a, b) => (state.completed[b.id] || 0) - (state.completed[a.id] || 0));

    out.push({
      dir: folder.dir,
      name: folder.name,
      rows: open,
      done,
      at: newest(list),
    });
  }

  // The folder you worked in last is the one you are most likely to want.
  out.sort((a, b) => b.at - a.at);
  return out;
}

// Whether a row is one the person has put away. Keyed on the session id, which
// is the only name a chat keeps across restarts.
export const isDone = (row) => !!row?.id && Object.hasOwn(state.completed, row.id);

/* Marking one, or putting it back. The answer is written down by main, and the
   row moves here straight away rather than waiting for the round trip, because
   a click that takes a beat to do anything reads as a click that missed. */
export async function markDone(row, done = true) {
  if (!row?.id) return { error: 'that chat has not been saved yet' };
  if (done) state.completed[row.id] = Date.now();
  else delete state.completed[row.id];
  changed();

  const res = await window.tandem.agent.complete(row.id, done).catch((e) => ({ error: e.message }));
  if (res?.error) {
    // Put it back where it was. The rail and the file on disk disagreeing is
    // worse than the mark not taking.
    if (done) delete state.completed[row.id];
    else state.completed[row.id] = Date.now();
    changed();
  }
  return res || {};
}

export const doneCount = () => Object.keys(state.completed).length;

export async function refreshRail() {
  try {
    const data = await window.tandem.agent.history();
    state.projects = data.projects || [];
    state.completed = data.completed || {};
  } catch {
    state.projects = [];
  }
  changed();
}

window.tandemRail = {
  refresh: refreshRail,
  // The whole set of open chats, sent by the chat pane whenever it changes. It
  // owns which chats exist, which folder each belongs to, which one is on
  // screen and which are mid-turn; this only draws them next to what is on disk.
  sync: ({ chats, active } = {}) => {
    state.live = chats || [];
    state.activeKey = active || null;
    changed();
  },
};
