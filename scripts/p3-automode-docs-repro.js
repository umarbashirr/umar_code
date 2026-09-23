'use strict';
// P3.2: auto mode's blocklist can never be complete. The UI and README must
// say so plainly instead of implying auto mode stops "anything destructive".
const fs = require('fs');
const path = require('path');
const ROOT = process.env.TANDEM_ROOT || path.join(__dirname, '..');

const failures = [];
const pass = (name) => console.log(`PASS ${name}`);
const fail = (name, detail) => { console.log(`FAIL ${name}: ${detail}`); failures.push(name); };

function checkNewRiskyPatterns() {
  const { riskOf } = require(path.join(ROOT, 'src/main/modes.js'));
  const cases = [
    ['find . -type f -delete', 'find -delete'],
    ['shred -u secret.key', 'shred'],
    ['truncate -s0 important.log', 'truncate -s0'],
  ];
  for (const [cmd, label] of cases) {
    if (riskOf(cmd)) pass(`riskOf-catches-${label}`);
    else fail(`riskOf-catches-${label}`, `riskOf(${JSON.stringify(cmd)}) => null`);
  }
}

function checkComposerCopyIsHonest() {
  const src = fs.readFileSync(path.join(ROOT, 'src/renderer/ui/components/composer.jsx'), 'utf8');
  const m = /\['auto', 'Auto', '([^']+)'\]/.exec(src);
  if (!m) { fail('composer-auto-copy-found', 'auto mode entry not found in MODES'); return; }
  const note = m[1];
  if (/anything destructive/i.test(note)) {
    fail('composer-auto-copy-not-overclaiming', `still promises to catch "anything destructive": ${note}`);
  } else if (/sandbox/i.test(note)) {
    pass('composer-auto-copy-not-overclaiming');
  } else {
    fail('composer-auto-copy-not-overclaiming', `does not say "not a sandbox": ${note}`);
  }
}

function checkReadmeSaysNotASandbox() {
  const src = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  if (/Auto runs edits[\s\S]{0,400}not a sandbox/.test(src)) {
    pass('readme-auto-section-says-not-a-sandbox');
  } else {
    fail('readme-auto-section-says-not-a-sandbox', 'no "not a sandbox" language near the Auto mode description');
  }
}

(async () => {
  console.log('=== P3.2 auto mode guard must be honest, not just complete ===');
  checkNewRiskyPatterns();
  checkComposerCopyIsHonest();
  checkReadmeSaysNotASandbox();
  console.log(failures.length ? `\n${failures.length} FAIL(s)` : '\nALL PASS');
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
