/* The chats in this folder.

   Two sources, merged on every read. `sessions` is what claude has written to
   ~/.claude/projects; `live` is every chat open in the chat pane, including the
   ones claude has not written yet. A chat is on screen the moment you type in
   it and on disk a beat later, so a list built on either half alone drops rows
   for a second or two and puts them back. */
'use strict';

const state = { sessions: [], live: [], activeKey: null };

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

// A live chat has no mtime until it lands on disk, and reading the clock at
// render time would slide it between the Today/Yesterday groups. First sight
// wins, and the disk row takes over once there is one.
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

export function bucket(ms) {
  const day = 86400000;
  const midnight = new Date().setHours(0, 0, 0, 0);
  if (ms >= midnight) return 'Today';
  if (ms >= midnight - day) return 'Yesterday';
  if (ms >= midnight - 7 * day) return 'This week';
  return 'Earlier';
}

export const activeKey = () => state.activeKey;

/* One row per chat. A live chat claude has already written keeps its place in
   the stored list and only picks up the live half's badges; one it has not is
   pushed on top, which is where a chat you just started belongs anyway. */
export function rows(filter = '') {
  const stored = state.sessions.map((s) => ({ ...s }));
  const bySession = new Map(stored.map((s) => [s.id, s]));
  const fresh = [];

  for (const c of state.live) {
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
      title: c.title,
      at: seenAt(c.key),
      busy: c.busy,
      agents: c.agents,
    });
  }

  fresh.sort((a, b) => b.at - a.at);
  const all = [...fresh, ...stored];
  const q = filter.trim().toLowerCase();
  return q ? all.filter((s) => s.title.toLowerCase().includes(q)) : all;
}

// Rows in the order they are drawn, already split into their day groups.
export function grouped(filter) {
  const out = [];
  for (const row of rows(filter)) {
    const label = bucket(row.at);
    if (out[out.length - 1]?.label !== label) out.push({ label, rows: [] });
    out[out.length - 1].rows.push(row);
  }
  return out;
}

export async function refreshRail() {
  try {
    const data = await window.tandem.agent.history();
    state.sessions = data.sessions || [];
  } catch {
    state.sessions = [];
  }
  changed();
}

window.tandemRail = {
  refresh: refreshRail,
  // The whole set of open chats, sent by the chat pane whenever it changes. It
  // owns which chats exist, which one is on screen and which are mid-turn; this
  // only draws them next to what is on disk.
  sync: ({ chats, active } = {}) => {
    state.live = chats || [];
    state.activeKey = active || null;
    changed();
  },
};
