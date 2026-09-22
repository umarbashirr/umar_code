'use strict';
const path = require('path');
const fs = require('fs');
const ROOT = process.env.TANDEM_ROOT || path.join(__dirname, '..');

const { decide } = require(path.join(ROOT, 'src/main/modes.js'));
const { PaneLease, READS } = require(path.join(ROOT, 'src/main/pane-lease.js'));
const { Bridge } = require(path.join(ROOT, 'src/main/bridge.js'));

const failures = [];
const pass = (name) => console.log(`PASS ${name}`);
const fail = (name, detail) => { console.log(`FAIL ${name}: ${detail}`); failures.push(name); };

async function checkDecide() {
  const cases = [
    ['plan', 'mcp__preview__browser_snapshot', 'allow'],
    ['plan', 'mcp__preview__browser_navigate', 'ask'],
    ['plan', 'mcp__preview__browser_evaluate', 'ask'],
    ['ask', 'mcp__preview__browser_click', 'ask'],
    ['ask', 'mcp__preview__browser_text', 'allow'],
    ['always', 'mcp__preview__browser_snapshot', 'ask'],
    ['bypass', 'mcp__preview__browser_navigate', 'allow'],
    ['auto', 'mcp__preview__browser_fill', 'ask'],
  ];
  for (const [mode, tool, want] of cases) {
    const got = decide(mode, tool, {}).action;
    const label = `decide(${mode}, ${tool}) => ${want}`;
    if (got === want) pass(label);
    else fail(label, `got ${got}`);
  }
  for (const tool of ['navigate', 'mcp__tandem__browser_navigate']) {
    const got = decide('plan', tool, {}).action;
    const label = `decide(plan, ${tool}) => ask`;
    if (got === 'ask') pass(label);
    else fail(label, `got ${got}`);
  }
}

async function checkLeaseQueuesWriters() {
  const lease = new PaneLease();
  const a = { id: 'claude', label: 'claude', chat: 'a' };
  const b = { id: 'bridge', label: 'bridge', chat: 'b' };
  const busyA = await lease.acquire('navigate', a);
  if (busyA) fail('lease-acquire-a', busyA);
  else pass('lease-acquire-a');

  const waitPromise = lease.acquire('click', b);
  await new Promise((r) => setTimeout(r, 50));
  if (lease.holder?.id === 'claude' && lease.queue.length >= 1) {
    pass('lease-queues-second-writer');
  } else {
    fail('lease-queues-second-writer', `holder=${lease.holder?.id} queue=${lease.queue.length}`);
  }
  lease.release('claude');
  await waitPromise;
  lease.stop();
}

async function checkDebugRoutes() {
  let decideHit = false;
  let askHit = false;
  // debug defaults false (packaged shape). Handlers present must still 404.
  const bridge = new Bridge({
    run: async () => { throw new Error('tool path unused'); },
    decide: (d) => { decideHit = true; return { ok: true, decision: d }; },
    ask: async (t) => { askHit = true; return { ok: true, text: t }; },
    command: () => ({ ok: true }),
    captureWindow: async () => ({ path: '/tmp/x.png' }),
  });
  await bridge.start();
  const token = bridge.token;
  const base = bridge.url;

  async function hit(pathname) {
    const res = await fetch(`${base}${pathname}`, {
      headers: { 'x-tandem-token': token },
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  const decideRes = await hit('/debug/decide?decision=allow');
  if (decideRes.status === 404 && !decideHit) pass('debug-decide-gated');
  else fail('debug-decide-gated', JSON.stringify({ ...decideRes, decideHit }));

  const askRes = await hit('/debug/ask?text=hi');
  if (askRes.status === 404 && !askHit) pass('debug-ask-gated');
  else fail('debug-ask-gated', JSON.stringify({ ...askRes, askHit }));

  const tools = await hit('/tools');
  if (tools.status === 200) pass('tool-routes-still-open');
  else fail('tool-routes-still-open', JSON.stringify(tools));

  bridge.stop();
}

async function checkDoorWiring() {
  const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src/main/bridge.js'), 'utf8');
  const indexSrc = fs.readFileSync(path.join(ROOT, 'src/main/index.js'), 'utf8');

  if (/require\('\.\/tools'\)/.test(bridgeSrc) && !/runTool/.test(bridgeSrc)) {
    pass('bridge-has-no-runTool');
  } else {
    fail('bridge-has-no-runTool', 'bridge.js still imports or names runTool');
  }

  if (/async function driveTool\(/.test(indexSrc)
    && /invoke:[\s\S]*?driveTool\(tool/.test(indexSrc)
    && /run:\s*\(tool,\s*args,\s*from\)\s*=>/.test(indexSrc)) {
    pass('driveTool-is-the-door');
  } else {
    fail('driveTool-is-the-door', 'invoke or bridge run missing driveTool wiring');
  }
}

(async () => {
  console.log('=== P0 browser-trust gate ===');
  console.log('READS:', [...READS].join(', '));
  await checkDecide();
  await checkLeaseQueuesWriters();
  await checkDebugRoutes();
  await checkDoorWiring();
  console.log(failures.length ? `\n${failures.length} FAIL(s)` : '\nALL PASS');
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
