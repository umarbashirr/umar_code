'use strict';
const fs = require('fs');

// mkdirSync's mode only applies when it creates the directory. A dir left behind
// by an older build (0755, from before this file existed) keeps that mode
// forever unless something chmods it explicitly, so this always chmods too.
function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return dir;
}

module.exports = { ensurePrivateDir };
