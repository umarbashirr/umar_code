#!/usr/bin/env node
'use strict';
// P1.11: the release job must build the Windows installer on Linux, publish
// SHA256SUMS, and run the install script from the same tag as the binary.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const crypto = require('crypto');

const ROOT = process.env.TANDEM_ROOT || path.join(__dirname, '..');
const failures = [];
const pass = (name) => console.log(`PASS ${name}`);
const fail = (name, detail) => {
  console.log(`FAIL ${name}: ${detail}`);
  failures.push(name);
};

function workflowText() {
  return fs.readFileSync(path.join(ROOT, '.github/workflows/windows-installer.yml'), 'utf8');
}

function checkWorkflowRunner() {
  const wf = workflowText();
  const runners = [...wf.matchAll(/^[ \t]*runs-on:[ \t]*(\S+)/gm)].map((m) => m[1]);
  if (runners.some((r) => r.includes('windows'))) {
    fail('workflow-not-windows-runner', `runs-on ${runners.join(', ')}`);
    return;
  }
  if (runners.includes('ubuntu-latest')) pass('workflow-ubuntu-runner');
  else fail('workflow-ubuntu-runner', `runs-on ${runners.join(', ') || '(none)'}`);
}

function checkWorkflowBuild() {
  const wf = workflowText();
  if (wf.includes('dist:win:docker')) pass('workflow-docker-win-build');
  else fail('workflow-docker-win-build', 'expected npm run dist:win:docker');
  if (wf.includes('SHA256SUMS')) pass('workflow-uploads-checksums');
  else fail('workflow-uploads-checksums', 'expected SHA256SUMS on the release upload');
}

function checkNoMacJob() {
  const wf = workflowText();
  if (/runs-on:\s*macos/.test(wf)) fail('no-macos-runner', 'a macOS runner cannot produce a dmg while Actions is billing-locked');
  else pass('no-macos-runner');
  if (/dist:mac|release upload[^\n]*\.dmg/.test(wf)) {
    fail('workflow-does-not-upload-dmg', 'dmgbuild ships a macOS Python and cannot run on the Linux runner');
  } else {
    pass('workflow-does-not-upload-dmg');
  }
}

function checkChecksumScript() {
  const script = path.join(ROOT, 'scripts/release-checksums.sh');
  if (!fs.existsSync(script)) {
    fail('checksum-script', 'scripts/release-checksums.sh missing');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-11-sums-'));
  const body = 'tandem-release-artifact\n';
  fs.writeFileSync(path.join(dir, 'tandem-9.9.9-x64.exe'), body);
  const run = spawnSync('sh', [script, dir], { encoding: 'utf8' });
  if (run.status !== 0) {
    fail('checksum-script', (run.stderr || run.stdout || '').trim());
    return;
  }
  const sums = fs.readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8').trim();
  const expect = crypto.createHash('sha256').update(body).digest('hex');
  if (sums === `${expect}  tandem-9.9.9-x64.exe`) pass('checksum-script');
  else fail('checksum-script', sums);
}

function writeFakeCurl(bin) {
  const curl = path.join(bin, 'curl');
  fs.writeFileSync(curl, `#!/bin/sh
url=
for a in "$@"; do url=$a; done
case "$url" in
  *api.github.com*/releases/latest)
    printf '%s' '{"tag_name":"v9.9.9"}'
    ;;
  *api.github.com*/releases/tags/v1.2.3)
    printf '%s' '{"tag_name":"v1.2.3"}'
    ;;
  *raw.githubusercontent.com*/install.sh)
    printf '%s\\n' '#!/bin/sh' 'echo "pinned:$TANDEM_INSTALL_FROM_TAG"' 'exit 0'
    ;;
  *)
    echo "unexpected $url" >&2
    exit 1
    ;;
esac
`);
  fs.chmodSync(curl, 0o755);
}

function runInstall(bin, args) {
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  delete env.TANDEM_INSTALL_FROM_TAG;
  return spawnSync('sh', [path.join(ROOT, 'install.sh'), ...args], {
    env,
    encoding: 'utf8',
    timeout: 15000,
  });
}

function checkInstallPin() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-11-pin-'));
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  writeFakeCurl(bin);

  const latest = runInstall(bin, ['--user']);
  const latestOut = `${latest.stdout || ''}${latest.stderr || ''}`;
  if (latest.status === 0 && latestOut.includes('pinned:v9.9.9')) pass('install-sh-pins-latest');
  else fail('install-sh-pins-latest', `status=${latest.status} out=${latestOut.trim()}`);

  const pinned = runInstall(bin, ['--user', '--version', '1.2.3']);
  const pinnedOut = `${pinned.stdout || ''}${pinned.stderr || ''}`;
  if (pinned.status === 0 && pinnedOut.includes('pinned:v1.2.3')) pass('install-sh-pins-version');
  else fail('install-sh-pins-version', `status=${pinned.status} out=${pinnedOut.trim()}`);
}

function checkInstallPs1() {
  const ps1 = fs.readFileSync(path.join(ROOT, 'install.ps1'), 'utf8');
  if (ps1.includes('cannot be cross-built')) {
    fail('install-ps1-no-cross-build-lie', 'still says the exe cannot be cross-built');
  } else {
    pass('install-ps1-no-cross-build-lie');
  }
  if (ps1.includes('TANDEM_INSTALL_FROM_TAG') && ps1.includes('raw.githubusercontent.com/$repo/$tag/install.ps1')) {
    pass('install-ps1-pins-tag');
  } else {
    fail('install-ps1-pins-tag', 'expected a re-exec of the tag install.ps1');
  }
}

checkWorkflowRunner();
checkWorkflowBuild();
checkNoMacJob();
checkChecksumScript();
checkInstallPin();
checkInstallPs1();

if (failures.length) {
  console.error(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.log('\nall passed');
