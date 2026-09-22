'use strict';
// Runtime probe for P1.5: catalogSessions keeps Claude+matching cwd only.
// Run: electron scripts/_p1-catalog-ops-probe.js --no-sandbox
const { app } = require('electron');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { AgentSession } = require(path.join(ROOT, 'src/main/agent'));
const { CodexSession } = require(path.join(ROOT, 'src/main/codex'));

const failures = [];
const pass = (name) => console.log(`PASS ${name}`);
const fail = (name, detail) => {
  console.log(`FAIL ${name}: ${detail}`);
  failures.push(name);
};

app.whenReady().then(async () => {
  const sessions = new Map();
  const closed = new AgentSession({ cwd: '/proj-a', invoke: async () => ({}) });
  closed.closed = true;

  sessions.set('claude-a', new AgentSession({ cwd: '/proj-a', invoke: async () => ({}) }));
  sessions.set('claude-b', new AgentSession({ cwd: '/proj-b', invoke: async () => ({}) }));
  sessions.set('codex-a', new CodexSession({ cwd: '/proj-a', bridgeEnv: {} }));
  sessions.set('closed-a', closed);

  const liveSessions = () => [...sessions.values()].filter((a) => !a.closed);
  const catalogSessions = (dir) => liveSessions().filter((a) => a instanceof AgentSession && a.cwd === dir);

  const a = catalogSessions('/proj-a');
  if (a.length === 1 && a[0] === sessions.get('claude-a')) pass('runtime-keeps-matching-claude');
  else fail('runtime-keeps-matching-claude', `got ${a.length}`);

  const b = catalogSessions('/proj-b');
  if (b.length === 1 && b[0] === sessions.get('claude-b')) pass('runtime-other-project');
  else fail('runtime-other-project', `got ${b.length}`);

  if (catalogSessions('/missing').length === 0) pass('runtime-empty');
  else fail('runtime-empty', 'expected none');

  // Prove Codex stubs are excluded even when cwd matches.
  if (!a.some((s) => s instanceof CodexSession)) pass('runtime-excludes-codex');
  else fail('runtime-excludes-codex', 'CodexSession leaked into targets');

  // Simulate the old blind fan-out vs the new filter.
  const blind = liveSessions();
  const scoped = catalogSessions('/proj-a');
  if (blind.length === 3 && scoped.length === 1) pass('runtime-blind-vs-scoped');
  else fail('runtime-blind-vs-scoped', `blind=${blind.length} scoped=${scoped.length}`);

  for (const a of sessions.values()) {
    try { a.stop?.(); } catch {}
  }

  if (failures.length) {
    console.error(`\n${failures.length} failure(s)`);
    app.exit(1);
  } else {
    console.log('\nall runtime checks passed');
    app.exit(0);
  }
}).catch((e) => {
  console.error(e);
  app.exit(1);
});
