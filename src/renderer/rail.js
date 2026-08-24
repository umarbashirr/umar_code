/* The session rail. Stays vanilla: it is a list, not a chat. It talks to the
   React pane through window.tandemChat and is told what is open through
   window.tandemRail. */
'use strict';
import { $, el, icons, iconMark } from './app.js';

// Two sources, merged every render. `sessions` is what claude has written to
// ~/.claude/projects; `live` is every chat open in the React pane, including
// the ones claude has not written yet. A chat is on screen the moment you type
// in it and on disk a beat later, so a rail built on either half alone drops
// rows for a second or two and puts them back.
const railState = { sessions: [], live: [], activeKey: null, filter: '' };

// A live chat has no mtime until it lands on disk, and reading the clock at
// render time would slide it between the Today/Yesterday groups. First sight
// wins, and the disk row takes over once there is one.
const firstSeen = new Map();
const seenAt = (key) => {
  if (!firstSeen.has(key)) firstSeen.set(key, Date.now());
  return firstSeen.get(key);
};

const rel = (ms) => {
  const s = (Date.now() - ms) / 1000;
  if (s < 90) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 604800) return `${Math.floor(s / 86400)}d`;
  return new Date(ms).toISOString().slice(5, 10);
};

function bucket(ms) {
  const day = 86400000;
  const midnight = new Date().setHours(0, 0, 0, 0);
  if (ms >= midnight) return 'Today';
  if (ms >= midnight - day) return 'Yesterday';
  if (ms >= midnight - 7 * day) return 'This week';
  return 'Earlier';
}

// One row per chat. A live chat claude has already written keeps its place in
// the stored list and only picks up the live half's badges; one it has not is
// pushed on top, which is where a chat you just started belongs anyway.
function visibleRows() {
  const stored = railState.sessions.map((s) => ({ ...s }));
  const bySession = new Map(stored.map((s) => [s.id, s]));
  const fresh = [];

  for (const c of railState.live) {
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
  const rows = [...fresh, ...stored];
  const q = railState.filter.toLowerCase();
  return q ? rows.filter((s) => s.title.toLowerCase().includes(q)) : rows;
}

function render() {
  const box = $('#session-list');
  box.innerHTML = '';
  const q = railState.filter.toLowerCase();
  const rows = visibleRows();

  if (!rows.length) {
    box.appendChild(el('div', 'sess-empty', q
      ? 'Nothing matches that.'
      : 'No chats in this folder yet. Ask for something and it lands here.'));
    return;
  }

  let group = null;
  for (const s of rows) {
    const b = bucket(s.at);
    if (b !== group) { group = b; box.appendChild(el('div', 'sess-group', b)); }

    const current = !!s.key && s.key === railState.activeKey;
    const row = el('div', 'sess' + (current ? ' current' : ''));
    row.appendChild(iconMark(current ? 'message-square-dot' : 'message-square'));
    row.appendChild(el('span', 'sess-title', s.title));
    if (s.busy) row.appendChild(el('span', 'sess-working', s.agents ? `${s.agents} agents` : 'working'));
    row.appendChild(el('span', 'sess-when', rel(s.at)));
    row.title = s.title;
    row.onclick = () => { if (!current) window.tandemChat?.open(s); };
    box.appendChild(row);
  }
  icons();
}

async function refresh() {
  try {
    const data = await window.tandem.agent.history();
    railState.sessions = data.sessions || [];
  } catch { railState.sessions = []; }
  render();
}

window.tandemRail = {
  refresh,
  // The whole set of open chats, sent by the React pane whenever it changes.
  // It owns which chats exist, which one is on screen and which are mid-turn;
  // the rail only draws them next to what is on disk.
  sync: ({ chats, active } = {}) => {
    railState.live = chats || [];
    railState.activeKey = active || null;
    render();
  },
};

$('#session-search').addEventListener('input', (e) => {
  railState.filter = e.target.value.trim();
  render();
});

$('#new-chat').onclick = () => {
  window.tandemChat?.newChat();
  document.querySelector('#agent-root textarea')?.focus();
};

// The folder label and the empty state live in project.js; this list only cares
// about which chats belong to whatever folder is open.
refresh();
