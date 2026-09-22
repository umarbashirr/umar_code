'use strict';
// Executable check of P0 browser-trust bugs against the live modules.
// Expectation once fixed: plan/ask deny browser writes; bridge applies mode+lease;
// packaged builds refuse /debug/*.
const path = require('path');
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
  // Bridge bare names and Codex MCP names must share the door.
  for (const tool of ['navigate', 'mcp__tandem__browser_navigate']) {
    const got = decide('plan', tool, {}).action;
    const label = `decide(plan, ${tool}) => ask`;
    if (got === 'ask') pass(label);
    else fail(label, `got ${got}`);
  }
}

async function checkLeaseOnBridgePath() {
  // Simulate what bridge #run does today: runTool with no lease.
  // Prove that two writers can interleave without lease on that path.
  const lease = new PaneLease();
  const a = { id: 'claude', label: 'claude', chat: 'a' };
  const b = { id: 'bridge', label: 'bridge', chat: 'b' };
  const busyA = await lease.acquire('navigate', a);
  if (busyA) fail('lease-acquire-a', busyA);
  else pass('lease-acquire-a');

  // Without going through lease, bridge "succeeds" while A holds the pane.
  // With lease, B must wait or get a busy error.
  let bridgeWouldBlock = false;
  const waitPromise = lease.acquire('click', b).then((busy) => {
    bridgeWouldBlock = !!busy || true; // acquire either waits then takes, or times out with message
    return busy;
  });
  // Give it a tick: B should be queued, not free to act.
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
  const bridge = new Bridge({
    getPane: () => null,
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
  if (decideRes.status === 200 && decideHit) {
    fail('debug-decide-reachable-with-token', 'packaged builds must not expose this; today it works whenever wired');
  } else if (decideRes.status === 404) {
    pass('debug-decide-gated');
  } else {
    fail('debug-decide-reachable-with-token', JSON.stringify(decideRes));
  }

  const askRes = await hit('/debug/ask?text=hi');
  if (askRes.status === 200 && askHit) {
    fail('debug-ask-reachable-with-token', 'token approved a prompt inject');
  } else if (askRes.status === 404) {
    pass('debug-ask-gated');
  } else {
    fail('debug-ask-reachable-with-token', JSON.stringify(askRes));
  }

  // Tool routes must remain.
  const tools = await hit('/tools');
  if (tools.status === 200) pass('tool-routes-still-open');
  else fail('tool-routes-still-open', JSON.stringify(tools));

  bridge.stop();
}

async function checkBridgeRunSkipsMode() {
  // Today's Bridge.#run calls runTool directly. Prove by inspecting source.
  const fs = require('fs');
  const src = fs.readFileSync(path.join(ROOT, 'src/main/bridge.js'), 'utf8');
  const hasDirectRunTool = /async #run\([\s\S]*?return runTool\(/.test(src);
  const hasRunCallback = /this\.runFn|this\.run\b/.test(src) && /constructor\(\{[^}]*run/.test(src);
  if (hasDirectRunTool && !hasRunCallback) {
    fail('bridge-run-goes-through-mode-lease-door', 'Bridge.#run still calls runTool directly with no mode/lease callback');
  } else if (hasRunCallback) {
    pass('bridge-run-goes-through-mode-lease-door');
  } else {
    fail('bridge-run-goes-through-mode-lease-door', 'could not classify bridge #run');
  }

  // Index wires lease only on Claude invoke.
  const index = fs.readFileSync(path.join(ROOT, 'src/main/index.js'), 'utf8');
  const invokeHasLease = /invoke:[\s\S]*?l\.acquire\(tool/.test(index);
  const bridgeCtor = index.match(/new Bridge\(\{[\s\S]*?\}\)/)?.[0] || '';
  const bridgeHasRun = /\brun\s*:/.test(bridgeCtor);
  if (invokeHasLease) pass('claude-invoke-has-lease');
  else fail('claude-invoke-has-lease', 'invoke missing lease');
  if (bridgeHasRun) pass('bridge-wired-with-run-callback');
  else fail('bridge-wired-with-run-callback', 'Bridge constructed without run callback');
}

(async () => {
  console.log('=== P0 browser-trust repro (expect FAIL before fix) ===');
  console.log('READS:', [...READS].join(', '));
  await checkDecide();
  await checkLeaseOnBridgePath();
  await checkDebugRoutes();
  await checkBridgeRunSkipsMode();
  console.log(failures.length ? `\n${failures.length} FAIL(s)` : '\nALL PASS');
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
