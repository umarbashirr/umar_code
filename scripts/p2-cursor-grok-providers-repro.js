#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = process.env.TANDEM_ROOT || path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-p211-'));
os.homedir = () => tmp;

const shellEnv = require(path.join(ROOT, 'src/main/shell-env'));
shellEnv.ready = async () => process.env.PATH || '';
shellEnv.env = () => ({ ...process.env });
shellEnv.cached = () => process.env.PATH || '';

const failures = [];
const pass = (name) => console.log(`PASS ${name}`);
const fail = (name, detail) => {
  console.log(`FAIL ${name}: ${detail}`);
  failures.push(name);
};

const MOCK = path.join(ROOT, 'scripts/mock-acp-cli.js');

function mockSpec(overrides = {}) {
  return {
    id: 'cursor',
    cli: 'agent',
    argv: [MOCK, 'acp'],
    login: 'agent login',
    missing: 'No Cursor CLI (agent) on your PATH.',
    catalog: [{ value: 'auto', displayName: 'Auto' }],
    binary: () => process.execPath,
    ...overrides,
  };
}

function until(fn, ms = 8000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        const v = fn();
        if (v) return resolve(v);
      } catch (e) { return reject(e); }
      if (Date.now() - start > ms) return reject(new Error('timed out'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

function checkChatPrefsProvider() {
  const { createChatPrefs } = require(path.join(ROOT, 'src/main/chat-prefs.js'));
  const prefs = createChatPrefs();
  prefs.setProvider('a', 'cursor');
  prefs.setModel('a', 'composer-2');
  prefs.setProvider('b', 'grok');
  prefs.setModel('b', 'grok-code');
  const a = prefs.resolve('a', { provider: 'claude', model: 'default' });
  const b = prefs.resolve('b', { provider: 'claude', model: 'default' });
  if (a.provider === 'cursor' && a.model === 'composer-2') pass('prefs-chat-a-provider');
  else fail('prefs-chat-a-provider', JSON.stringify(a));
  if (b.provider === 'grok' && b.model === 'grok-code') pass('prefs-chat-b-provider');
  else fail('prefs-chat-b-provider', JSON.stringify(b));
  prefs.setProvider('b', 'claude');
  const aAfter = prefs.resolve('a', { provider: 'claude', model: 'default' });
  if (aAfter.provider === 'cursor') pass('prefs-provider-isolated');
  else fail('prefs-provider-isolated', JSON.stringify(aAfter));
  const cold = prefs.resolve('cold', { provider: 'claude', model: 'window' });
  if (cold.provider === 'claude') pass('prefs-unset-uses-default-provider');
  else fail('prefs-unset-uses-default-provider', JSON.stringify(cold));
}

function checkSettingsKeys() {
  const { DEFAULTS } = require(path.join(ROOT, 'src/main/settings.js'));
  const keys = ['cursorModel', 'grokModel', 'codexModel', 'provider'];
  const missing = keys.filter((k) => DEFAULTS.agent[k] === undefined);
  if (!missing.length && DEFAULTS.cursor && DEFAULTS.grok) pass('settings-flat-model-keys');
  else fail('settings-flat-model-keys', missing.join(',') || 'missing cursor/grok sections');
}

function checkIndexWiring() {
  const src = fs.readFileSync(path.join(ROOT, 'src/main/index.js'), 'utf8');
  if (/chatProviders/.test(src)) fail('index-no-chatProviders', 'chatProviders map still present');
  else pass('index-no-chatProviders');
  if (!/createRegistry/.test(src)) fail('index-createRegistry', 'index.js does not createRegistry');
  else pass('index-createRegistry');
  if (!/chatPrefs\.providerOf/.test(src) || !/chatPrefs\.setProvider/.test(src)) {
    fail('index-per-chat-provider', 'ensureAgent/setProvider does not use chatPrefs provider');
  } else pass('index-per-chat-provider');
  if (/applyClaudeBinary/.test(src) || /new Driver\(/.test(src) || /new Catalog\(/.test(src)) {
    fail('index-no-legacy-constructors', 'leftover Driver/Catalog/applyClaudeBinary in index.js');
  } else pass('index-no-legacy-constructors');
  if (!/previewMcp\(/.test(src) || !/mcpServers/.test(fs.readFileSync(path.join(ROOT, 'src/main/providers/acp-session.js'), 'utf8'))) {
    fail('index-preview-mcp', 'preview MCP not wired through session/new mcpServers');
  } else pass('index-preview-mcp');
}

function checkUiLabels() {
  const composer = fs.readFileSync(path.join(ROOT, 'src/renderer/ui/components/composer.jsx'), 'utf8');
  const settings = fs.readFileSync(path.join(ROOT, 'src/renderer/ui/components/settings-panel.jsx'), 'utf8');
  if (/cursor: 'Cursor'/.test(composer) && /grok: 'Grok'/.test(composer)) pass('composer-labels');
  else fail('composer-labels', 'composer missing Cursor/Grok labels');
  if (/locked: !p\.installed/.test(composer)) pass('composer-locked-missing');
  else fail('composer-locked-missing', 'missing CLIs are not locked on installed=false');
  if (/cursor: \{/.test(settings) && /grok: \{/.test(settings)) pass('settings-provider-rows');
  else fail('settings-provider-rows', 'settings dialog missing Cursor/Grok');
}

function checkRegistry() {
  const { createRegistry, isProviderId, PROVIDER_IDS } = require(path.join(ROOT, 'src/main/providers'));
  if (PROVIDER_IDS.join(',') === 'claude,cursor,grok,opencode,codex' && isProviderId('opencode') && !isProviderId('gemini')) {
    pass('registry-ids');
  } else fail('registry-ids', PROVIDER_IDS.join(','));
  const settings = { get: () => ({}) };
  const registry = createRegistry({ cacheDir: tmp, settings });
  const cursor = registry.get('cursor');
  const grok = registry.get('grok');
  const codex = registry.get('codex');
  if (cursor?.modelKey === 'cursorModel' && grok?.modelKey === 'grokModel' && cursor.createSession && grok.createSession) {
    pass('registry-rows');
  } else fail('registry-rows', `cursor=${cursor && cursor.modelKey} grok=${grok && grok.modelKey}`);
  if (codex?.id === 'codex' && typeof codex.createSession === 'function') pass('registry-wraps-codex');
  else fail('registry-wraps-codex', 'codex row missing');
}

async function checkMissingIsCheap() {
  const { AcpDriver } = require(path.join(ROOT, 'src/main/providers/acp-driver.js'));
  const driver = new AcpDriver({
    spec: mockSpec({ binary: () => null }),
    cacheDir: tmp,
  });
  const t0 = Date.now();
  const snap = await driver.refresh();
  const dt = Date.now() - t0;
  if (snap.status === 'missing' && !snap.installed && dt < 1500) pass('missing-cli-no-spawn');
  else fail('missing-cli-no-spawn', `status=${snap.status} dt=${dt} installed=${snap.installed}`);
}

async function checkMockStream() {
  const { AcpSession } = require(path.join(ROOT, 'src/main/providers/acp-session.js'));
  const session = new AcpSession({ spec: mockSpec(), cwd: tmp, model: 'mock-1' });
  const text = [];
  let result = null;
  session.on('message', (m) => {
    if (m.type === 'stream_event' && m.event?.delta?.text) text.push(m.event.delta.text);
    if (m.type === 'result') result = m;
  });
  try {
    await session.start();
    session.send('hello');
    await until(() => result);
    const joined = text.join('');
    if (joined === 'hello from mock' && result.subtype === 'success') pass('mock-stream');
    else fail('mock-stream', `text=${JSON.stringify(joined)} result=${JSON.stringify(result)}`);
  } catch (e) {
    fail('mock-stream', e.stack || e.message);
  } finally {
    session.stop();
  }
}

async function checkAuthError() {
  const { AcpSession } = require(path.join(ROOT, 'src/main/providers/acp-session.js'));
  const session = new AcpSession({
    spec: mockSpec({ env: () => ({ MOCK_ACP_AUTH: '1' }) }),
    cwd: tmp,
  });
  try {
    await session.start();
    fail('auth-error', 'start() succeeded while logged out');
  } catch (e) {
    if (/not logged in/i.test(e.message)) pass('auth-error');
    else fail('auth-error', e.message);
  } finally {
    session.stop();
  }
}

async function checkMcpServersShape() {
  const { mcpEnv } = require(path.join(ROOT, 'src/main/providers/acp-session.js'));
  const rows = mcpEnv({ TANDEM_TOKEN: 'x', SKIP: null });
  if (rows.length === 1 && rows[0].name === 'TANDEM_TOKEN' && rows[0].value === 'x') pass('mcp-env-array');
  else fail('mcp-env-array', JSON.stringify(rows));
}

(async () => {
  try {
    checkChatPrefsProvider();
    checkSettingsKeys();
    checkIndexWiring();
    checkUiLabels();
    checkRegistry();
    await checkMissingIsCheap();
    await checkMockStream();
    await checkAuthError();
    await checkMcpServersShape();
  } catch (e) {
    fail('probe-threw', e.stack || e.message);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  if (failures.length) {
    console.error(`\n${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log('\nall passed');
})();
