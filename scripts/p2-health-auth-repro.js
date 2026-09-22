'use strict';
const path = require('path');
const ROOT = process.env.TANDEM_ROOT || path.join(__dirname, '..');
const { Bridge } = require(path.join(ROOT, 'src/main/bridge.js'));

const failures = [];
const pass = (name) => console.log(`PASS ${name}`);
const fail = (name, detail) => { console.log(`FAIL ${name}: ${detail}`); failures.push(name); };

const PROJECT = path.resolve('/tmp/tandem-p2-health-secret-project');

async function hit(base, headers) {
  const res = await fetch(`${base}/health`, { headers });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { status: res.status, body, text };
}

(async () => {
  console.log('=== P2.1 /health requires bridge token ===');
  const bridge = new Bridge({ run: async () => ({}), cwd: PROJECT });
  await bridge.start();

  const open = await hit(bridge.url);
  const leaked = open.text.includes(PROJECT) || Array.isArray(open.body.tools);
  if (open.status === 401 && open.body.error === 'bad or missing x-tandem-token' && !leaked) {
    pass('unauthenticated-health-is-401');
  } else {
    fail('unauthenticated-health-is-401', JSON.stringify({ status: open.status, body: open.body }));
  }

  const wrong = await hit(bridge.url, { 'x-tandem-token': 'x'.repeat(bridge.token.length) });
  if (wrong.status === 401 && wrong.body.error === 'bad or missing x-tandem-token' && !wrong.text.includes(PROJECT)) {
    pass('wrong-token-health-is-401');
  } else {
    fail('wrong-token-health-is-401', JSON.stringify({ status: wrong.status, body: wrong.body }));
  }

  const ok = await hit(bridge.url, { 'x-tandem-token': bridge.token });
  const tools = ok.body.tools;
  const projects = ok.body.projects;
  if (
    ok.status === 200
    && ok.body.ok === true
    && ok.body.cwd === PROJECT
    && Array.isArray(projects)
    && projects.includes(PROJECT)
    && Array.isArray(tools)
    && tools.includes('navigate')
  ) {
    pass('token-health-returns-projects-and-tools');
  } else {
    fail('token-health-returns-projects-and-tools', JSON.stringify({ status: ok.status, body: ok.body }));
  }

  bridge.stop();
  console.log(failures.length ? `\n${failures.length} FAIL(s)` : '\nALL PASS');
  process.exit(failures.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(2); });
