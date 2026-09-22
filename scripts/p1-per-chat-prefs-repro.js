'use strict';
const path = require('path');
const fs = require('fs');
const ROOT = process.env.TANDEM_ROOT || path.join(__dirname, '..');

const failures = [];
const pass = (name) => console.log(`PASS ${name}`);
const fail = (name, detail) => { console.log(`FAIL ${name}: ${detail}`); failures.push(name); };

function checkPrefsIsolation() {
  let createChatPrefs;
  try {
    ({ createChatPrefs } = require(path.join(ROOT, 'src/main/chat-prefs.js')));
  } catch (e) {
    fail('chat-prefs-module', e.message);
    return;
  }
  pass('chat-prefs-module');

  const prefs = createChatPrefs();
  prefs.setMode('a', 'plan');
  prefs.setModel('a', 'claude-opus');
  prefs.setEffort('a', 'high');
  prefs.setMode('b', 'bypass');
  prefs.setModel('b', 'claude-sonnet');
  prefs.setEffort('b', 'low');

  const a = prefs.resolve('a', { mode: 'ask', model: 'default', effort: '' });
  const b = prefs.resolve('b', { mode: 'ask', model: 'default', effort: '' });
  if (a.mode === 'plan' && a.model === 'claude-opus' && a.effort === 'high') pass('chat-a-keeps-own');
  else fail('chat-a-keeps-own', JSON.stringify(a));
  if (b.mode === 'bypass' && b.model === 'claude-sonnet' && b.effort === 'low') pass('chat-b-keeps-own');
  else fail('chat-b-keeps-own', JSON.stringify(b));

  prefs.setMode('b', 'auto');
  prefs.setModel('b', 'claude-haiku');
  prefs.setEffort('b', 'medium');
  const aAfter = prefs.resolve('a', { mode: 'ask', model: 'default', effort: '' });
  if (aAfter.mode === 'plan' && aAfter.model === 'claude-opus' && aAfter.effort === 'high') {
    pass('editing-b-does-not-clobber-a');
  } else {
    fail('editing-b-does-not-clobber-a', JSON.stringify(aAfter));
  }

  const cold = prefs.resolve('cold', { mode: 'ask', model: 'window-model', effort: 'xhigh' });
  if (cold.mode === 'ask' && cold.model === 'window-model' && cold.effort === 'xhigh') {
    pass('unset-chat-uses-window-defaults');
  } else {
    fail('unset-chat-uses-window-defaults', JSON.stringify(cold));
  }

  prefs.forget('a');
  const gone = prefs.resolve('a', { mode: 'ask', model: 'window-model', effort: '' });
  if (gone.mode === 'ask' && gone.model === 'window-model') pass('forget-drops-chat');
  else fail('forget-drops-chat', JSON.stringify(gone));
}

function checkIndexNoFanOut() {
  const src = fs.readFileSync(path.join(ROOT, 'src/main/index.js'), 'utf8');

  if (/liveSessions\(\)\.map\(\(a\) => a\.setModel/.test(src)) {
    fail('index-no-setModel-fanout', 'liveSessions().map setModel still present');
  } else {
    pass('index-no-setModel-fanout');
  }

  if (/liveSessions\(\)\.map\(\(a\) => a\.setMode/.test(src)) {
    fail('index-no-setMode-fanout', 'liveSessions().map setMode still present');
  } else {
    pass('index-no-setMode-fanout');
  }

  if (/for \(const \[chat, a\] of \[\.\.\.sessions\]\) if \(!a\.busy\) stopChat\(chat\)/.test(src)) {
    fail('index-no-setEffort-all-stop', 'setEffort still stops every idle chat');
  } else {
    pass('index-no-setEffort-all-stop');
  }

  if (!/createChatPrefs/.test(src)) {
    fail('index-uses-chat-prefs', 'index.js does not createChatPrefs');
  } else {
    pass('index-uses-chat-prefs');
  }

  if (!/chatPrefs\.resolve\(/.test(src)) {
    fail('ensureAgent-resolves-prefs', 'ensureAgent does not call chatPrefs.resolve');
  } else {
    pass('ensureAgent-resolves-prefs');
  }

  const setModelBlock = src.match(/ipcMain\.handle\('agent:setModel'[\s\S]*?\n  \}\);/);
  if (setModelBlock && /\{ chat[,}]/.test(setModelBlock[0])) pass('setModel-takes-chat');
  else fail('setModel-takes-chat', 'agent:setModel handler missing chat arg');

  const setEffortBlock = src.match(/ipcMain\.handle\('agent:setEffort'[\s\S]*?\n  \}\);/);
  if (setEffortBlock && /handle\('agent:setEffort',\s*async\s*\(_e,\s*\{\s*[^}]*\bchat\b/.test(setEffortBlock[0])) {
    pass('setEffort-takes-chat');
  } else {
    fail('setEffort-takes-chat', 'agent:setEffort handler missing chat arg');
  }
}

function checkPreloadPassesChat() {
  const src = fs.readFileSync(path.join(ROOT, 'src/preload/index.js'), 'utf8');
  if (/setModel:\s*\(model\)\s*=>/.test(src) && !/setModel:\s*\(chat,\s*model\)/.test(src)
    && !/setModel:\s*\(\{\s*chat/.test(src) && !/setModel:\s*\(chat,/.test(src)) {
    fail('preload-setModel-chat', 'setModel still omits chat');
  } else if (/setModel:.*chat/.test(src)) {
    pass('preload-setModel-chat');
  } else {
    fail('preload-setModel-chat', src.match(/setModel:.*/)[0]);
  }

  if (/setEffort:.*chat/.test(src)) pass('preload-setEffort-chat');
  else fail('preload-setEffort-chat', 'setEffort still omits chat');

  if (/setLongContext:.*chat/.test(src)) pass('preload-setLongContext-chat');
  else fail('preload-setLongContext-chat', 'setLongContext still omits chat');
}

async function main() {
  checkPrefsIsolation();
  checkIndexNoFanOut();
  checkPreloadPassesChat();
  if (failures.length) {
    console.log(`\n${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log('\nall passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
