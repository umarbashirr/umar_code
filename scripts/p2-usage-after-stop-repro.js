'use strict';
// P2: a stopped chat must keep showing usage, and a stopped turn must count
// the request it aborted. The message sequences are the ones the Claude SDK
// sent in a live run of scripts/_p2-usage-stop-probe.mjs: an interrupted first
// turn of a query() gets no result message at all, and an interrupted later
// turn gets one whose modelUsage leaves the aborted request out.
const path = require('path');
const fs = require('fs');
const ROOT = process.env.TANDEM_ROOT || path.join(__dirname, '..');

const failures = [];
const pass = (name) => console.log(`PASS ${name}`);
const fail = (name, detail) => { console.log(`FAIL ${name}: ${detail}`); failures.push(name); };
const check = (name, ok, detail) => (ok ? pass(name) : fail(name, detail));

const MODEL = 'claude-sonnet-4-5-20250929';
const req = (input, cacheRead, cacheWrite, output = 1) => ({
  input_tokens: input,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
  output_tokens: output,
});
const start = (usage) => ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { model: MODEL, usage } } });
const delta = (output) => ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_delta', usage: { output_tokens: output } } });
const stop = { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_stop' } };
const assistant = (usage) => ({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [], usage } });
const result = (subtype, modelUsage) => ({ type: 'result', subtype, modelUsage });
const USER_STOP = { type: 'stop' };

async function main() {
  // The renderer's modules are ESM inside a commonjs package, so node is handed
  // the source directly rather than the file.
  const src = fs.readFileSync(path.join(ROOT, 'src/renderer/ui/lib/usage.js'), 'utf8');
  const lib = await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
  // What useAgent does with each message. On main it read usage off assistant
  // and result messages only and had nothing to do on Stop.
  const feed = lib.account || ((u, msg) => {
    if (msg.type === 'assistant' && !msg.parent_tool_use_id) return lib.withRequest(u, msg.message.usage);
    if (msg.type === 'result') return lib.withResult(u, msg);
    return u;
  });
  const onStop = lib.withStop || ((u) => u);
  const run = (msgs, model = MODEL) => {
    let u = { ...lib.blankUsage(), model };
    for (const m of msgs) u = m === USER_STOP ? onStop(u) : feed(u, m);
    return lib.totals(u);
  };

  // Stopped while the model was still thinking: the request is out and billed,
  // no assistant message has arrived, and no result ever does.
  const thinking = run([start(req(2, 0, 19571)), USER_STOP]);
  check('stopped-first-turn-shows-meter', thinking.any, `any=${thinking.any}, the meter hides`);
  check('stopped-first-turn-has-percent', thinking.percent > 0, `percent=${thinking.percent}`);
  check('stopped-first-turn-counts-spend', thinking.cacheWrite === 19571 && thinking.cost > 0,
    `cacheWrite=${thinking.cacheWrite} cost=${thinking.cost}`);

  // A finished turn, then a stopped one. The stopped turn's result repeats the
  // previous modelUsage, so without help its request is simply lost.
  const turn1 = { [MODEL]: { inputTokens: 10, outputTokens: 55, cacheReadInputTokens: 14803, cacheCreationInputTokens: 0, costUSD: 0.005 } };
  const finished = [start(req(10, 14803, 0, 4)), assistant(req(10, 14803, 0, 4)), delta(55), stop, result('success', turn1)];
  const once = run(finished);
  check('finished-turn-not-double-counted', once.input === 10 && once.output === 55 && once.cacheRead === 14803,
    `input=${once.input} output=${once.output} cacheRead=${once.cacheRead}`);

  const second = run([...finished,
    start(req(10, 14803, 111, 3)), assistant(req(10, 14803, 111, 3)), delta(40),
    USER_STOP, result('error_during_execution', turn1)]);
  check('stopped-later-turn-counts-aborted-request',
    second.cacheWrite === 111 && second.input === 20 && second.output === 95 && second.cacheRead === 29606,
    `input=${second.input} output=${second.output} cacheRead=${second.cacheRead} cacheWrite=${second.cacheWrite}`);
  check('stopped-later-turn-keeps-percent', second.percent > 0 && second.any, `percent=${second.percent}`);

  // Codex: turn/completed with status interrupted still carries thread totals.
  const codex = run([assistant(req(900, 90000, 0, 0)), USER_STOP,
    result('interrupted', { 'gpt-5.4': { inputTokens: 900, outputTokens: 20, cacheReadInputTokens: 90000, cacheCreationInputTokens: 0 } })], 'gpt-5.4');
  check('codex-stopped-turn-keeps-usage', codex.any && codex.percent > 0 && codex.output === 20,
    `any=${codex.any} percent=${codex.percent} output=${codex.output}`);

  console.log(failures.length ? `\n${failures.length} FAIL` : '\nall PASS');
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.log(`FAIL load: ${e.message}`); process.exit(1); });
