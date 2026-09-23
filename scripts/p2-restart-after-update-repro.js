#!/usr/bin/env node
'use strict';
// P2: restart-after-update. Proves the { running, installed, kind, ready }
// detection in src/main/updates.js: a newer on-disk marker for a tree install
// or a .deb flips `ready`, an equal or older one does not, and re-checking an
// already-seen installed version emits 'changed' only once. That last one is
// the property the dialog's "never show it twice per launch" leans on: the
// renderer only opens the dialog again when a fresh 'changed' event carries a
// different `installed`, so a main process that stays quiet on a repeat
// check is what keeps the prompt to one showing.
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const Module = require('module');

const ROOT = process.env.TANDEM_ROOT || path.join(__dirname, '..');
const failures = [];
const pass = (name) => console.log(`PASS ${name}`);
const fail = (name, detail) => {
  console.log(`FAIL ${name}: ${detail}`);
  failures.push(name);
};

// Same trick as p1-user-install-update-repro.js: swap the cached `electron`
// module for a stub and point process.execPath at a staged tree, then load
// updates.js fresh so its top-level `installKind()` calls see the fake.
// `fn` runs checkRestart(), which awaits inside (installedVersion is async
// even on the tree's synchronous fs.readFileSync path), so this must await
// `fn` itself before the `finally` below tears the mocks down — otherwise the
// teardown runs while fn is still suspended mid-await and the second half of
// its work sees the real electron module and the real process.execPath.
async function withMockedElectron(execPath, running, fn) {
  const electronPath = require.resolve('electron', { paths: [ROOT] });
  const prev = Module._cache[electronPath];
  Module._cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: { app: { isPackaged: true, getVersion: () => running } },
  };
  const prevExec = process.execPath;
  const prevAppImage = process.env.APPIMAGE;
  delete process.env.APPIMAGE;
  Object.defineProperty(process, 'execPath', { value: execPath, configurable: true });
  const updatesPath = require.resolve(path.join(ROOT, 'src/main/updates.js'));
  try {
    delete require.cache[updatesPath];
    return await fn(require(updatesPath));
  } finally {
    Object.defineProperty(process, 'execPath', { value: prevExec, configurable: true });
    if (prevAppImage === undefined) delete process.env.APPIMAGE;
    else process.env.APPIMAGE = prevAppImage;
    if (prev) Module._cache[electronPath] = prev;
    else delete Module._cache[electronPath];
    delete require.cache[updatesPath];
  }
}

function stageTree(marker) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-p2-restart-'));
  const prefix = path.join(base, '.local', 'lib', 'tandem');
  fs.mkdirSync(prefix, { recursive: true });
  if (marker != null) fs.writeFileSync(path.join(prefix, '.tandem-version'), marker);
  const execPath = path.join(prefix, 'tandem');
  fs.writeFileSync(execPath, '#!/bin/sh\n');
  return { base, execPath };
}

async function checkTreeNewerReady() {
  const { base, execPath } = stageTree('0.11.0');
  try {
    await withMockedElectron(execPath, '0.10.0', async (api) => {
      if (!api.Updates) { fail('tree-newer-marks-ready', 'src/main/updates.js exports no Updates class'); return; }
      const updates = new api.Updates();
      if (typeof updates.checkRestart !== 'function') {
        fail('tree-newer-marks-ready', 'Updates has no checkRestart(): nothing detects installed vs running');
        return;
      }
      const info = await updates.checkRestart();
      if (info && info.kind === 'tree-user' && info.installed === '0.11.0' && info.ready === true) {
        pass('tree-newer-marks-ready');
      } else {
        fail('tree-newer-marks-ready', JSON.stringify(info));
      }
    });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

async function checkTreeEqualNotReady() {
  const { base, execPath } = stageTree('0.10.0');
  try {
    await withMockedElectron(execPath, '0.10.0', async (api) => {
      if (!api.Updates || typeof (new api.Updates()).checkRestart !== 'function') {
        fail('tree-equal-no-prompt', 'no checkRestart() to call');
        return;
      }
      const updates = new api.Updates();
      const info = await updates.checkRestart();
      if (info && info.ready === false) pass('tree-equal-no-prompt');
      else fail('tree-equal-no-prompt', JSON.stringify(info));
    });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

async function checkTreeOlderNotReady() {
  const { base, execPath } = stageTree('0.9.0');
  try {
    await withMockedElectron(execPath, '0.10.0', async (api) => {
      if (!api.Updates || typeof (new api.Updates()).checkRestart !== 'function') {
        fail('tree-older-no-prompt', 'no checkRestart() to call');
        return;
      }
      const updates = new api.Updates();
      const info = await updates.checkRestart();
      if (info && info.ready === false) pass('tree-older-no-prompt');
      else fail('tree-older-no-prompt', JSON.stringify(info));
    });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

async function checkRepeatCheckEmitsOnce() {
  const { base, execPath } = stageTree('0.11.0');
  try {
    await withMockedElectron(execPath, '0.10.0', async (api) => {
      if (!api.Updates || typeof (new api.Updates()).checkRestart !== 'function') {
        fail('same-installed-version-emits-once', 'no checkRestart() to call');
        return;
      }
      const updates = new api.Updates();
      let changes = 0;
      updates.on('changed', () => { changes += 1; });
      await updates.checkRestart();
      await updates.checkRestart();
      await updates.checkRestart();
      if (changes === 1) pass('same-installed-version-emits-once');
      else fail('same-installed-version-emits-once', `'changed' fired ${changes} times for one installed version`);
    });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

async function checkDebNewerReady() {
  const origExecFile = cp.execFile;
  // dpkg-query is the .deb equivalent of the tree's .tandem-version file: the
  // marker that answers "what is on disk" without asking the process that is
  // itself the old version.
  cp.execFile = (cmd, args, opts, cb) => {
    const done = typeof opts === 'function' ? opts : cb;
    if (cmd === 'dpkg-query') { done(null, '0.11.0\n', ''); return undefined; }
    return origExecFile(cmd, args, opts, cb);
  };
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-p2-restart-deb-'));
  const execPath = path.join(base, 'opt', 'tandem', 'tandem');
  fs.mkdirSync(path.dirname(execPath), { recursive: true });
  fs.writeFileSync(execPath, '#!/bin/sh\n');
  try {
    await withMockedElectron(execPath, '0.10.0', async (api) => {
      if (!api.Updates || typeof (new api.Updates()).checkRestart !== 'function') {
        fail('deb-newer-marks-ready', 'no checkRestart() to call');
        return;
      }
      const updates = new api.Updates();
      const info = await updates.checkRestart();
      if (info && info.kind === 'deb' && info.installed === '0.11.0' && info.ready === true) {
        pass('deb-newer-marks-ready');
      } else {
        fail('deb-newer-marks-ready', JSON.stringify(info));
      }
    });
  } finally {
    cp.execFile = origExecFile;
    fs.rmSync(base, { recursive: true, force: true });
  }
}

(async () => {
  try {
    await checkTreeNewerReady();
    await checkTreeEqualNotReady();
    await checkTreeOlderNotReady();
    await checkRepeatCheckEmitsOnce();
    await checkDebNewerReady();
  } catch (e) {
    fail('probe-threw', e.stack || e.message);
  }

  if (failures.length) {
    console.error(`\n${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log('\nall passed');
})();
