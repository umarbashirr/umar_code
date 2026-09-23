// Live probe: what the Claude SDK emits when a turn is interrupted mid-reply.
// Turn 1 runs to completion, turn 2 is interrupted after [ms]. Spends a few
// cents. Usage: node scripts/_p2-usage-stop-probe.mjs [ms] [model]
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { query } = await import(require.resolve('@anthropic-ai/claude-agent-sdk'));
const { claudeBinary } = require(path.join(import.meta.dirname, '../src/main/driver.js'));

setInterval(() => {}, 1000);
const waitMs = Number(process.argv[2] || 4000);
const model = process.argv[3] || 'haiku';
let next;
const say = (text) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text }] },
  parent_tool_use_id: null,
  session_id: '',
});
const first = process.argv[4] === 'first';
async function* input() {
  if (first) {
    yield say('Think very carefully, then write a 2000 word essay about rivers. Use no tools.');
    setTimeout(() => q.interrupt(), waitMs);
    await new Promise(() => {});
  }
  yield say('Reply with the single word: ok');
  await new Promise((r) => { next = r; });
  yield say('Write a 2000 word essay about rivers. Use no tools.');
  await new Promise(() => {});
}

const q = query({
  prompt: input(),
  options: {
    model,
    includePartialMessages: true,
    settingSources: [],
    cwd: process.cwd(),
    ...(claudeBinary() ? { pathToClaudeCodeExecutable: claudeBinary() } : {}),
  },
});

let deltas = 0;
let results = 0;
for await (const m of q) {
  if (m.type === 'stream_event') {
    const e = m.event;
    if (e.type === 'content_block_delta') { deltas += 1; continue; }
    console.log('stream_event', e.type, JSON.stringify(e.message?.usage || e.usage || ''), `deltas=${deltas}`);
    continue;
  }
  const extra = m.type === 'assistant' ? `${JSON.stringify(m.message.usage)} stop=${m.message.stop_reason}`
    : m.type === 'result' ? JSON.stringify({ modelUsage: m.modelUsage, usage: m.usage })
      : '';
  console.log(m.type, m.subtype || '', extra);
  if (first && m.type === 'result') setTimeout(() => process.exit(0), 1000);
  if (!first && m.type === 'result' && ++results === 1) {
    console.log('--- turn 2');
    next();
    setTimeout(async () => {
      console.log(`>>> interrupt at ${waitMs}ms`);
      await q.interrupt().catch((e) => console.log('interrupt threw', e.message));
      setTimeout(() => process.exit(0), 5000);
    }, waitMs);
  }
}
console.log('stream ended');
