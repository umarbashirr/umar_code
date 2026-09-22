#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = process.env.TANDEM_ROOT || path.join(__dirname, '..');
const shellEnv = require(path.join(ROOT, 'src/main/shell-env'));
const { findOnPath } = require(path.join(ROOT, 'src/main/providers/find-binary'));
const cursor = require(path.join(ROOT, 'src/main/providers/cursor'));

const failures = [];
const pass = (name) => console.log(`PASS ${name}`);
const fail = (name, detail) => {
  console.log(`FAIL ${name}: ${detail}`);
  failures.push(name);
};

function writeExec(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 });
}

function withCached(value, fn) {
  const prev = shellEnv.cached;
  shellEnv.cached = () => value;
  try { return fn(); }
  finally { shellEnv.cached = prev; }
}

function checkFakePathCollision() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-p2-cursor-bin-'));
  try {
    const grokDownload = path.join(tmp, '.grok', 'downloads', 'grok-1.0.34-linux-x86_64');
    const grokBin = path.join(tmp, '.grok', 'bin');
    const cursorBin = path.join(tmp, '.local', 'bin');
    const cursorReal = path.join(tmp, 'versions', 'cursor-agent');
    writeExec(grokDownload);
    writeExec(cursorReal);
    fs.mkdirSync(grokBin, { recursive: true });
    fs.mkdirSync(cursorBin, { recursive: true });
    fs.symlinkSync(grokDownload, path.join(grokBin, 'agent'));
    fs.symlinkSync(cursorReal, path.join(cursorBin, 'cursor-agent'));
    fs.symlinkSync(cursorReal, path.join(cursorBin, 'agent'));
    const fakePath = [grokBin, cursorBin].join(path.delimiter);

    withCached(fakePath, () => {
      const oldHit = findOnPath(['agent', 'cursor-agent']);
      if (oldHit === grokDownload) pass('old-order-picks-grok-like');
      else fail('old-order-picks-grok-like', `expected ${grokDownload}, got ${oldHit}`);

      const newHit = cursor.cursorBinary();
      if (newHit === cursorReal) pass('new-locator-picks-cursor-agent');
      else fail('new-locator-picks-cursor-agent', `expected ${cursorReal}, got ${newHit}`);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function checkMissingMentionsCollision() {
  const { spec } = cursor.create({ cacheDir: os.tmpdir(), settings: { get: () => ({}) } });
  const text = spec.missing || '';
  if (/cursor-agent/.test(text) && /agent/.test(text) && /Grok/i.test(text)) pass('missing-mentions-cursor-agent-and-grok');
  else fail('missing-mentions-cursor-agent-and-grok', text);
}

function checkRealMachinePaths() {
  const home = os.homedir();
  const grokAgent = path.join(home, '.grok', 'bin', 'agent');
  const cursorAgent = path.join(home, '.local', 'bin', 'cursor-agent');
  if (!fs.existsSync(grokAgent) || !fs.existsSync(cursorAgent)) {
    console.log('SKIP real-machine-paths (need ~/.grok/bin/agent and ~/.local/bin/cursor-agent)');
    return;
  }
  const grokReal = fs.realpathSync(grokAgent);
  const cursorReal = fs.realpathSync(cursorAgent);
  const envPath = process.env.PATH || '';
  withCached(envPath, () => {
    const oldHit = findOnPath(['agent', 'cursor-agent']);
    if (oldHit === grokReal) pass('real-old-order-picks-grok');
    else fail('real-old-order-picks-grok', `expected ${grokReal}, got ${oldHit}`);

    const newHit = cursor.cursorBinary();
    if (newHit === cursorReal) pass('real-new-locator-picks-cursor-agent');
    else fail('real-new-locator-picks-cursor-agent', `expected ${cursorReal}, got ${newHit}`);
  });
}

checkFakePathCollision();
checkMissingMentionsCollision();
checkRealMachinePaths();

if (failures.length) {
  console.error(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.log('\nall passed');
