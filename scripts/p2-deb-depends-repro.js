#!/usr/bin/env node
'use strict';
// P2.10: electron-builder deb.depends replaces defaults; must include Electron
// runtime libs that install.sh documents for missing-library recovery.
const fs = require('fs');
const path = require('path');

const ROOT = process.env.TANDEM_ROOT || path.join(__dirname, '..');
const failures = [];
const pass = (name) => console.log(`PASS ${name}`);
const fail = (name, detail) => {
  console.log(`FAIL ${name}: ${detail}`);
  failures.push(name);
};

/** Debian package names implied by install.sh finish() hints (zypper + gtk3 → libgtk-3-0). */
const INSTALL_SH_DEB_RUNTIME = ['libgtk-3-0', 'libasound2', 'libgbm1'];

function requiredFromInstallSh() {
  const sh = fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf8');
  const zypper = sh.match(/zypper install ([^\n"]+)/);
  if (!zypper) {
    fail('install-sh-zypper-hint', 'expected zypper install hint in install.sh');
    return INSTALL_SH_DEB_RUNTIME;
  }
  const tokens = zypper[1].split(/\s+/);
  for (const pkg of ['libgbm1', 'libasound2']) {
    if (!tokens.includes(pkg)) fail('install-sh-zypper-hint', `missing ${pkg} in zypper hint`);
  }
  if (!tokens.includes('gtk3')) fail('install-sh-zypper-hint', 'missing gtk3 in zypper hint');
  else pass('install-sh-documents-runtime-libs');
  return INSTALL_SH_DEB_RUNTIME;
}

function checkDebDepends() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const depends = pkg?.build?.deb?.depends;
  if (!Array.isArray(depends)) {
    fail('deb-depends-array', 'build.deb.depends must be an array');
    return;
  }
  const required = requiredFromInstallSh();
  const missing = required.filter((name) => !depends.includes(name));
  if (missing.length === 0) pass('deb-depends-includes-install-sh-runtime');
  else fail('deb-depends-includes-install-sh-runtime', `missing ${missing.join(', ')}`);
}

console.log('=== P2.10 deb.depends vs install.sh runtime libs ===');
checkDebDepends();

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nAll checks passed');
