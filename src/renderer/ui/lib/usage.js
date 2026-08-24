// Token and cost accounting, read out of the SDK message stream.
//
// `modelUsage` on a result message is the field to account from: it is broken
// down per model, it counts subagents and the CLI's own internal calls, and it
// is cumulative across the turns of one query(). The turn-level `usage` field
// next to it covers the main loop only, and summing per-turn numbers double
// counts everything, so neither is used here.

// List prices per million tokens, USD, matched loosest last so both
// `claude-opus-5[1m]` and `claude-3-5-haiku-20241022` land somewhere sensible.
// Only used when the SDK reports no cost of its own.
const PRICES = [
  [/fable|mythos/, 10, 50],
  [/opus/, 5, 25],
  [/sonnet/, 3, 15],
  [/haiku/, 1, 5],
];

// A cache read costs a tenth of fresh input, a cache write a quarter more than
// it. Keeping the four counts apart is the whole point of the breakdown: one
// blended token total hides the fact that most of a long session is cache
// reads, which are the cheapest tokens there are.
const READ_RATE = 0.1;
const WRITE_RATE = 1.25;

const priceOf = (model = '') => PRICES.find(([re]) => re.test(model))?.slice(1) || [5, 25];

const windowOf = (model = '') => (/haiku/.test(model) ? 200_000 : 1_000_000);

export const blankUsage = () => ({
  // Totals banked from earlier query() calls under this chat. A chat parked
  // while idle is resumed under a fresh query(), and modelUsage starts over.
  banked: {},
  // What the query() running now has reported, replaced whole each result.
  live: {},
  // Size of the last request on the main thread, which is what fills the
  // window. Not a running total: it is one number that also goes down.
  context: 0,
  window: 0,
  model: null,
  turns: 0,
});

const ZERO = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  costUSD: 0,
  contextWindow: 0,
};

const add = (a = ZERO, b = ZERO) => ({
  inputTokens: (a.inputTokens || 0) + (b.inputTokens || 0),
  outputTokens: (a.outputTokens || 0) + (b.outputTokens || 0),
  cacheReadInputTokens: (a.cacheReadInputTokens || 0) + (b.cacheReadInputTokens || 0),
  cacheCreationInputTokens: (a.cacheCreationInputTokens || 0) + (b.cacheCreationInputTokens || 0),
  costUSD: (a.costUSD || 0) + (b.costUSD || 0),
  contextWindow: b.contextWindow || a.contextWindow || 0,
});

const bank = (into, from) => {
  const out = { ...into };
  for (const [model, m] of Object.entries(from)) out[model] = add(out[model], m);
  return out;
};

const spent = (all) => Object.values(all)
  .reduce((n, m) => n + (m.inputTokens || 0) + (m.outputTokens || 0) + (m.cacheReadInputTokens || 0), 0);

// The tokens a request carried. Output is left out: this is what was sent, and
// it is the number the window fills with.
export const requestSize = (u) => (u?.input_tokens || 0)
  + (u?.cache_read_input_tokens || 0)
  + (u?.cache_creation_input_tokens || 0);

// An assistant message on the main thread. A subagent has its own window, so
// its requests say nothing about how full this conversation is.
export function withRequest(usage, apiUsage) {
  const size = requestSize(apiUsage);
  return size ? { ...usage, context: size } : usage;
}

export function withResult(usage, msg) {
  const live = msg.modelUsage || {};
  const now = spent(live);
  // A turn that died on the way up can report zeroes. Taking those would throw
  // away everything this query() had counted, so they are simply ignored.
  if (!now) return { ...usage, turns: usage.turns + 1 };
  // A total that went backwards means a new query() started and began counting
  // again, so what the last one reported is banked before the new numbers take
  // over. Self-correcting, which beats trying to catch every restart.
  const restarted = now < spent(usage.live);
  // Only the main-loop model's own entry: a Haiku subagent in the list has a
  // 200k window and nothing to say about the window this chat is filling.
  const entry = live[usage.model]
    || Object.values(live).find((m) => m.canonicalModel && usage.model?.startsWith(m.canonicalModel));
  return {
    ...usage,
    banked: restarted ? bank(usage.banked, usage.live) : usage.banked,
    live,
    turns: usage.turns + 1,
    window: entry?.contextWindow || usage.window,
  };
}

// Everything the panel draws, from the two halves put back together.
export function totals(usage) {
  const all = bank(usage.banked, usage.live);
  const rows = [];
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  let estimated = false;

  for (const [model, m] of Object.entries(all)) {
    input += m.inputTokens || 0;
    output += m.outputTokens || 0;
    cacheRead += m.cacheReadInputTokens || 0;
    cacheWrite += m.cacheCreationInputTokens || 0;
    let own = m.costUSD || 0;
    if (!own) {
      const [inRate, outRate] = priceOf(model);
      own = ((m.inputTokens || 0) * inRate
        + (m.cacheReadInputTokens || 0) * inRate * READ_RATE
        + (m.cacheCreationInputTokens || 0) * inRate * WRITE_RATE
        + (m.outputTokens || 0) * outRate) / 1e6;
      if (own) estimated = true;
    }
    cost += own;
    rows.push({ model, cost: own, tokens: (m.inputTokens || 0) + (m.outputTokens || 0) + (m.cacheReadInputTokens || 0) + (m.cacheCreationInputTokens || 0) });
  }

  rows.sort((a, b) => b.cost - a.cost);
  const window = usage.window || windowOf(usage.model || '');
  return {
    input, output, cacheRead, cacheWrite, cost, rows, estimated,
    window,
    context: usage.context,
    percent: window ? Math.min(999, Math.round((usage.context / window) * 100)) : 0,
    turns: usage.turns,
    model: usage.model,
    any: usage.context > 0 || rows.length > 0,
  };
}

// A decimal place only while it still says something, and never a trailing
// zero: the window reads `1M`, not `1.00M`.
const trim = (s) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);

export function compact(n) {
  if (!n) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) {
    const k = n / 1000;
    return `${trim(k < 9.95 ? k.toFixed(1) : String(Math.round(k)))}k`;
  }
  const m = n / 1e6;
  return `${trim(m < 9.995 ? m.toFixed(2) : m.toFixed(1))}M`;
}

export function money(n) {
  if (!n) return '$0';
  if (n < 0.01) return '<$0.01';
  if (n < 1) return `$${n.toFixed(3)}`;
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${Math.round(n)}`;
}

// Trim the run of digits and brackets the picker also hides, so the popover
// header reads the way the model dropdown does.
export const shortModel = (m) => String(m || '')
  .replace(/^claude-/, '')
  .replace(/-\d{8}$/, '');

export function resetsIn(iso) {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = mins / 60;
  return hours < 24 ? `${hours.toFixed(hours < 10 ? 1 : 0)}h` : `${Math.round(hours / 24)}d`;
}
