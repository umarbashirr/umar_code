#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = process.env.TANDEM_ROOT || path.join(__dirname, '..');

const failures = [];
const pass = (name) => console.log(`PASS ${name}`);
const fail = (name, detail) => { console.log(`FAIL ${name}: ${detail}`); failures.push(name); };

function packagedDesktopExec(executableArgs) {
  const defaultArgs = ['--no-sandbox'];
  const args = executableArgs !== undefined && executableArgs !== null ? executableArgs : defaultArgs;
  return ['AppRun', ...args, '%U'].join(' ');
}

function checkPackageJson() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const args = pkg.build && pkg.build.appImage && pkg.build.appImage.executableArgs;
  if (args === undefined || args === null) {
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

  const hook = pkg.build.afterPack;
  if (hook === 'scripts/after-pack-linux-sandbox.js' || hook === './scripts/after-pack-linux-sandbox.js') {
    pass('afterPack-hook');
  } else {
    fail('afterPack-hook', `build.afterPack=${JSON.stringify(hook)}`);
  }
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

function checkTreeSetuidIntact() {
  const install = fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf8');
  if (/chmod 4755 "\$PREFIX\/chrome-sandbox"/.test(install)) pass('install-sh-setuid-helper');
  else fail('install-sh-setuid-helper', 'install.sh no longer setuids chrome-sandbox for root tree installs');
  if (/ROOT" = no \]; then EXEC="\$PREFIX\/tandem --no-sandbox/.test(install)) {
    pass('install-sh-user-desktop-flag');
  } else {
    fail('install-sh-user-desktop-flag', 'user tree desktop Exec must keep --no-sandbox');
  }

  const deb = fs.readFileSync(path.join(ROOT, 'build/deb-postinstall.sh'), 'utf8');
  if (/chmod 4755 "\$INSTALL_DIR\/chrome-sandbox"/.test(deb)) pass('deb-postinstall-setuid-helper');
  else fail('deb-postinstall-setuid-helper', 'deb-postinstall.sh no longer setuids chrome-sandbox');
}

function checkDevCliPolicyIntact() {
  const launch = fs.readFileSync(path.join(ROOT, 'scripts/launch.js'), 'utf8');
  const cli = fs.readFileSync(path.join(ROOT, 'cli/tandem.js'), 'utf8');
  if (/st\.uid === 0 && \(st\.mode & 0o4000\) !== 0/.test(launch)) pass('launch-js-helper-check');
  else fail('launch-js-helper-check', 'scripts/launch.js must test uid 0 and setuid on chrome-sandbox');
  if (/st\.uid === 0 && \(st\.mode & 0o4000\) !== 0/.test(cli)) pass('cli-helper-check');
  else fail('cli-helper-check', 'cli/tandem.js sandboxArgs must test uid 0 and setuid on chrome-sandbox');
}

function wrapperSrc() {
  const p = path.join(ROOT, 'scripts/linux-sandbox-wrapper.sh');
  if (!fs.existsSync(p)) return null;
  return { path: p, text: fs.readFileSync(p, 'utf8') };
}

function checkWrapperSource() {
  const wrap = wrapperSrc();
  if (!wrap) {
    fail('wrapper-source', 'scripts/linux-sandbox-wrapper.sh missing');
    return;
  }
  pass('wrapper-source');
  if (/\[ -u /.test(wrap.text) && /stat -c %u/.test(wrap.text) && /--no-sandbox/.test(wrap.text)) {
    pass('wrapper-matches-helper-check');
  } else {
    fail('wrapper-matches-helper-check', 'wrapper must test setuid bit, uid 0, and pass --no-sandbox when unusable');
  }
  if (/ELECTRON_RUN_AS_NODE/.test(wrap.text)) pass('wrapper-skips-node-cli');
  else fail('wrapper-skips-node-cli', 'wrapper must not add --no-sandbox for ELECTRON_RUN_AS_NODE');
}

function checkAfterPackSource() {
  const p = path.join(ROOT, 'scripts/after-pack-linux-sandbox.js');
  if (!fs.existsSync(p)) {
    fail('afterPack-source', 'scripts/after-pack-linux-sandbox.js missing');
    return null;
  }
  pass('afterPack-source');
  const src = fs.readFileSync(p, 'utf8');
  if (/linux-sandbox-wrapper\.sh/.test(src) && /\.real/.test(src)) pass('afterPack-renames-and-wraps');
  else fail('afterPack-renames-and-wraps', 'afterPack must rename the binary to *.real and install the wrapper');
  if (/electronPlatformName !== 'linux'/.test(src) || /electronPlatformName != 'linux'/.test(src)) {
    pass('afterPack-linux-only');
  } else {
    fail('afterPack-linux-only', 'afterPack must leave non-linux packs alone');
  }
  return require(p);
}

function stageAppDir() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-appimage-sandbox-'));
  const dummy = '#!/bin/sh\nprintf "ARGS:%s\\n" "$*"\n';
  fs.writeFileSync(path.join(base, 'tandem'), dummy, { mode: 0o755 });
  return base;
}

function runWrapped(dir, extraEnv = {}, extraArgs = ['--user-data-dir=/tmp/x']) {
  const env = { ...process.env, ...extraEnv };
  if (!Object.prototype.hasOwnProperty.call(extraEnv, 'ELECTRON_RUN_AS_NODE')) {
    delete env.ELECTRON_RUN_AS_NODE;
  }
  return spawnSync(path.join(dir, 'tandem'), extraArgs, {
    encoding: 'utf8',
    env,
  });
}

async function checkAfterPackWraps(afterPack) {
  if (typeof afterPack !== 'function') {
    fail('afterPack-export', 'afterPack hook is not a function');
    return;
  }
  pass('afterPack-export');

  const darwin = stageAppDir();
  try {
    await afterPack({
      electronPlatformName: 'darwin',
      appOutDir: darwin,
      packager: { executableName: 'tandem' },
    });
    if (!fs.existsSync(path.join(darwin, 'tandem.real'))) pass('afterPack-skips-non-linux');
    else fail('afterPack-skips-non-linux', 'wrapped a darwin out dir');
  } finally {
    fs.rmSync(darwin, { recursive: true, force: true });
  }

  const dir = stageAppDir();
  try {
    await afterPack({
      electronPlatformName: 'linux',
      appOutDir: dir,
      packager: { executableName: 'tandem' },
    });
    if (fs.existsSync(path.join(dir, 'tandem.real'))) pass('afterPack-keeps-real-binary');
    else fail('afterPack-keeps-real-binary', 'tandem.real missing after linux afterPack');

    const missing = runWrapped(dir);
    if ((missing.stdout || '').includes('ARGS:--no-sandbox --user-data-dir=/tmp/x')) {
      pass('wrap-missing-helper-adds-flag');
    } else {
      fail('wrap-missing-helper-adds-flag', `stdout=${JSON.stringify(missing.stdout)} stderr=${JSON.stringify(missing.stderr)}`);
    }

    fs.writeFileSync(path.join(dir, 'chrome-sandbox'), 'helper', { mode: 0o755 });
    const plain = runWrapped(dir);
    if ((plain.stdout || '').includes('ARGS:--no-sandbox')) pass('wrap-non-setuid-helper-adds-flag');
    else fail('wrap-non-setuid-helper-adds-flag', `stdout=${JSON.stringify(plain.stdout)}`);

    fs.chmodSync(path.join(dir, 'chrome-sandbox'), 0o4755);
    const fakeNonRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-fake-stat-nuid-'));
    fs.writeFileSync(
      path.join(fakeNonRootDir, 'stat'),
      '#!/bin/sh\nif [ "$1" = -c ] && [ "$2" = %u ]; then echo 1000; exit 0; fi\nexec /usr/bin/stat "$@"\n',
      { mode: 0o755 },
    );
    const setuidNonRoot = runWrapped(dir, { PATH: `${fakeNonRootDir}${path.delimiter}${process.env.PATH}` });
    if ((setuidNonRoot.stdout || '').includes('ARGS:--no-sandbox')) pass('wrap-setuid-nonroot-adds-flag');
    else fail('wrap-setuid-nonroot-adds-flag', `stdout=${JSON.stringify(setuidNonRoot.stdout)}`);
    fs.rmSync(fakeNonRootDir, { recursive: true, force: true });

    const fakeStatDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-fake-stat-'));
    fs.writeFileSync(
      path.join(fakeStatDir, 'stat'),
      '#!/bin/sh\nif [ "$1" = -c ] && [ "$2" = %u ]; then echo 0; exit 0; fi\nexec /usr/bin/stat "$@"\n',
      { mode: 0o755 },
    );
    const usable = runWrapped(dir, { PATH: `${fakeStatDir}${path.delimiter}${process.env.PATH}` });
    if (/ARGS:--no-sandbox/.test(usable.stdout || '')) {
      fail('wrap-setuid-root-omits-flag', `still passed --no-sandbox: ${JSON.stringify(usable.stdout)}`);
    } else if ((usable.stdout || '').includes('ARGS:--user-data-dir=/tmp/x')) {
      pass('wrap-setuid-root-omits-flag');
    } else {
      fail('wrap-setuid-root-omits-flag', `stdout=${JSON.stringify(usable.stdout)} stderr=${JSON.stringify(usable.stderr)}`);
    }
    fs.rmSync(fakeStatDir, { recursive: true, force: true });

    const asNode = runWrapped(dir, { ELECTRON_RUN_AS_NODE: '1' });
    if (/ARGS:--no-sandbox/.test(asNode.stdout || '')) {
      fail('wrap-node-cli-omits-flag', `stdout=${JSON.stringify(asNode.stdout)}`);
    } else if ((asNode.stdout || '').includes('ARGS:--user-data-dir=/tmp/x')) {
      pass('wrap-node-cli-omits-flag');
    } else {
      fail('wrap-node-cli-omits-flag', `stdout=${JSON.stringify(asNode.stdout)}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  checkPackageJson();
  checkDesktopExecContract();
  checkTreeSetuidIntact();
  checkDevCliPolicyIntact();
  checkWrapperSource();
  const afterPack = checkAfterPackSource();
  if (afterPack) await checkAfterPackWraps(afterPack);

  if (failures.length) {
    console.log(`\n${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log('\nall checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
