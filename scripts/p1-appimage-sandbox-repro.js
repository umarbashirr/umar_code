#!/usr/bin/env node
'use strict';
// P1.12: official AppImage packaging must not hardcode --no-sandbox into desktop Exec.
// electron-builder defaults executableArgs to [--no-sandbox] when the key is omitted,
// so the fix is an explicit empty array. AppRun already probes unshare at runtime.
const fs = require('fs');
const path = require('path');

const ROOT = process.env.TANDEM_ROOT || path.join(__dirname, '..');
const failures = [];
const pass = (name) => console.log(`PASS ${name}`);
const fail = (name, detail) => {
  console.log(`FAIL ${name}: ${detail}`);
  failures.push(name);
};

function packagedDesktopExec(executableArgs) {
  // Mirrors app-builder-lib AppImageTarget desktop Exec construction.
  const defaultArgs = ['--no-sandbox'];
  const args = executableArgs !== undefined && executableArgs !== null ? executableArgs : defaultArgs;
  return ['AppRun', ...args, '%U'].join(' ');
}

function checkPackageJson() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const args = pkg.build?.appImage?.executableArgs;
  if (args === undefined) {
    fail('appImage-executableArgs-explicit', 'omitted executableArgs falls back to [--no-sandbox] in electron-builder');
    return;
  }
  if (!Array.isArray(args)) {
    fail('appImage-executableArgs-array', `got ${typeof args}`);
    return;
  }
  if (args.includes('--no-sandbox')) {
    fail('appImage-no-baked-no-sandbox', `executableArgs=${JSON.stringify(args)}`);
  } else {
    pass('appImage-no-baked-no-sandbox');
  }
  if (args.length === 0) pass('appImage-executableArgs-empty');
  else fail('appImage-executableArgs-empty', `expected [], got ${JSON.stringify(args)}`);
}

function checkDesktopExecContract() {
  const forced = packagedDesktopExec(['--no-sandbox']);
  if (forced.includes('--no-sandbox')) pass('contract-forced-includes-flag');
  else fail('contract-forced-includes-flag', forced);

  const fixed = packagedDesktopExec([]);
  if (fixed === 'AppRun %U') pass('contract-empty-omits-flag');
  else fail('contract-empty-omits-flag', fixed);

  const omitted = packagedDesktopExec(undefined);
  if (omitted.includes('--no-sandbox')) pass('contract-omitted-defaults-flag');
  else fail('contract-omitted-defaults-flag', omitted);
}

function checkAppRunStillProbes() {
  const util = path.join(ROOT, 'node_modules/app-builder-lib/out/targets/appimage/appImageUtil.js');
  if (!fs.existsSync(util)) {
    fail('appRun-runtime-probe', 'app-builder-lib appImageUtil.js missing');
    return;
  }
  const src = fs.readFileSync(util, 'utf8');
  if (/unshare -Ur/.test(src) && /NO_SANDBOX=\(--no-sandbox\)/.test(src)) {
    pass('appRun-runtime-probe');
  } else {
    fail('appRun-runtime-probe', 'expected AppRun unshare probe for conditional --no-sandbox');
  }
}

function checkLaunchJsPolicyIntact() {
  const launch = fs.readFileSync(path.join(ROOT, 'scripts/launch.js'), 'utf8');
  const cli = fs.readFileSync(path.join(ROOT, 'cli/tandem.js'), 'utf8');
  if (/sandboxUsable|chrome-sandbox/.test(launch) && /--no-sandbox/.test(launch)) pass('launch-js-conditional');
  else fail('launch-js-conditional', 'scripts/launch.js no longer gates --no-sandbox');
  if (/sandboxArgs/.test(cli) && /chrome-sandbox/.test(cli)) pass('cli-sandboxArgs-conditional');
  else fail('cli-sandboxArgs-conditional', 'cli/tandem.js sandboxArgs missing');
}

checkPackageJson();
checkDesktopExecContract();
checkAppRunStillProbes();
checkLaunchJsPolicyIntact();

if (failures.length) {
  console.error(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.log('\nall passed');
