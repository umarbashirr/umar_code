#!/usr/bin/env node
'use strict';
// P1.9: a --user tree install must update in place under ~/.local, not pkexec into /opt.
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = process.env.TANDEM_ROOT || path.join(__dirname, '..');
const failures = [];
const pass = (name) => console.log(`PASS ${name}`);
const fail = (name, detail) => {
  console.log(`FAIL ${name}: ${detail}`);
  failures.push(name);
};

function withMockedElectron(execPath, packaged, fn) {
  const electronPath = require.resolve('electron', { paths: [ROOT] });
  const prev = Module._cache[electronPath];
  Module._cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: {
      app: {
        isPackaged: packaged,
        getVersion: () => '0.0.0',
      },
    },
  };
  const prevExec = process.execPath;
  const prevAppImage = process.env.APPIMAGE;
  delete process.env.APPIMAGE;
  Object.defineProperty(process, 'execPath', { value: execPath, configurable: true });
  try {
    const updatesPath = require.resolve(path.join(ROOT, 'src/main/updates.js'));
    delete require.cache[updatesPath];
    return fn(require(updatesPath));
  } finally {
    Object.defineProperty(process, 'execPath', { value: prevExec, configurable: true });
    if (prevAppImage === undefined) delete process.env.APPIMAGE;
    else process.env.APPIMAGE = prevAppImage;
    if (prev) Module._cache[electronPath] = prev;
    else delete Module._cache[electronPath];
    const updatesPath = require.resolve(path.join(ROOT, 'src/main/updates.js'));
    delete require.cache[updatesPath];
  }
}

function stageTree(kind) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `tandem-p19-${kind}-`));
  const prefix = kind === 'user'
    ? path.join(base, '.local', 'lib', 'tandem')
    : path.join(base, 'opt', 'tandem');
  fs.mkdirSync(prefix, { recursive: true });
  fs.writeFileSync(path.join(prefix, '.tandem-version'), '0.9.1');
  const execPath = path.join(prefix, 'tandem');
  fs.writeFileSync(execPath, '#!/bin/sh\n');
  return { base, prefix, execPath };
}

function checkKindUserVsSystem() {
  const user = stageTree('user');
  const system = stageTree('system');
  try {
    const userKind = withMockedElectron(user.execPath, true, (api) => api.installKind());
    const systemKind = withMockedElectron(system.execPath, true, (api) => api.installKind());

    if (userKind === 'tree-user' || (userKind === 'tree' && userKind !== systemKind)) {
      // Accept tree-user as the preferred discriminator.
    }
    if (userKind === systemKind) {
      fail('installKind-separates-user-tree', `both returned ${userKind}`);
    } else if (userKind === 'tree-user' && systemKind === 'tree') {
      pass('installKind-separates-user-tree');
    } else {
      fail('installKind-separates-user-tree', `user=${userKind} system=${systemKind}`);
    }

    if (typeof withMockedElectron(user.execPath, true, (api) => api.installCommand) === 'function'
      || typeof withMockedElectron(user.execPath, true, (api) => api.buildTreeInstallArgv) === 'function') {
      // optional helper export
    }

    const userPlan = withMockedElectron(user.execPath, true, (api) => {
      if (typeof api.planTreeInstall !== 'function') return null;
      return api.planTreeInstall('/tmp/tandem.AppImage');
    });
    const systemPlan = withMockedElectron(system.execPath, true, (api) => {
      if (typeof api.planTreeInstall !== 'function') return null;
      return api.planTreeInstall('/tmp/tandem.AppImage');
    });

    if (!userPlan || !systemPlan) {
      fail('planTreeInstall-export', 'planTreeInstall(file) must describe argv + privilege for tree updates');
      return;
    }

    const userArgv = userPlan.argv.map(String);
    if (userPlan.asRoot) fail('user-tree-no-pkexec', `asRoot=${userPlan.asRoot}`);
    else pass('user-tree-no-pkexec');
    if (userArgv.includes('--user') && userArgv.includes('--file')) pass('user-tree-passes-user-flag');
    else fail('user-tree-passes-user-flag', `argv=${JSON.stringify(userArgv)}`);

    if (!systemPlan.asRoot) fail('system-tree-uses-pkexec', `asRoot=${systemPlan.asRoot}`);
    else pass('system-tree-uses-pkexec');
    if (!systemPlan.argv.map(String).includes('--user')) pass('system-tree-no-user-flag');
    else fail('system-tree-no-user-flag', `argv=${JSON.stringify(systemPlan.argv)}`);
  } finally {
    fs.rmSync(user.base, { recursive: true, force: true });
    fs.rmSync(system.base, { recursive: true, force: true });
  }
}

function checkInstallShHonorsUserKind() {
  const src = fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf8');
  const honors = /if \[ "\$KIND" = user \] \|\| \[ "\$ROOT" = no \]; then[\s\S]*?PREFIX=\$HOME\/\.local\/lib\/tandem/.test(src);
  if (honors) pass('install-sh-user-prefix');
  else fail('install-sh-user-prefix', 'install.sh must set ~/.local prefix when KIND=user');
}

function checkAssetExtMapsUserTree() {
  const user = stageTree('user');
  try {
    const extOk = withMockedElectron(user.execPath, true, (api) => {
      const assets = [{ name: 'tandem-0.9.2.AppImage', url: 'https://example/x', size: 1 }];
      const kind = api.installKind();
      const picked = api.pickAsset(assets, kind);
      return !!picked;
    });
    if (extOk) pass('pickAsset-for-user-tree');
    else fail('pickAsset-for-user-tree', 'pickAsset returned null for user-tree kind');
  } finally {
    fs.rmSync(user.base, { recursive: true, force: true });
  }
}

checkKindUserVsSystem();
checkInstallShHonorsUserKind();
checkAssetExtMapsUserTree();

if (failures.length) {
  console.error(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.log('\nall passed');
