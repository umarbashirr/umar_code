'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = process.env.TANDEM_ROOT || path.join(__dirname, '..');

const failures = [];
const pass = (name) => console.log(`PASS ${name}`);
const fail = (name, detail) => {
  console.log(`FAIL ${name}: ${detail}`);
  failures.push(name);
};
const check = (name, ok, detail) => (ok ? pass(name) : fail(name, detail));

let createUsageHistory;
try {
  ({ createUsageHistory } = require(path.join(ROOT, 'src/main/usage-history.js')));
} catch (e) {
  fail('usage-history-module', e.message);
  console.log(`\n${failures.length} FAIL`);
  process.exit(1);
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-history-repro-'));
process.env.CLAUDE_CONFIG_DIR = path.join(home, 'claude');
process.env.CODEX_HOME = path.join(home, 'codex');
const now = Date.now();
const iso = (ago) => new Date(now - ago).toISOString();

const write = (file, rows) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\nnot json\n');
};

const claudeLine = (id, req, output, ago = 60_000, cwd = '/work/app') => ({
  type: 'assistant', requestId: req, timestamp: iso(ago), cwd,
  message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 } },
});

const session = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-work-app', 'a.jsonl');
// One request streamed as three lines; the last carries the final output count.
write(session, [claudeLine('m1', 'r1', 1), claudeLine('m1', 'r1', 5), claudeLine('m1', 'r1', 40), claudeLine('m2', 'r2', 7)]);
// A resumed session copies m1 into a new file.
write(path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-work-app', 'b.jsonl'), [claudeLine('m1', 'r1', 40), claudeLine('m3', 'r3', 3, 60_000, '/work/app/.claude/worktrees/agent-x')]);
// Older than the page looks back.
write(path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-work-app', 'old.jsonl'), [claudeLine('m9', 'r9', 999, 40 * 86_400_000)]);

const tokenCount = (ago, input, cached, output, limits) => ({
  type: 'event_msg', timestamp: iso(ago),
  payload: {
    type: 'token_count',
    info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } },
    rate_limits: limits,
  },
});
write(path.join(process.env.CODEX_HOME, 'sessions', '2026', '09', '23', 'rollout-x.jsonl'), [
  { type: 'session_meta', timestamp: iso(90_000), payload: { cwd: '/work/cx' } },
  { type: 'turn_context', timestamp: iso(90_000), payload: { model: 'gpt-5.6-sol', cwd: '/work/cx' } },
  tokenCount(80_000, 1000, 400, 50, { plan_type: 'plus', primary: { used_percent: 6, window_minutes: 300, resets_at: 1 } }),
  tokenCount(70_000, 1000, 400, 50),
  tokenCount(60_000, 2500, 1400, 90, { plan_type: 'plus', primary: { used_percent: 9, window_minutes: 300, resets_at: 2 } }),
]);

const sum = (p, k) => Object.values(p.byDay).flatMap(Object.values).reduce((n, c) => n + c[k], 0);

(async () => {
  const cacheDir = path.join(home, 'cache');
  let s = await createUsageHistory(cacheDir).summary();

  check('claude-streamed-lines-count-once', sum(s.claude, 'outputTokens') === 40 + 7 + 3,
    `output=${sum(s.claude, 'outputTokens')}, want 50`);
  check('claude-resumed-copy-counts-once', sum(s.claude, 'inputTokens') === 30,
    `input=${sum(s.claude, 'inputTokens')}, want 30 (three requests)`);
  check('claude-old-file-ignored', sum(s.claude, 'outputTokens') < 999, 'a 40-day-old request was counted');
  check('claude-by-project', !!s.claude.byProject['/work/app'], `projects=${Object.keys(s.claude.byProject)}`);
  check('worktree-counts-as-its-project', Object.keys(s.claude.byProject).join() === '/work/app',
    `projects=${Object.keys(s.claude.byProject)}`);

  check('codex-total-steps', sum(s.codex, 'inputTokens') === 1100 && sum(s.codex, 'cacheReadInputTokens') === 1400 && sum(s.codex, 'outputTokens') === 90,
    `input=${sum(s.codex, 'inputTokens')} cached=${sum(s.codex, 'cacheReadInputTokens')} output=${sum(s.codex, 'outputTokens')}, want 1100/1400/90`);
  check('codex-model-from-turn-context', !!Object.values(s.codex.byDay)[0]?.['gpt-5.6-sol'], JSON.stringify(s.codex.byDay));
  check('codex-latest-limits', s.codex.limits?.primary?.used_percent === 9, JSON.stringify(s.codex.limits));

  // A changed file is read again; an unchanged one comes from the cache.
  fs.appendFileSync(session, JSON.stringify(claudeLine('m4', 'r4', 100)) + '\n');
  s = await createUsageHistory(cacheDir).summary();
  check('cache-rereads-changed-file', sum(s.claude, 'outputTokens') === 150, `output=${sum(s.claude, 'outputTokens')}, want 150`);

  fs.rmSync(home, { recursive: true, force: true });
  console.log(failures.length ? `\n${failures.length} FAIL` : '\nall PASS');
  process.exit(failures.length ? 1 : 0);
})();
