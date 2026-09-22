#!/usr/bin/env node
'use strict';
// Prove that a packaged Windows install resolves bare `tandem` to the CLI
// shim, not tandem.exe. cmd.exe and PowerShell both walk PATHEXT in order;
// the default list puts .EXE before .CMD, so a sibling tandem.cmd never wins
// when the install dir itself is on PATH.
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = process.env.TANDEM_ROOT || path.join(__dirname, '..');

const DEFAULT_PATHEXT = ['.COM', '.EXE', '.BAT', '.CMD', '.VBS', '.VBE', '.JS', '.JSE', '.WSF', '.WSH', '.MSC'];

const failures = [];
const pass = (name) => console.log(`PASS ${name}`);
const fail = (name, detail) => { console.log(`FAIL ${name}: ${detail}`); failures.push(name); };

function resolveCommand(name, pathDirs, pathext = DEFAULT_PATHEXT) {
  for (const dir of pathDirs) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch { continue; }
    const lower = Object.create(null);
    for (const e of entries) lower[e.toLowerCase()] = e;
    const bare = lower[name.toLowerCase()];
    if (bare) {
      const full = path.join(dir, bare);
      if (fs.statSync(full).isFile()) return full;
    }
    for (const ext of pathext) {
      const hit = lower[(name + ext).toLowerCase()];
      if (!hit) continue;
      const full = path.join(dir, hit);
      if (fs.statSync(full).isFile()) return full;
    }
  }
  return null;
}

function stageLayout(kind) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `tandem-win-cli-${kind}-`));
  const inst = path.join(base, 'Programs', 'tandem');
  fs.mkdirSync(inst, { recursive: true });
  fs.writeFileSync(path.join(inst, 'tandem.exe'), 'GUI');
  if (kind === 'broken') {
    fs.writeFileSync(path.join(inst, 'tandem.cmd'), '@echo CLI');
    return { base, pathDirs: [inst], cliHint: path.join(inst, 'tandem.cmd') };
  }
  const bin = path.join(inst, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'tandem.cmd'), '@echo CLI');
  return { base, pathDirs: [bin], cliHint: path.join(bin, 'tandem.cmd') };
}

function checkBrokenLayoutLosesToExe() {
  const { base, pathDirs } = stageLayout('broken');
  try {
    const hit = resolveCommand('tandem', pathDirs);
    if (hit && path.basename(hit).toLowerCase() === 'tandem.exe') {
      pass('pathext-exe-beats-sibling-cmd');
    } else {
      fail('pathext-exe-beats-sibling-cmd', `expected tandem.exe, got ${hit}`);
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function checkFixedLayoutPicksCmd() {
  const { base, pathDirs, cliHint } = stageLayout('fixed');
  try {
    const hit = resolveCommand('tandem', pathDirs);
    if (hit === cliHint) {
      pass('pathext-bin-dir-picks-cmd');
    } else {
      fail('pathext-bin-dir-picks-cmd', `expected ${cliHint}, got ${hit}`);
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function checkUpgradeKeepsExeOutOfPath() {
  const { base, pathDirs } = stageLayout('fixed');
  const inst = path.dirname(pathDirs[0]);
  try {
    // Legacy installs put $INSTDIR on PATH. If it stays ahead of bin, the bug
    // returns. Resolution with both entries must still hit the cmd shim.
    const hit = resolveCommand('tandem', [inst, ...pathDirs]);
    if (hit && path.basename(hit).toLowerCase() === 'tandem.exe') {
      pass('legacy-instdir-ahead-still-exe');
    } else {
      fail('legacy-instdir-ahead-still-exe', `expected exe when INSTDIR leads, got ${hit}`);
    }
    const hitFixed = resolveCommand('tandem', pathDirs);
    if (hitFixed && path.basename(hitFixed).toLowerCase() === 'tandem.cmd') {
      pass('path-without-instdir-picks-cmd');
    } else {
      fail('path-without-instdir-picks-cmd', `expected cmd when only bin is on PATH, got ${hitFixed}`);
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function checkPackagingSources() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const extras = (((pkg.build || {}).win || {}).extraFiles) || [];
  const cliExtra = extras.find((e) => String(e.from || '').endsWith('tandem.cmd'));
  if (cliExtra && String(cliExtra.to).replace(/\\/g, '/') === 'bin/tandem.cmd') {
    pass('package-extraFiles-cli-in-bin');
  } else {
    fail('package-extraFiles-cli-in-bin', `extraFiles tandem.cmd to=${cliExtra && cliExtra.to}`);
  }

  const nsh = fs.readFileSync(path.join(ROOT, 'build/installer.nsh'), 'utf8');
  const installMacro = nsh.match(/!macro customInstall[\s\S]*?!macroend/);
  const installBody = installMacro ? installMacro[0] : '';
  if (/\$\$bin\s*=/.test(installBody) && /\$INSTDIR\\bin/.test(installBody)) {
    pass('installer-path-points-at-bin');
  } else {
    fail('installer-path-points-at-bin', 'installer.nsh still adds bare $INSTDIR to PATH');
  }
  if (/\$\$_ -ne \$\$dir/.test(installBody) && /\$\$bin/.test(installBody)) {
    pass('installer-strips-legacy-instdir');
  } else {
    fail('installer-strips-legacy-instdir', 'upgrade PATH edit must drop bare $INSTDIR');
  }

  const uninstallMacro = nsh.match(/!macro customUnInstall[\s\S]*?!macroend/);
  const uninstallBody = uninstallMacro ? uninstallMacro[0] : '';
  if (/\$\$bin/.test(uninstallBody) && /\$\$_ -ne \$\$dir/.test(uninstallBody)) {
    pass('uninstaller-removes-bin-and-legacy');
  } else {
    fail('uninstaller-removes-bin-and-legacy', 'uninstall must drop both bin and legacy INSTDIR');
  }

  const cmd = fs.readFileSync(path.join(ROOT, 'build/tandem.cmd'), 'utf8');
  if (/%~dp0\.\.\\tandem\.exe/.test(cmd) || /%~dp0\.\.[\\/]tandem\.exe/.test(cmd)) {
    pass('tandem-cmd-parents-to-exe');
  } else {
    fail('tandem-cmd-parents-to-exe', 'bin/tandem.cmd must call ..\\tandem.exe');
  }
}

checkBrokenLayoutLosesToExe();
checkFixedLayoutPicksCmd();
checkUpgradeKeepsExeOutOfPath();
checkPackagingSources();

if (failures.length) {
  console.log(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.log('\nall checks passed');
