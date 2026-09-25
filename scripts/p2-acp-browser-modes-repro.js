#!/usr/bin/env node
'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = process.env.TANDEM_ROOT || path.join(__dirname, '..');
const {
  pickMode, toolOf, ACP_INSTRUCTIONS, AcpSession,
} = require(path.join(ROOT, 'src/main/providers/acp-session.js'));
const { decide, decideCodex } = require(path.join(ROOT, 'src/main/modes.js'));
const { INSTRUCTIONS } = require(path.join(ROOT, 'src/shared/browser-tools.js'));

const failures = [];
const pass = (name) => console.log(`PASS ${name}`);
const fail = (name, detail) => {
  console.log(`FAIL ${name}: ${detail}`);
  failures.push(name);
};
const check = (name, ok, detail) => (ok ? pass(name) : fail(name, detail || 'failed'));

const OPENCODE_MODES = [{ id: 'build' }, { id: 'plan' }];
const CURSOR_MODES = [{ id: 'ask' }, { id: 'plan' }, { id: 'bypass' }];

function checkPickMode() {
  check('ask-on-cursor', pickMode('ask', CURSOR_MODES) === 'ask');
  check('bypass-on-cursor', pickMode('bypass', CURSOR_MODES) === 'bypass');
  check('plan-on-opencode', pickMode('plan', OPENCODE_MODES) === 'plan');
  check('ask-falls-to-build', pickMode('ask', OPENCODE_MODES) === 'build', pickMode('ask', OPENCODE_MODES));
  check('auto-falls-to-build', pickMode('auto', OPENCODE_MODES) === 'build', pickMode('auto', OPENCODE_MODES));
  check('bypass-never-build', pickMode('bypass', OPENCODE_MODES) === null, pickMode('bypass', OPENCODE_MODES));
  check('always-never-build', pickMode('always', OPENCODE_MODES) === null, pickMode('always', OPENCODE_MODES));
}

function checkToolOf() {
  check(
    'other-browser-title',
    toolOf({ kind: 'other', title: 'browser_snapshot' }) === 'browser_snapshot',
    toolOf({ kind: 'other', title: 'browser_snapshot' }),
  );
  check(
    'other-mcp-title',
    toolOf({ kind: 'other', title: 'mcp__tandem__browser_show' }) === 'mcp__tandem__browser_show',
  );
  check(
    'other-no-longer-Tool',
    toolOf({ kind: 'other', title: 'browser_navigate' }) !== 'Tool',
  );
  check('edit-kind', toolOf({ kind: 'edit', title: 'Write file' }) === 'Edit');
  check('execute-kind', toolOf({ kind: 'execute', title: 'bash' }) === 'Bash');

  const snap = decide('plan', toolOf({ kind: 'other', title: 'browser_snapshot' }), {});
  check('decide-snapshot-allow', snap.action === 'allow', snap.action);
  const show = decide('ask', toolOf({ kind: 'other', title: 'browser_show' }), {});
  check('decide-show-allow', show.action === 'allow', show.action);
  const nav = decideCodex('plan', toolOf({ kind: 'other', title: 'browser_navigate' }), {});
  check('decide-navigate-ask', nav.action === 'ask', nav.action);
}

function checkInstructions() {
  check('shared-mentions-navigate', /\bbrowser_navigate\b/.test(INSTRUCTIONS));
  check('shared-mentions-show', /\bbrowser_show\b/.test(INSTRUCTIONS));
  check('acp-mentions-preview-pane', /preview pane inside this app/.test(ACP_INSTRUCTIONS));
  check('acp-mentions-other-browser', /Any other browser tool/.test(ACP_INSTRUCTIONS));
  check('acp-includes-shared', ACP_INSTRUCTIONS.includes('browser_snapshot'));

  const codex = fs.readFileSync(path.join(ROOT, 'src/main/codex.js'), 'utf8');
  check('codex-mentions-show', /browser_show/.test(codex) || /Prefer mcp__tandem__browser_show/.test(codex));
}

function checkPrefaceWiring() {
  const withMcp = new AcpSession({
    spec: { binary: () => null, cli: 'agent', missing: 'nope' },
    cwd: ROOT,
    mcp: { command: 'node', args: ['mcp/server.js'] },
  });
  check('preface-with-mcp', withMcp.preface === ACP_INSTRUCTIONS, 'preface missing ACP_INSTRUCTIONS');

  const bare = new AcpSession({
    spec: { binary: () => null, cli: 'agent', missing: 'nope' },
    cwd: ROOT,
  });
  check('preface-without-mcp', bare.preface === null, bare.preface);

  const debug = new AcpSession({
    spec: { binary: () => null, cli: 'agent', missing: 'nope' },
    cwd: ROOT,
    mode: 'debug',
    mcp: { command: 'node', args: ['x'] },
  });
  check(
    'preface-debug-and-browser',
    debug.preface?.includes(ACP_INSTRUCTIONS) && debug.preface?.includes('<debug-mode>'),
    'expected both prefaces',
  );
}

checkPickMode();
checkToolOf();
checkInstructions();
checkPrefaceWiring();
console.log(failures.length ? `\n${failures.length} FAIL(s)` : '\nALL PASS');
process.exit(failures.length ? 1 : 0);
