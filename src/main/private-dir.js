'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// getuid is POSIX-only. Windows doesn't share one tmp dir across OS accounts
// the way /tmp does, so there's no uid to fold into the name there, and no
// ownership to check either.
const uid = typeof process.getuid === 'function' ? process.getuid() : null;

function ownedByUs(stat) {
  return uid == null || stat.uid === uid;
}

// Whether `dir` is safe to write into: ours, and not a symlink someone else
// planted to redirect our writes at a path they control. lstat, not stat, so a
// symlink is seen as itself rather than followed through to its target.
function safeToUse(dir) {
  const st = fs.lstatSync(dir);
  return !st.isSymbolicLink() && ownedByUs(st);
}

// A private scratch dir for `name`, one per OS user so two accounts on the
// same box never fight over the same path in shared /tmp. A dir already there
// under someone else's ownership, or a symlink aimed elsewhere, is never
// reused or chmod'ed through: either falls back to a fresh mkdtemp dir that
// only we could have just created.
function ensurePrivateDir(name) {
  const dir = path.join(os.tmpdir(), uid == null ? name : `${name}-${uid}`);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!safeToUse(dir)) throw new Error(`${dir} is not safe to reuse`);
    // mkdirSync's mode only applies when it creates the dir, so a dir this
    // check just cleared but an older build left at 0755 still needs this.
    fs.chmodSync(dir, 0o700);
    return dir;
  } catch {
    return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  }
}

module.exports = { ensurePrivateDir };
