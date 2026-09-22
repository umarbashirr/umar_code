'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const ROOT = process.env.TANDEM_ROOT || path.join(__dirname, '..');

const { Bridge } = require(path.join(ROOT, 'src/main/bridge.js'));

const failures = [];
const pass = (name) => console.log(`PASS ${name}`);
const fail = (name, detail) => { console.log(`FAIL ${name}: ${detail}`); failures.push(name); };

async function hit(base, pathname, headers) {
  const res = await fetch(`${base}${pathname}`, { headers });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function checkPrivilegeSplit() {
  let decideHit = false;
  let askHit = false;
  let commandHit = false;
  const bridge = new Bridge({
    run: async (name) => ({ tool: name }),
    debug: true,
    decide: (d) => { decideHit = true; return { ok: true, decision: d }; },
    ask: async (t) => { askHit = true; return { ok: true, text: t }; },
    command: () => { commandHit = true; return { ok: true }; },
    captureWindow: async () => ({ path: '/tmp/x.png' }),
  });
  await bridge.start();

  const toolToken = bridge.token;
  const debugToken = bridge.debugToken;
  const base = bridge.url;
  const toolHeaders = { 'x-tandem-token': toolToken };

  const decideWithTool = await hit(base, '/debug/decide?decision=allow', toolHeaders);
  if (decideWithTool.status !== 200 && !decideHit) pass('tool-token-cannot-decide');
  else fail('tool-token-cannot-decide', JSON.stringify({ ...decideWithTool, decideHit }));

  decideHit = false;
  const askWithTool = await hit(base, '/debug/ask?text=inject', toolHeaders);
  if (askWithTool.status !== 200 && !askHit) pass('tool-token-cannot-ask');
  else fail('tool-token-cannot-ask', JSON.stringify({ ...askWithTool, askHit }));

  commandHit = false;
  const commandWithTool = await hit(base, '/debug/command?name=noop', toolHeaders);
  if (commandWithTool.status !== 200 && !commandHit) pass('tool-token-cannot-command');
  else fail('tool-token-cannot-command', JSON.stringify({ ...commandWithTool, commandHit }));

  const tools = await hit(base, '/tools', toolHeaders);
  if (tools.status === 200) pass('tool-token-still-opens-tools');
  else fail('tool-token-still-opens-tools', JSON.stringify(tools));

  if (typeof debugToken === 'string' && debugToken.length > 0 && debugToken !== toolToken) {
    pass('debug-token-distinct');
  } else {
    fail('debug-token-distinct', `debugToken=${String(debugToken)}`);
  }

  if (typeof debugToken === 'string' && debugToken.length) {
    decideHit = false;
    const decideWithDebug = await hit(base, '/debug/decide?decision=allow', {
      'x-tandem-token': toolToken,
      'x-tandem-debug-token': debugToken,
    });
    if (decideWithDebug.status === 200 && decideHit) pass('debug-token-can-decide');
    else fail('debug-token-can-decide', JSON.stringify({ ...decideWithDebug, decideHit }));

    askHit = false;
    const askWithDebug = await hit(base, '/debug/ask?text=hi', {
      'x-tandem-token': toolToken,
      'x-tandem-debug-token': debugToken,
    });
    if (askWithDebug.status === 200 && askHit) pass('debug-token-can-ask');
    else fail('debug-token-can-ask', JSON.stringify({ ...askWithDebug, askHit }));
  }

  bridge.stop();
}

async function checkPublishedSurface() {
  const bridge = new Bridge({
    run: async () => ({}),
    debug: true,
    decide: () => ({ ok: true }),
    ask: async () => ({ ok: true }),
  });
  await bridge.start();

  const env = bridge.env();
  if (env.TANDEM_TOKEN === bridge.token && env.TANDEM_BRIDGE_URL === bridge.url) {
    pass('env-publishes-tool-token-only-url');
  } else {
    fail('env-publishes-tool-token-only-url', JSON.stringify(env));
  }

  if (!Object.values(env).includes(bridge.debugToken)) pass('env-omits-debug-token');
  else fail('env-omits-debug-token', 'debug token leaked into env()');

  if (bridge.state?.token === bridge.token && bridge.state?.token !== bridge.debugToken) {
    pass('disk-state-is-tool-token');
  } else {
    fail('disk-state-is-tool-token', JSON.stringify(bridge.state));
  }

  if (bridge.state && !Object.values(bridge.state).includes(bridge.debugToken)) {
    pass('disk-state-omits-debug-token');
  } else {
    fail('disk-state-omits-debug-token', JSON.stringify(bridge.state));
  }

  bridge.stop();
}

async function checkPackagedGateStillHolds() {
  let decideHit = false;
  const bridge = new Bridge({
    run: async () => ({}),
    debug: false,
    decide: (d) => { decideHit = true; return { ok: true, decision: d }; },
  });
  await bridge.start();
  const res = await hit(bridge.url, '/debug/decide?decision=allow', {
    'x-tandem-token': bridge.token,
  });
  if (res.status === 404 && !decideHit) pass('packaged-debug-still-404');
  else fail('packaged-debug-still-404', JSON.stringify({ ...res, decideHit }));
  bridge.stop();
}

async function checkConstantTimeCompare() {
  const src = fs.readFileSync(path.join(ROOT, 'src/main/bridge.js'), 'utf8');
  if (/timingSafeEqual/.test(src)) pass('auth-uses-timingSafeEqual');
  else fail('auth-uses-timingSafeEqual', 'missing crypto.timingSafeEqual in bridge.js');

  const bridge = new Bridge({ run: async () => ({}) });
  await bridge.start();
  const bad = await hit(bridge.url, '/tools', { 'x-tandem-token': 'x'.repeat(bridge.token.length) });
  if (bad.status === 401) pass('wrong-token-rejected');
  else fail('wrong-token-rejected', JSON.stringify(bad));

  const short = await hit(bridge.url, '/tools', { 'x-tandem-token': 'nope' });
  if (short.status === 401) pass('short-token-rejected');
  else fail('short-token-rejected', JSON.stringify(short));

  const high = String.fromCharCode(...Array(bridge.token.length).fill(0xff));
  const highRes = await hit(bridge.url, '/tools', { 'x-tandem-token': high });
  if (highRes.status === 401) pass('high-byte-token-rejected');
  else fail('high-byte-token-rejected', JSON.stringify(highRes));

  const a = Buffer.from(bridge.token);
  const b = Buffer.from('0'.repeat(bridge.token.length));
  const equal = crypto.timingSafeEqual(a, b);
  if (equal === false) pass('timingSafeEqual-rejects-mismatch');
  else fail('timingSafeEqual-rejects-mismatch', 'unexpected equal');

  bridge.stop();
}

async function checkIndexDoesNotShipDebugToPty() {
  const indexSrc = fs.readFileSync(path.join(ROOT, 'src/main/index.js'), 'utf8');
  if (!/bridge\.env\(\)/.test(indexSrc)) {
    fail('index-pty-uses-bridge-env-only', 'term/Codex path no longer calls bridge.env()');
    return;
  }
  const leaked =
    /TANDEM_DEBUG_TOKEN/.test(indexSrc)
    || /bridge:info[\s\S]{0,200}debugToken/.test(indexSrc)
    || /bridgeEnv:\s*[^\n]*debugToken/.test(indexSrc)
    || /env:\s*\{[^}]*debugToken/.test(indexSrc);
  if (!leaked) pass('index-pty-uses-bridge-env-only');
  else fail('index-pty-uses-bridge-env-only', 'index may leak debug token into PTY/Codex/renderer');
}

(async () => {
  console.log('=== P0 bridge-token privilege split ===');
  await checkPrivilegeSplit();
  await checkPublishedSurface();
  await checkPackagedGateStillHolds();
  await checkConstantTimeCompare();
  await checkIndexDoesNotShipDebugToPty();
  console.log(failures.length ? `\n${failures.length} FAIL(s)` : '\nALL PASS');
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
