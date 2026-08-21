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
  const lines = buf.toString('utf8').split('\n');
  lines.pop(); // may be a partial line
  for (const line of lines) {
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

function listSessions(cwd, limit = 40) {
  const dir = projectDir(cwd);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return []; }

  const rows = [];
  for (const f of files) {
    const full = path.join(dir, f);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (!st.size) continue;

    let title = null;
    for (const o of parseHead(full, 1 << 17)) {
      title = humanText(o);
      if (title) break;
    }
    if (!title) continue; // nothing a human said: an aborted or empty session

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
    out.push({ type: o.type, message: o.message, at: o.timestamp });
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

module.exports = { listSessions, readSession, projectDir };
