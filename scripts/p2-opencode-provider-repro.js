#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = process.env.TANDEM_ROOT || path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-opencode-'));

const shellEnv = require(path.join(ROOT, 'src/main/shell-env'));
shellEnv.ready = async () => process.env.PATH || '';
shellEnv.env = () => ({ ...process.env });
shellEnv.cached = () => process.env.PATH || '';

const { AcpSession } = require(path.join(ROOT, 'src/main/providers/acp-session.js'));
const { opencodeServers } = require(path.join(ROOT, 'src/main/providers/acp-catalog.js'));
const opencode = require(path.join(ROOT, 'src/main/providers/opencode.js'));

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};

const MOCK = path.join(ROOT, 'scripts/mock-acp-cli.js');
const spec = {
  id: 'opencode',
  cli: 'opencode',
  argv: [MOCK, 'acp'],
  env: () => ({ MOCK_ACP_CONFIG: '1' }),
  login: 'opencode auth login',
  binary: () => process.execPath,
};

async function turn(session) {
  let text = '';
  const done = new Promise((resolve) => {
    const on = (m) => {
      if (m.type === 'stream_event' && m.event?.delta?.text) text += m.event.delta.text;
      if (m.type === 'result') { session.off('message', on); resolve(); }
    };
    session.on('message', on);
  });
  session.send('which');
  await done;
  return text;
}

async function checkConfigOptions() {
  const session = new AcpSession({ spec, cwd: tmp, model: 'mock-2', mode: 'plan' });
  let ready = null;
  session.on('ready', (r) => { ready = r; });
  try {
    await session.start();
    const names = (ready?.models || []).map((m) => `${m.value}:${m.displayName}`).join(',');
    check('models-from-config-options', names === 'mock-1:Zen/Mock One,mock-2:Zen/Mock Two', names);
    check('start-sets-model-and-plan', (await turn(session)) === 'model=mock-2 mode=plan', 'wrong config at start');
    await session.setModel('mock-1');
    await session.setMode('ask');
    check('switch-back-to-build', (await turn(session)) === 'model=mock-1 mode=build', 'wrong config after switching');
  } finally {
    session.stop();
  }
}

function checkPermissionsAsk() {
  const row = opencode.create({ cacheDir: tmp, settings: { get: () => ({}) } });
  const config = JSON.parse(row.spec.env().OPENCODE_CONFIG_CONTENT);
  check('opencode-asks-before-acting', ['edit', 'bash', 'webfetch'].every((k) => config.permission[k] === 'ask'), JSON.stringify(config));
}

function checkMcpList() {
  const out = [
    '\x1b[0m', '┌  MCP Servers', '│',
    '●  ✓ fs-demo \x1b[90mconnected', '│      \x1b[90mnpx -y server-everything', '│',
    '●  ✗ bad \x1b[90mfailed', "│      ENOENT: no such file or directory, posix_spawn '/nope'", '│      \x1b[90m/nope', '│',
    '└  2 server(s)',
  ].join('\n');
  const rows = opencodeServers(out);
  check('mcp-list-parsed', JSON.stringify(rows) === JSON.stringify([
    { name: 'fs-demo', word: 'connected', detail: ['npx -y server-everything'] },
    { name: 'bad', word: 'failed', detail: ["ENOENT: no such file or directory, posix_spawn '/nope'", '/nope'] },
  ]), JSON.stringify(rows));
}

(async () => {
  try {
    await checkConfigOptions();
    checkPermissionsAsk();
    checkMcpList();
  } catch (e) {
    check('probe-threw', false, e.stack || e.message);
  }
  console.log(failures.length ? `\n${failures.length} failure(s)` : '\nall passed');
  process.exit(failures.length ? 1 : 0);
})();
