'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = process.env.TANDEM_ROOT || path.join(__dirname, '..');
const { screenshotFilePath } = require(path.join(ROOT, 'src/main/screenshot-path.js'));

const failures = [];
const pass = (name) => console.log(`PASS ${name}`);
const fail = (name, detail) => {
  console.log(`FAIL ${name}: ${detail}`);
  failures.push(name);
};

function vulnerableJoin(shotDir, name) {
  return path.join(shotDir, `${name || 'shot-' + Date.now()}.png`);
}

function escapesShotDir(shotDir, file) {
  const root = path.resolve(shotDir);
  const resolved = path.resolve(file);
  return resolved !== root && !resolved.startsWith(root + path.sep);
}

function checkVulnerableJoinEscapes() {
  const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-shots-repro-'));
  const evil = '../../p2-screenshot-escape-probe';
  const file = vulnerableJoin(shotDir, evil);
  if (escapesShotDir(shotDir, file)) pass('vulnerable-join-escapes-shotdir');
  else fail('vulnerable-join-escapes-shotdir', `stayed under ${shotDir}: ${file}`);
}

function checkSanitizedJoin() {
  const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-shots-safe-'));
  const cases = [
    '../../p2-screenshot-escape-probe',
    '../outside',
    '/etc/passwd',
    'nested/evil',
    '..',
    '',
  ];
  for (const name of cases) {
    const file = screenshotFilePath(shotDir, name);
    if (escapesShotDir(shotDir, file)) {
      fail('sanitized-stays-in-shotdir', `name=${JSON.stringify(name)} -> ${file}`);
      return;
    }
  }
  pass('sanitized-stays-in-shotdir');
}

function checkLegitimateName() {
  const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-shots-legit-'));
  const file = screenshotFilePath(shotDir, 'my-capture');
  const resolved = path.resolve(file);
  const root = path.resolve(shotDir);
  if (resolved === path.join(root, 'my-capture.png')) pass('legitimate-name-preserved');
  else fail('legitimate-name-preserved', file);
}

console.log('=== P2.2 screenshot path must stay under shotDir ===');
checkVulnerableJoinEscapes();
checkSanitizedJoin();
checkLegitimateName();

if (failures.length) {
  console.log(`\n${failures.length} FAIL(s)`);
  process.exit(1);
}
console.log('\nALL PASS');
process.exit(0);
