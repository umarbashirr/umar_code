#!/usr/bin/env node
'use strict';
// Chromium's setuid sandbox helper has to be root-owned and mode 4755. On a
// fresh clone it is neither, and Electron aborts instead of running unsandboxed.
// Check first, fall back with a loud warning, and tell the user how to fix it.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const electron = require('electron');
const helper = path.join(path.dirname(electron), 'chrome-sandbox');

const args = process.argv.slice(2);

if (process.platform === 'linux' && !sandboxUsable()) {
  process.stderr.write(
    `\ntandem: running with --no-sandbox because ${helper} is not set up.\n` +
    `     Web content in the preview pane will not be sandboxed.\n` +
    `     Fix it once with:  npm run enable-sandbox\n\n`,
  );
  args.push('--no-sandbox');
}

function sandboxUsable() {
  try {
    const st = fs.statSync(helper);
    return st.uid === 0 && (st.mode & 0o4000) !== 0;
  } catch {
    return false;
  }
}

// `npm run dev` hands this script npm's own settings as npm_* variables, and
// everything the app starts would inherit them: every terminal, every agent.
// nvm refuses to load under npm_config_prefix, and an `npm install` the agent
// runs would take this repo's npm settings for its own. The installed app is
// never launched through npm, so dropping them here makes the two match.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^npm_/i.test(k) && k !== 'INIT_CWD'),
);

const child = spawn(electron, [path.join(__dirname, '..'), ...args], { stdio: 'inherit', env });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
