'use strict';
// Parking a chat (switching away from it) stopped its CLI process whenever the
// main turn was over, which also killed any background agent still running in
// it. This drives a real Claude session: one background agent that sleeps, a
// main turn that ends while it runs, and checks that the session says it is
// still working until the agent reports back.
//
// Costs a few cents of Haiku. Needs the claude CLI and a login.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = process.env.TANDEM_ROOT || path.join(__dirname, '..');
const { AgentSession } = require(path.join(ROOT, 'src/main/agent.js'));

const failures = [];
const pass = (name) => console.log(`PASS ${name}`);
const fail = (name, detail) => {
  console.log(`FAIL ${name}: ${detail}`);
  failures.push(name);
};
const check = (name, ok, detail) => (ok ? pass(name) : fail(name, detail));
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

const until = async (pred, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(250);
  }
  return false;
};

(async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'park-repro-'));
  const a = new AgentSession({ cwd, model: 'haiku', mode: 'bypass', invoke: async () => ({}) });
  const seen = { results: 0, started: 0, notified: 0 };
  a.on('message', (m) => {
    if (m.type === 'result') seen.results += 1;
    if (m.type === 'system' && m.subtype === 'task_started') seen.started += 1;
    if (m.type === 'system' && m.subtype === 'task_notification') seen.notified += 1;
  });
  await a.start();
  a.send('Launch exactly one subagent with the Agent tool, with run_in_background set to true. '
    + 'Its prompt: "Run the shell command `sleep 25`, then reply with the word done." '
    + 'After launching it, reply with the single word "launched" and end your turn. Do not wait for it.');

  await until(() => seen.results >= 1, 120000);
  check('main-turn-ended', seen.results >= 1, `results=${seen.results}`);
  check('background-agent-started', seen.started >= 1, `task_started=${seen.started}`);
  check('busy-is-false-after-turn', a.busy === false, `busy=${a.busy}`);
  check('working-while-agent-runs', a.working === true && seen.notified === 0,
    `working=${a.working} notified=${seen.notified}`);

  await until(() => seen.notified >= 1, 120000);
  check('agent-reported-back', seen.notified >= 1, `task_notification=${seen.notified}`);
  // Whatever the agent left running, a background shell say, reports back on
  // its own; only then is the chat idle.
  check('not-working-once-everything-reported', await until(() => !a.working, 120000),
    `working=${a.working} busy=${a.busy}`);

  a.stop();
  fs.rmSync(cwd, { recursive: true, force: true });
  console.log(failures.length ? `\n${failures.length} FAIL` : '\nall PASS');
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.log(`FAIL crashed: ${e.message}`); process.exit(1); });
