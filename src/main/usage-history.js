'use strict';
// What each CLI has spent, read back from the transcripts it already keeps on
// disk, so the Usage page has history from the first time it opens instead of
// only the chats Tandem happened to record.
//
// Claude writes one line per content block, so a single billed request shows up
// several times with the same usage; a resumed session also copies earlier
// messages into its new file. Requests are keyed by message and request id and
// counted once across every file. Codex writes a running total per session, so
// each request is the step between two totals.
//
// Parsing 300MB of transcripts is slow, so each file's requests are cached by
// path, size and mtime, and only files that changed are read again.
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_VERSION = 1;

const claudeRoot = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
const codexRoot = () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');

async function jsonlFiles(dir, since) {
  const out = [];
  const walk = async (d) => {
    let entries;
    try { entries = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try {
          const st = await fs.promises.stat(p);
          // A file untouched for longer than the page looks back holds nothing
          // it would show.
          if (st.mtimeMs >= since) out.push({ file: p, size: st.size, mtime: st.mtimeMs });
        } catch {}
      }
    }
  };
  await walk(dir);
  return out;
}

async function eachLine(file, fn) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    fn(row);
  }
}

// [key, t, model, project, input, output, cacheRead, cacheWrite]
async function readClaude(file) {
  const seen = new Map();
  await eachLine(file, (row) => {
    const m = row.message;
    const u = m?.usage;
    if (row.type !== 'assistant' || !u || !m.model || m.model === '<synthetic>') return;
    const key = `${m.id || ''}:${row.requestId || ''}`;
    const prev = seen.get(key);
    // Later lines of the same request carry the final output count.
    const output = Math.max(prev?.[5] || 0, u.output_tokens || 0);
    seen.set(key, [
      key, Date.parse(row.timestamp) || 0, m.model, row.cwd || '',
      u.input_tokens || 0, output, u.cache_read_input_tokens || 0, u.cache_creation_input_tokens || 0,
    ]);
  });
  return { requests: [...seen.values()] };
}

async function readCodex(file) {
  const requests = [];
  let model = '';
  let project = '';
  let last = null;
  let limits = null;
  await eachLine(file, (row) => {
    const p = row.payload || {};
    if (row.type === 'session_meta') project = p.cwd || project;
    if (row.type === 'turn_context') { model = p.model || model; project = p.cwd || project; }
    if (row.type !== 'event_msg' || p.type !== 'token_count') return;
    const t = Date.parse(row.timestamp) || 0;
    if (p.rate_limits) limits = { ...p.rate_limits, asOf: t };
    const total = p.info?.total_token_usage;
    if (!total) return;
    const d = (k) => Math.max(0, (total[k] || 0) - (last?.[k] || 0));
    const input = d('input_tokens');
    const cached = d('cached_input_tokens');
    const output = d('output_tokens');
    const cacheWrite = d('cache_write_input_tokens');
    last = total;
    if (!input && !output) return;
    // OpenAI counts cached tokens inside input_tokens; split them out so the
    // columns mean what they mean for Claude.
    requests.push([`${file}:${requests.length}`, t, model || 'codex', project, input - cached, output, cached, cacheWrite]);
  });
  return { requests, limits };
}

const READERS = {
  claude: { root: claudeRoot, read: readClaude },
  codex: { root: codexRoot, read: readCodex },
};

function createUsageHistory(cacheDir) {
  const cacheFile = path.join(cacheDir, 'usage-history.json');
  let cache = null;
  let inflight = null;

  const load = () => {
    if (cache) return cache;
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (c.version === CACHE_VERSION) cache = c;
    } catch {}
    cache ||= { version: CACHE_VERSION, files: {} };
    return cache;
  };

  const save = () => {
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(`${cacheFile}.tmp`, JSON.stringify(cache));
      fs.renameSync(`${cacheFile}.tmp`, cacheFile);
    } catch {}
  };

  async function scan() {
    const c = load();
    const since = Date.now() - KEEP_MS;
    const live = new Set();
    let changed = false;
    for (const [provider, { root, read }] of Object.entries(READERS)) {
      for (const f of await jsonlFiles(root(), since)) {
        live.add(f.file);
        const hit = c.files[f.file];
        if (hit && hit.size === f.size && hit.mtime === f.mtime) continue;
        try {
          c.files[f.file] = { provider, size: f.size, mtime: f.mtime, ...(await read(f.file)) };
          changed = true;
        } catch {}
      }
    }
    for (const file of Object.keys(c.files)) {
      if (!live.has(file)) { delete c.files[file]; changed = true; }
    }
    if (changed) save();
    return c;
  }

  // provider -> { byDay: {day: {model: counts}}, byProject: {project: {model: counts}}, limits }
  async function summary() {
    inflight ||= scan().finally(() => { inflight = null; });
    const c = await inflight;
    const since = Date.now() - KEEP_MS;
    const seen = new Set();
    const out = {};
    for (const entry of Object.values(c.files)) {
      const p = (out[entry.provider] ||= { byDay: {}, byProject: {}, limits: null });
      if (entry.limits && (!p.limits || entry.limits.asOf > p.limits.asOf)) p.limits = entry.limits;
      for (const [key, t, model, project, input, output, cacheRead, cacheWrite] of entry.requests) {
        if (t < since || seen.has(key)) continue;
        seen.add(key);
        const counts = { inputTokens: input, outputTokens: output, cacheReadInputTokens: cacheRead, cacheCreationInputTokens: cacheWrite };
        addTo(((p.byDay[dayOf(t)] ||= {})[model] ||= zero()), counts);
        addTo(((p.byProject[project || 'unknown'] ||= {})[model] ||= zero()), counts);
      }
    }
    return out;
  }

  return { summary };
}

const zero = () => ({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
function addTo(into, c) { for (const k of Object.keys(into)) into[k] += c[k] || 0; }

// Local calendar day, so "today" on the page is the person's today.
function dayOf(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

module.exports = { createUsageHistory, readClaude, readCodex, dayOf };
