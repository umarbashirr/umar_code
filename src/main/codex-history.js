'use strict';
/* Session history when the provider is codex.
 *
 * The same names and the same return shapes as history.js, so index.js picks a
 * module per provider and every handler behind it stays as it was.
 *
 * Nothing here reads a file. codex writes rollouts under ~/.codex/sessions and
 * calls that path unstable in its own schema, while the app-server serves the
 * same material through thread/list and thread/read. Binding to the protocol
 * costs a process where history.js costs a readdir, and it is still the right
 * side to bind to: the format on disk is theirs to change without telling us.
 *
 * So the process is held open rather than spawned per question. The rail
 * refreshes on mount and again every time the palette opens, and one refresh
 * asks once per open project, so a spawn per call would pay a cold start four
 * or five times for a single keystroke. Measured against codex 0.150.1: spawn
 * plus initialize is about 170ms, a thread/list on a live server about 20ms,
 * a thread/read about 3ms. One shared server turns that burst into a single
 * spawn, and IDLE_MS with nothing asked of it shuts the server down again so
 * an app sitting in the background is not holding a codex open all afternoon.
 *
 * Answers are not cached. They are cheap once the server is up, and a rail
 * still showing yesterday's list after a chat ends is the bug this exists to
 * fix.
 */
const fs = require('fs');
const os = require('os');
const { AppServer } = require('./codex-rpc');
const { codexBinary, CLIENT } = require('./codex-driver');
const shellEnv = require('./shell-env');

const IDLE_MS = 5 * 60 * 1000;
const CALL_MS = 20000;

let server = null;    // the live AppServer, or null when nothing is asking
let starting = null;  // in-flight start, so a burst of projects spawns one
let idleTimer = null;

function keepAlive() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(close, IDLE_MS);
  // A history query must never be the reason a process stays up.
  idleTimer.unref?.();
}

/* The server runs in the home directory. thread/list is told which cwd to
   filter on and thread/read works by id, so the directory the server itself
   sits in never reaches an answer, and home keeps it out of any project the
   person has open. */
async function connect() {
  if (server && !server.closed) return server;
  if (starting) return starting;

  starting = (async () => {
    await shellEnv.ready();
    const bin = codexBinary();
    if (!bin) return null;
    const rpc = new AppServer({ bin, cwd: os.homedir() });
    rpc.on('closed', () => { if (server === rpc) server = null; });
    await rpc.start({ clientInfo: CLIENT });
    server = rpc;
    keepAlive();
    return rpc;
  })()
    // No codex, no login, no answer: the rail draws an empty project the same
    // way it does for a claude project with no transcripts.
    .catch(() => null)
    .finally(() => { starting = null; });

  return starting;
}

async function call(method, params) {
  const rpc = await connect();
  if (!rpc) return null;
  keepAlive();
  try {
    return await rpc.request(method, params, CALL_MS);
  } catch (e) {
    if (!rpc.closed) throw e;
    // The server died between one question and the next, which is what an
    // upgrade under a running app looks like. Retry once on a fresh process
    // rather than making the first click after an upgrade the one that fails.
    server = null;
    const again = await connect();
    if (!again) return null;
    return again.request(method, params, CALL_MS);
  }
}

function close() {
  clearTimeout(idleTimer);
  idleTimer = null;
  const rpc = server;
  server = null;
  rpc?.close();
}

/* codex matches the cwd filter exactly, and a project opened through a symlink
   is recorded under whichever spelling started the thread. Asking about both
   costs nothing: the filter takes a list. */
function cwdFilter(cwd) {
  const paths = [cwd];
  try {
    const real = fs.realpathSync(cwd);
    if (real !== cwd) paths.push(real);
  } catch {}
  return paths;
}

// codex counts in seconds. The rail sorts and formats in milliseconds, and a
// raw number here lands every chat in January 1970.
const ms = (sec) => (typeof sec === 'number' ? sec * 1000 : 0);
const iso = (sec) => (typeof sec === 'number' ? new Date(sec * 1000).toISOString() : null);

const strip = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// The rail groups by day and searches the lot, so the limit is high for the
// same reason it is in history.js.
async function listSessions(cwd, limit = 200) {
  let res;
  try {
    res = await call('thread/list', { cwd: cwdFilter(cwd), limit, sortKey: 'updated_at' });
  } catch {
    return [];
  }

  const rows = [];
  for (const t of res?.data || []) {
    if (!t?.id) continue;
    // Never written to disk, so there is nothing to resume.
    if (t.ephemeral) continue;
    // A subagent's own thread. It belongs under the chat that spawned it, not
    // beside it in the rail.
    if (t.parentThreadId) continue;
    // `name` is a title someone set; `preview` is the first thing they typed,
    // which is the same thing history.js digs out of the transcript head.
    const title = strip(t.name || t.preview);
    if (!title) continue;
    rows.push({ id: t.id, title: title.slice(0, 120), at: ms(t.updatedAt ?? t.recencyAt ?? t.createdAt) });
  }
  rows.sort((a, b) => b.at - a.at);
  return rows.slice(0, limit);
}

/* Deleting a chat for good. Same guard as history.js and for a better reason
   than symmetry: codex thread ids are UUIDv7, so anything that is not a uuid
   is a chat key or a stray path arriving where a thread id was meant. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function deleteSession(cwd, id) {
  if (!SESSION_ID.test(String(id || ''))) throw new Error(`not a session id: ${id}`);
  const res = await call('thread/delete', { threadId: id });
  agents.delete(id);
  return res != null;
}

// --- codex items in, claude-shaped messages out -----------------------------

/* This table and everything under it is the second copy of the translation in
   src/main/codex.js: TOOL_NAME, #itemStarted, #itemDone and #input. It is
   deliberately the same set of decisions, because a chat read back out of
   history has to draw the rows it drew while it was running, and the tool rows
   in the transcript only know claude's names. Changing a mapping there without
   changing it here is how the two drift apart. */
