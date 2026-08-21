/* The session rail. Stays vanilla: it is a list, not a chat. It talks to the
   React pane through window.pbaChat and is told what to highlight through
   window.pbaRail. */
'use strict';
import { $, el, icons, iconMark } from './app.js';

// `pending` is the chat you just started. Claude writes its jsonl a beat after
// the first message goes out, so until then there is nothing on disk for the
// listing to find and the rail would sit empty on the chat you are looking at.
const PENDING = '__pending__';
const railState = { sessions: [], current: null, filter: '', pending: null };

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

// The placeholder drops out the moment the real transcript appears under the
// same id, so a chat never shows up twice.
function visibleRows() {
  const list = railState.sessions.slice();
  const p = railState.pending;
  if (p && !list.some((s) => s.id === p.id)) list.unshift(p);
  const q = railState.filter.toLowerCase();
  return q ? list.filter((s) => s.title.toLowerCase().includes(q)) : list;
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

    const current = s.id === railState.current;
    const row = el('div', 'sess' + (current ? ' current' : ''));
    row.appendChild(iconMark(current ? 'message-square-dot' : 'message-square'));
    row.appendChild(el('span', 'sess-title', s.title));
    row.appendChild(el('span', 'sess-when', rel(s.at)));
    row.title = s.title;
    row.onclick = () => { if (!current) window.pbaChat?.open(s); };
    box.appendChild(row);
  }
  icons();
}

async function refresh() {
  try {
    const data = await window.pba.agent.history();
    railState.sessions = data.sessions || [];
    if (data.current) railState.current = data.current;
  } catch { railState.sessions = []; }
  render();
}

window.pbaRail = {
  refresh,
  // Called on the first message of a new chat, before there is a session id.
  begin: (title) => {
    railState.pending = { id: PENDING, title: String(title).slice(0, 120), at: Date.now() };
    railState.current = PENDING;
    render();
  },
  // The id arrives with the SDK's init message. Hand it to the placeholder so
  // the row stays current across the swap to the real listing.
  setCurrent: (id) => {
    if (!id) railState.pending = null;
    else if (railState.pending) railState.pending.id = id;
    railState.current = id;
    render();
  },
};

$('#session-search').addEventListener('input', (e) => {
  railState.filter = e.target.value.trim();
  render();
});

$('#new-chat').onclick = () => {
  window.pbaChat?.newChat();
  window.pbaRail.setCurrent(null);
  document.querySelector('#agent-root textarea')?.focus();
};

// The folder label and the empty state live in project.js; this list only cares
// about which chats belong to whatever folder is open.
refresh();
