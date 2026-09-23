#!/usr/bin/env node
'use strict';
// A CLI installed while Tandem is already running was invisible until a full
// restart. shell-env.js asked the login shell for PATH once and cached it
// (`ready()`), find-binary.js and every driver's systemBinary() only ever
// searched that cached PATH, and nothing called anything to force a fresh
// ask. This drives the real login shell (a real spawn, a real rc file), not
// a stub, because the bug lives in the caching, not in the PATH parsing.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = process.env.TANDEM_ROOT || path.join(__dirname, '..');
const failures = [];
const pass = (name) => console.log(`PASS ${name}`);
const fail = (name, detail) => { console.log(`FAIL ${name}: ${detail}`); failures.push(name); };

const SHELL_CANDIDATES = ['/bin/zsh', '/usr/bin/zsh', '/bin/bash', '/usr/bin/bash'];
const shellBin = SHELL_CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
if (!shellBin) { console.log('FAIL setup: no zsh or bash on this machine to drive a real login shell'); process.exit(1); }
const isZsh = /zsh$/.test(shellBin);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-cli-recheck-'));
// .zshenv is read on every zsh invocation, login or not. bash's combined -lic
// flags read .bash_profile for a login shell. Either is where a real
// installer (nvm, asdf, a curl | sh script) appends its PATH export.
const rcFile = path.join(tmp, isZsh ? '.zshenv' : '.bash_profile');
const seenDir = path.join(tmp, 'seen'); // already on PATH before anything installs into it
fs.mkdirSync(seenDir);
// A fixed PATH, not the real machine's: the assertions below depend on which
// directory codex turns up in, and inheriting the host's PATH would make that
// nondeterministic.
fs.writeFileSync(rcFile, `export PATH="${seenDir}:/usr/bin:/bin"\n`);

process.env.HOME = tmp;
process.env.SHELL = shellBin;
// shell-env.js merges the shell's answer in front of whatever PATH this
// process already has, on the theory that a terminal's own PATH should win.
// That would otherwise leak this machine's real codex install (wherever this
// script happens to run) into the "before install" assertions below.
process.env.PATH = '/usr/bin:/bin';

const shellEnv = require(path.join(ROOT, 'src/main/shell-env.js'));
const { CodexDriver, codexBinary } = require(path.join(ROOT, 'src/main/codex-driver.js'));

function shim(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  // The spawned child's PATH is the fixed, minimal one this script built for
  // the login shell to report, which does not carry the real node install
  // this test runner happens to use. execPath sidesteps needing it on PATH.
  fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${path.join(__dirname, 'mock-codex-cli.js')}" "$@"\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

function checkWiring() {
  const idx = fs.readFileSync(path.join(ROOT, 'src/main/index.js'), 'utf8');
  if (/function recheckAgents\(\{ force = false \} = \{\}\)/.test(idx) && /ipcMain\.handle\('agent:recheck'/.test(idx)) {
    pass('index-recheck-wired');
  } else fail('index-recheck-wired', 'recheckAgents({ force }) or the agent:recheck handler is missing');
  if (/win\.on\('focus'/.test(idx)) pass('index-focus-recheck-wired');
  else fail('index-focus-recheck-wired', "no win.on('focus', ...) re-check");
  if (/!force && !row\.driver\.stale/.test(idx)) pass('index-recheck-gated-on-stale');
  else fail('index-recheck-gated-on-stale', 'the automatic path no longer skips drivers that are not stale');

  const preload = fs.readFileSync(path.join(ROOT, 'src/preload/index.js'), 'utf8');
  if (/recheck:\s*\(force\)\s*=>\s*ipcRenderer\.invoke\('agent:recheck',\s*\{\s*force:/.test(preload)) {
    pass('preload-recheck-wired');
  } else fail('preload-recheck-wired', 'preload does not forward force to agent:recheck');

  const panel = fs.readFileSync(path.join(ROOT, 'src/renderer/ui/components/settings-panel.jsx'), 'utf8');
  if (/agent\.recheck\(true\)/.test(panel) && /Re-check/.test(panel)) pass('settings-recheck-button-wired');
  else fail('settings-recheck-button-wired', 'the per-CLI Settings page has no button forcing a Re-check');
}

(async () => {
  try {
    await shellEnv.ready();
    if (codexBinary() === null) pass('codex-not-on-path-before-install');
    else fail('codex-not-on-path-before-install', String(codexBinary()));

    // Installed into a directory the login shell already put on PATH.
    // find-binary re-lists a cached directory's contents on every call, so an
    // install here needs no re-ask at all: this is the case that already
    // worked before this fix, kept here so a regression in the fix would show.
    const seenBin = shim(seenDir, 'codex');
    if (codexBinary() === fs.realpathSync(seenBin)) pass('binary-in-already-known-dir-found-without-reask');
    else fail('binary-in-already-known-dir-found-without-reask', String(codexBinary()));
    fs.unlinkSync(seenBin); // isolate the next case from this one

    // Installed into a brand new directory, the way a real installer does,
    // with the export appended to the rc file after Tandem was already
    // running. This is the reported bug.
    const newDir = path.join(tmp, 'new');
    const newBin = shim(newDir, 'codex');
    fs.appendFileSync(rcFile, `export PATH="${newDir}:$PATH"\n`);

    await shellEnv.ready();
    if (codexBinary() === null) pass('new-dir-not-found-by-stale-ready');
    else fail('new-dir-not-found-by-stale-ready', 'ready() alone re-read PATH; this case no longer isolates the bug');

    let driver = null;
    try {
      await shellEnv.reask();
      driver = new CodexDriver({ cacheDir: tmp });
      const snap = await driver.refresh();
      if (snap.installed && snap.binaryPath === fs.realpathSync(newBin)) {
        pass('recheck-finds-cli-installed-after-launch');
      } else {
        fail('recheck-finds-cli-installed-after-launch', JSON.stringify(snap));
      }
    } catch (e) {
      fail('recheck-finds-cli-installed-after-launch', `shellEnv.reask() ${e.message}`);
    }

    // An automatic re-check (window focus, a page opening) must not re-spawn
    // a CLI whose binary has not moved: that is the whole point of gating on
    // `stale` instead of always refreshing. Counted through a file because the
    // count lives in the mock's own process, not this one.
    if (driver) {
      const countFile = path.join(tmp, 'probe-count');
      fs.writeFileSync(countFile, '');
      process.env.MOCK_CODEX_COUNT_FILE = countFile;
      try {
        if (!driver.stale) {
          // Mirrors recheckAgents()'s automatic branch in src/main/index.js:
          // `if (!force && !row.driver.stale) continue;`
        } else {
          await driver.refresh();
        }
        const quietCount = fs.readFileSync(countFile, 'utf8').length;
        if (quietCount === 0) pass('quiet-recheck-does-not-reprobe-unchanged-driver');
        else fail('quiet-recheck-does-not-reprobe-unchanged-driver', `mock ran ${quietCount / 2} time(s) with nothing stale`);

        await driver.refresh(); // the force path: unconditional, same as the button
        const forcedCount = fs.readFileSync(countFile, 'utf8').length;
        if (forcedCount > quietCount) pass('forced-recheck-reprobes-unchanged-driver');
        else fail('forced-recheck-reprobes-unchanged-driver', `count stayed at ${forcedCount} after an unconditional refresh()`);
      } finally {
        delete process.env.MOCK_CODEX_COUNT_FILE;
      }
    }
  } catch (e) {
    fail('probe-threw', e.stack || e.message);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  checkWiring();

  if (failures.length) {
    console.log(`\n${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log('\nall passed');
})();
