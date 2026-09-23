'use strict';
// Each CLI's subscription windows, in one shape the Usage page can draw:
// { name, windows: [{ id, label, usedPercent, resetsAt, asOf }], extra }.
//
// Claude answers through the SDK's usage call, which needs a session but not a
// turn: an idle query that is never sent a message asks the account for its
// limits and costs no tokens. Codex writes its latest limits into every
// transcript, so those are read back from disk when no chat is running.
const shellEnv = require('./shell-env');
const { claudeBinary } = require('./driver');

const PROBE_TIMEOUT_MS = 15000;
const PROBE_TTL_MS = 60000;

// The windows Claude names in a way a person would recognise. Anything else in
// rate_limits is an internal name with no label to give it, so it is left out.
const CLAUDE_WINDOWS = [
  ['five_hour', '5-hour session'],
  ['seven_day', 'Weekly, all models'],
  ['seven_day_opus', 'Weekly, Opus'],
  ['seven_day_sonnet', 'Weekly, Sonnet'],
  ['seven_day_oauth_apps', 'Weekly, other apps'],
  ['seven_day_cowork', 'Weekly, Cowork'],
];

function fromClaude(plan, asOf = Date.now()) {
  if (!plan || plan.error || !plan.rate_limits) return null;
  const r = plan.rate_limits;
  const windows = CLAUDE_WINDOWS
    .filter(([id]) => r[id] && r[id].utilization != null)
    .map(([id, label]) => ({ id, label, usedPercent: r[id].utilization, resetsAt: r[id].resets_at || null, asOf }));
  const x = r.extra_usage;
  const extra = x?.is_enabled
    ? { used: x.used_credits / 10 ** (x.decimal_places || 0), limit: x.monthly_limit / 10 ** (x.decimal_places || 0), currency: x.currency }
    : null;
  return { name: plan.subscription_type || null, windows, extra };
}

// Codex calls its windows primary and secondary and says how long each one is.
function windowLabel(minutes) {
  if (minutes === 300) return '5-hour session';
  if (minutes === 10080) return 'Weekly';
  if (minutes && minutes % 1440 === 0) return `${minutes / 1440}-day`;
  if (minutes && minutes % 60 === 0) return `${minutes / 60}-hour`;
  return minutes ? `${minutes}-minute` : 'Window';
}

// Takes either the rate_limits a transcript wrote or what a live codex session
// reports through planUsage(), which is already Claude-shaped.
function fromCodex(limits) {
  if (!limits) return null;
  if (limits.rate_limits) {
    const r = limits.rate_limits;
    return {
      name: limits.subscription_type || null,
      windows: [['five_hour', '5-hour session'], ['seven_day', 'Weekly']]
        .filter(([id]) => r[id])
        .map(([id, label]) => ({ id, label, usedPercent: r[id].utilization ?? 0, resetsAt: r[id].resets_at || null, asOf: Date.now() })),
      extra: null,
    };
  }
  const windows = ['primary', 'secondary']
    .filter((k) => limits[k])
    .map((k) => {
      const w = limits[k];
      const resetsAt = w.resets_at ? new Date(w.resets_at * 1000).toISOString() : null;
      // A window that reset after this was written has nothing spent in it now.
      const stale = resetsAt && Date.parse(resetsAt) < Date.now();
      return { id: k, label: windowLabel(w.window_minutes), usedPercent: stale ? 0 : (w.used_percent ?? 0), resetsAt: stale ? null : resetsAt, asOf: limits.asOf || null };
    });
  return { name: limits.plan_type || null, windows, extra: null };
}

let probed = null;
let probedAt = 0;
let probing = null;

async function claudeIdleProbe() {
  if (probed && Date.now() - probedAt < PROBE_TTL_MS) return probed;
  probing ||= (async () => {
    await shellEnv.ready();
    const bin = claudeBinary();
    if (!bin) return null;
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    let release;
    const idle = new Promise((r) => { release = r; });
    const abort = new AbortController();
    const q = sdk.query({
      prompt: (async function* () { await idle; })(),
      options: { cwd: require('os').homedir(), abortController: abort, env: shellEnv.env(), pathToClaudeCodeExecutable: bin },
    });
    try {
      const plan = await Promise.race([
        q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
        new Promise((_, no) => { setTimeout(() => no(new Error('timed out')), PROBE_TIMEOUT_MS); }),
      ]);
      probed = plan;
      probedAt = Date.now();
      return plan;
    } catch {
      return null;
    } finally {
      release();
      abort.abort();
    }
  })().finally(() => { probing = null; });
  return probing;
}

module.exports = { fromClaude, fromCodex, windowLabel, claudeIdleProbe };
