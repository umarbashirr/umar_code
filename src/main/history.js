'use strict';
// Session history. The claude binary already writes every session to
// ~/.claude/projects/<slug>/<id>.jsonl, and those lines carry the same message
// shape the panel renders. So we list and replay those rather than keeping a
// second copy that would drift from what `claude --resume` sees.
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');

// Claude Code slugifies a cwd by replacing / and . with -.
const slugFor = (cwd) => cwd.replace(/[/.]/g, '-');

let cached = null;

function projectDir(cwd) {
  if (cached && cached.cwd === cwd) return cached.dir;
  let dir = path.join(PROJECTS, slugFor(cwd));
  if (!fs.existsSync(dir)) dir = scanForCwd(cwd) || dir;
  cached = { cwd, dir };
  return dir;
}

// If that slug rule ever changes, fall back to reading one line out of each
// candidate directory and matching the cwd it recorded.
function scanForCwd(cwd) {
  let entries = [];
  try { entries = fs.readdirSync(PROJECTS, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(PROJECTS, e.name);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    if (!files.length) continue;
    for (const o of parseHead(path.join(dir, files[0]), 1 << 15)) {
      if (!o.cwd) continue;
      if (o.cwd === cwd) return dir;
      break; // this directory belongs to another project
    }
  }
  return null;
}

// Read the front of a jsonl file without pulling a 500KB transcript into memory.
function* parseHead(file, bytes) {
  let buf;
  try {
    const fd = fs.openSync(file, 'r');
    buf = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buf, 0, bytes, 0);
    fs.closeSync(fd);
    buf = buf.subarray(0, read);
  } catch { return; }
  // No pop of the last line: a JSON.parse that fails is already skipped below,
  // and dropping it unread loses a chat whose only line was caught before its
  // newline landed. That chat then vanished from the rail until the next write.
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch { /* skip */ }
  }
}

const strip = (s) => s
  .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
  .replace(/\s+/g, ' ')
  .trim();

// The first thing a person actually typed, which makes a better title than a
// slash command echo or a tool result.
function humanText(o) {
  if (o.type !== 'user' || o.isSidechain || o.isMeta) return null;
  const c = o.message?.content;
  const raw = typeof c === 'string' ? c
    : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n')
      : '';
  const text = strip(raw);
  if (!text) return null;
  if (/^<(command-name|command-message|command-args|local-command|bash-input|bash-stdout|bash-stderr|user-prompt|ide_)/.test(text)) return null;
  if (/^(Caveat|\[Request interrupted)/.test(text)) return null;
  if (text.startsWith('Caveat:')) return null;
  return text;
}

// A title comes out of the head of the file and never changes once it is there,
// so each transcript is read once rather than on every refresh. A file nothing
// was found in is read again only after it has grown.
const titles = new Map(); // path -> { title, size }

function titleOf(full, size) {
  const hit = titles.get(full);
  if (hit && (hit.title || hit.size === size)) return hit.title;

  let title = null;
  for (const o of parseHead(full, 1 << 17)) {
    title = humanText(o);
    if (title) break;
  }
  titles.set(full, { title, size });
  return title;
}

// The rail groups by day and searches across the lot, so the limit is high on
// purpose. It used to be 40, and with more transcripts than that the ones near
// the cut-off dropped off the list every time another chat was written to and
// came back the next time the order moved.
function listSessions(cwd, limit = 200) {
  const dir = projectDir(cwd);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return []; }

  const rows = [];
  for (const f of files) {
    const full = path.join(dir, f);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (!st.size) continue;

    // nothing a human said: an aborted or empty session
    const title = titleOf(full, st.size);
    if (!title) continue;

    rows.push({ id: f.replace(/\.jsonl$/, ''), title: title.slice(0, 120), at: st.mtimeMs });
  }
  rows.sort((a, b) => b.at - a.at);
  return rows.slice(0, limit);
}

const MAX_MESSAGES = 400;
const MAX_TEXT = 6000;
const MAX_IMAGES = 12;

