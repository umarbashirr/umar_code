'use strict';
const path = require('path');
const fs = require('fs');
const ROOT = process.env.TANDEM_ROOT || path.join(__dirname, '..');

const failures = [];
const pass = (name) => console.log(`PASS ${name}`);
const fail = (name, detail) => { console.log(`FAIL ${name}: ${detail}`); failures.push(name); };

function checkAttentionModule() {
  let chatWaiting;
  let railBadge;
  let keepRailOpen;
  try {
    ({ chatWaiting, railBadge, keepRailOpen } = require(path.join(ROOT, 'src/renderer/ui/shell/chat-attention.js')));
  } catch (e) {
    fail('chat-attention-module', e.message);
    return;
  }
  pass('chat-attention-module');

  if (chatWaiting([{ kind: 'perm', decided: null }]) === true) pass('undecided-perm-waits');
  else fail('undecided-perm-waits', 'expected true');

  if (chatWaiting([{ kind: 'perm', decided: 'allow' }]) === false) pass('decided-perm-clears');
  else fail('decided-perm-clears', 'expected false');

  if (chatWaiting([{ kind: 'tool' }, { kind: 'perm', decided: undefined }]) === true) {
    pass('mixed-items-detects-perm');
  } else {
    fail('mixed-items-detects-perm', 'expected true');
  }

  if (chatWaiting([{ kind: 'agent', waiting: true }]) === false) pass('agent-waiting-is-not-chat-waiting');
  else fail('agent-waiting-is-not-chat-waiting', 'subagent waiting must not count as chat waiting');

  const needs = railBadge({ busy: true, agents: 2, waiting: true });
  if (needs && needs.label === 'needs you' && needs.tone === 'wait') pass('badge-prefers-needs-you');
  else fail('badge-prefers-needs-you', JSON.stringify(needs));

  const working = railBadge({ busy: true, agents: 0, waiting: false });
  if (working && working.label === 'working' && working.tone === 'busy') pass('badge-busy-working');
  else fail('badge-busy-working', JSON.stringify(working));

  const agents = railBadge({ busy: true, agents: 3, waiting: false });
  if (agents && agents.label === '3 agents') pass('badge-busy-agents');
  else fail('badge-busy-agents', JSON.stringify(agents));

  if (railBadge({ busy: false, agents: 0, waiting: false }) === null) pass('badge-idle-null');
  else fail('badge-idle-null', 'expected null');

  if (keepRailOpen({ busy: false, waiting: true }) === true) pass('keep-open-when-waiting');
  else fail('keep-open-when-waiting', 'waiting chat must stay out of the done fold');

  if (keepRailOpen({ busy: false, waiting: false }) === false) pass('fold-when-idle');
  else fail('fold-when-idle', 'idle non-waiting may fold');
}

function checkUseAgentWiresWaiting() {
  const src = fs.readFileSync(path.join(ROOT, 'src/renderer/ui/useAgent.js'), 'utf8');
  if (!/chatWaiting|chat-attention/.test(src)) {
    fail('useAgent-imports-attention', 'useAgent.js does not use chat-attention');
  } else {
    pass('useAgent-imports-attention');
  }

  const sync = src.match(/window\.tandemRail\?\.sync\?\.\([\s\S]*?\}\);/);
  if (!sync) {
    fail('useAgent-rail-sync', 'could not find tandemRail.sync call');
    return;
  }
  if (/\bwaiting\b/.test(sync[0])) pass('useAgent-sync-sends-waiting');
  else fail('useAgent-sync-sends-waiting', 'rail sync payload omits waiting');
}

function checkRailStorePassesWaiting() {
  const src = fs.readFileSync(path.join(ROOT, 'src/renderer/ui/shell/rail-store.js'), 'utf8');
  if (/row\.waiting\s*=\s*c\.waiting/.test(src) && /waiting:\s*c\.waiting/.test(src)) {
    pass('rail-store-copies-waiting');
  } else {
    fail('rail-store-copies-waiting', 'rows() does not copy waiting onto live rows');
  }

  if (/keepRailOpen|!\s*row\.busy\s*&&\s*!\s*row\.waiting|row\.busy\s*\|\|\s*row\.waiting/.test(src)) {
    pass('rail-store-keeps-waiting-open');
  } else {
    fail('rail-store-keeps-waiting-open', 'done-fold still hides waiting-only chats');
  }
}

function checkRailShowsNeedsYou() {
  const src = fs.readFileSync(path.join(ROOT, 'src/renderer/ui/shell/Rail.jsx'), 'utf8');
  if (!/railBadge|chat-attention|needs you/.test(src)) {
    fail('rail-row-needs-you', 'Rail.jsx never surfaces needs you');
    return;
  }
  if (/needs you/.test(src) || /railBadge/.test(src)) pass('rail-row-needs-you');
  else fail('rail-row-needs-you', 'no needs-you path in Row');

  if (/tone\s*===\s*['"]wait['"]|amber/.test(src)) pass('rail-row-wait-tone');
  else fail('rail-row-wait-tone', 'waiting badge has no wait/amber styling');
}

checkAttentionModule();
checkUseAgentWiresWaiting();
checkRailStorePassesWaiting();
checkRailShowsNeedsYou();

if (failures.length) {
  console.log(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.log('\nall passed');