const TOOL_NAME = {
  commandExecution: 'Bash',
  fileChange: 'Edit',
  webSearch: 'WebSearch',
  imageView: 'Read',
  sleep: 'Bash',
};

const text = (v) => (typeof v === 'string' ? v : JSON.stringify(v ?? null, null, 2));

const toolUse = (id, name, input, at) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  at,
});

const toolResult = (id, content, isError, at) => ({
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content: text(content), is_error: !!isError }],
  },
  at,
});

function inputFor(item) {
  if (item.type === 'commandExecution') return { command: item.command, description: item.cwd };
  if (item.type === 'fileChange') return { changes: item.changes };
  if (item.type === 'webSearch') return { query: item.query };
  return {};
}

function outputFor(item) {
  if (item.type === 'commandExecution') {
    return [item.aggregatedOutput ?? '', item.exitCode !== 0 && item.exitCode != null];
  }
  if (item.type === 'fileChange') {
    const files = (item.changes || []).map((c) => c.path || c.file || '').filter(Boolean);
    return [files.length ? files.join('\n') : (item.status || 'done'), item.status === 'failed'];
  }
  if (item.type === 'mcpToolCall') {
    return [(item.error ? (item.error.message || 'the tool failed') : item.result) ?? '', !!item.error];
  }
  return [item.status || 'done', false];
}

/* One stored item as the messages the panel replays. Zero of them for anything
   the live path also drops: reasoning, plans, review-mode markers and
   compaction notices never reached the transcript while the chat ran, and
   showing them now would make a replayed chat say more than it ever did. */
function messagesFor(item, at, found) {
  if (item.type === 'userMessage') {
    // Images were handed to codex as data urls and the live bubble carries only
    // the text, so this replays what was on screen rather than what was sent.
    const said = (item.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text || '')
      .join('\n');
    if (!said.trim()) return [];
    return [{ type: 'user', message: { role: 'user', content: [{ type: 'text', text: said }] }, at }];
  }

  if (item.type === 'agentMessage') {
    if (!item.text) return [];
    return [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: item.text }] }, at }];
  }

  if (item.type === 'subAgentActivity') {
    if (item.agentThreadId) {
      found.push({
        id: item.agentThreadId,
        type: item.kind || 'agent',
        description: item.agentPath || '',
        toolUseId: item.id || null,
        depth: 1,
      });
    }
    return [];
  }

  const name = TOOL_NAME[item.type]
    || (item.type === 'mcpToolCall' ? `mcp__${item.server}__${item.tool}` : null);
  if (!name) return [];

  const [out, failed] = outputFor(item);
  const input = item.type === 'mcpToolCall' ? (item.arguments || {}) : inputFor(item);
  return [toolUse(item.id, name, input, at), toolResult(item.id, out, failed, at)];
}

const MAX_MESSAGES = 400;
const MAX_TEXT = 6000;

// A whole npm install lands in one tool_result, and the panel has nowhere to
// put 400KB of it.
function slim(msg) {
  const c = msg.message?.content;
  if (!Array.isArray(c)) return msg;
  const content = c.map((b) => {
    if (typeof b.text === 'string' && b.text.length > MAX_TEXT) {
      return { ...b, text: `${b.text.slice(0, MAX_TEXT)}\n… truncated` };
    }
    if (typeof b.content === 'string' && b.content.length > MAX_TEXT) {
      return { ...b, content: `${b.content.slice(0, MAX_TEXT)}\n… truncated` };
    }
    return b;
  });
  return { ...msg, message: { ...msg.message, content } };
}

/* Which subagents a chat ran, filled in by the read that found them. The
   claude side lists them off disk without opening a transcript; codex only
   mentions them inside the thread, so this is what the read left behind.
   Empty for every thread on 0.150.1, where thread/read replays messages and
   nothing else. See listSubagents. */
const agents = new Map();

// Replayable messages for one session, oldest first.
async function readSession(cwd, id) {
  const res = await call('thread/read', { threadId: id, includeTurns: true });
  if (!res?.thread) throw new Error(`no transcript for session ${id}`);

  const found = [];
  const out = [];
  for (const turn of res.thread.turns || []) {
    // Items carry no time of their own, so a turn's messages all take the time
    // the turn started. The panel groups by message rather than by minute, so
    // the granularity costs nothing.
    const at = iso(turn.startedAt ?? turn.completedAt ?? res.thread.createdAt);
    for (const item of turn.items || []) out.push(...messagesFor(item, at, found));
  }
  agents.set(id, found);

  const tail = out.slice(-MAX_MESSAGES);
  return { id, truncated: out.length > tail.length, messages: tail.map(slim) };
}

/* Synchronous on purpose: index.js folds this into the transcript reply it
   already awaited, so a promise here would be handed to the renderer as a
   promise. The read that precedes it is what fills the map. */
function listSubagents(cwd, session) {
  return agents.get(session) || [];
}

// A codex subagent is a thread of its own, so its transcript is the same read
// as any other chat's.
async function readSubagent(cwd, session, agentId) {
  const t = await readSession(cwd, agentId);
  return { ...t, id: agentId };
}

module.exports = { listSessions, readSession, readSubagent, listSubagents, deleteSession, close };