// Trim a stored message down to something worth sending over IPC. Screenshots
// are the expensive part, so keep the most recent handful and stub the rest.
function slim(msg, budget) {
  const c = msg.message?.content;
  if (!Array.isArray(c)) return msg;
  const content = c.map((b) => {
    if (b.type === 'image') {
      if (budget.images <= 0) return { type: 'text', text: '[screenshot omitted from replay]' };
      budget.images -= 1;
      return b;
    }
    if (b.type === 'tool_result' && Array.isArray(b.content)) {
      return { ...b, content: b.content.map((inner) => slimBlock(inner, budget)) };
    }
    return slimBlock(b, budget);
  });
  return { ...msg, message: { ...msg.message, content } };
}

function slimBlock(b, budget) {
  if (b.type === 'image') {
    if (budget.images <= 0) return { type: 'text', text: '[screenshot omitted from replay]' };
    budget.images -= 1;
    return b;
  }
  if (typeof b.text === 'string' && b.text.length > MAX_TEXT) {
    return { ...b, text: b.text.slice(0, MAX_TEXT) + '\n… truncated' };
  }
  return b;
}

// Replayable messages for one session, oldest first.
async function readSession(cwd, id) {
  const file = path.join(projectDir(cwd), `${id}.jsonl`);
  if (!fs.existsSync(file)) throw new Error(`no transcript for session ${id}`);

  const out = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.isSidechain || o.isMeta) continue;         // subagent traffic and bookkeeping
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    if (!o.message) continue;
    if (o.type === 'user' && !humanText(o) && !hasToolResult(o)) continue;
    // What an Agent call came back with: how long it ran, how much it did, and
    // what it concluded. Cheaper and more exact than parsing the result text.
    const agent = o.toolUseResult?.agentId ? summarise(o.toolUseResult) : null;
    out.push({ type: o.type, message: o.message, at: o.timestamp, ...(agent ? { agent } : {}) });
  }

  const budget = { images: MAX_IMAGES };
  const tail = out.slice(-MAX_MESSAGES);
  // Spend the screenshot budget from the newest message backwards: the recent
  // ones are the ones worth looking at.
  const slimmed = [];
  for (let i = tail.length - 1; i >= 0; i--) slimmed[i] = slim(tail[i], budget);
  return { id, truncated: out.length > tail.length, messages: slimmed };
}

const hasToolResult = (o) =>
  Array.isArray(o.message?.content) && o.message.content.some((b) => b.type === 'tool_result');

// The parts of an Agent tool's result worth drawing. The rest is usage
// accounting the panel has nowhere to put.
const summarise = (r) => ({
  id: r.agentId,
  type: r.agentType || 'agent',
  tools: r.totalToolUseCount ?? 0,
  ms: r.totalDurationMs ?? 0,
  tokens: r.totalTokens ?? 0,
  stats: r.toolStats || null,
  status: r.status || 'completed',
});

// Each subagent gets its own file next to the session, with a meta.json naming
// it. Listing the metas is enough to draw every agent row on a replayed chat
// without reading a single transcript.
function subagentDir(cwd, session) {
  return path.join(projectDir(cwd), session, 'subagents');
}

function listSubagents(cwd, session) {
  const dir = subagentDir(cwd, session);
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.meta.json')); } catch { return []; }
  const out = [];
  for (const name of names) {
    let meta;
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
    out.push({
      id: name.replace(/^agent-/, '').replace(/\.meta\.json$/, ''),
      type: meta.agentType || 'agent',
      description: meta.description || '',
      toolUseId: meta.toolUseId || null,
      depth: meta.spawnDepth || 1,
    });
  }
  return out;
}

// One subagent's own transcript, read only when someone opens its row. Nobody
// pays for the ten agents they did not click on.
async function readSubagent(cwd, session, agentId) {
  const file = path.join(subagentDir(cwd, session), `agent-${agentId}.jsonl`);
  if (!fs.existsSync(file)) throw new Error(`no transcript for agent ${agentId}`);

  const out = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.isMeta) continue;
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    if (!o.message) continue;
    out.push({ type: o.type, message: o.message, at: o.timestamp });
  }

  const budget = { images: MAX_IMAGES };
  const tail = out.slice(-MAX_MESSAGES);
  const slimmed = [];
  for (let i = tail.length - 1; i >= 0; i--) slimmed[i] = slim(tail[i], budget);
  // The first line is the prompt the parent handed it, which the Agent row
  // already shows as its summary.
  return { id: agentId, truncated: out.length > tail.length, messages: slimmed };
}

module.exports = { listSessions, readSession, readSubagent, listSubagents, projectDir };
