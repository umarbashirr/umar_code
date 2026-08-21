'use strict';
// Which branch the project folder is on. This reads .git/HEAD instead of
// shelling out: the chat pill asks for it on a timer, and forking a process
// every few seconds to print one line is not worth it. It also works when the
// machine has no git on PATH.
const fs = require('fs');
const path = require('path');

// A worktree or a submodule has a .git file holding "gitdir: <path>" rather
// than a directory, and that path is where HEAD actually lives.
function gitDir(dir) {
  let at = path.resolve(dir || '');
  for (;;) {
    const dot = path.join(at, '.git');
    try {
      const st = fs.statSync(dot);
      if (st.isDirectory()) return dot;
      if (st.isFile()) {
        const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dot, 'utf8'));
        if (m) return path.resolve(at, m[1].trim());
      }
    } catch {}
    const up = path.dirname(at);
    if (up === at) return null;
    at = up;
  }
}

function branch(dir) {
  const g = gitDir(dir);
  if (!g) return null;
  let head = '';
  try { head = fs.readFileSync(path.join(g, 'HEAD'), 'utf8').trim(); } catch { return null; }
  const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
  // Detached HEAD has no name to show, so show the commit it is sitting on.
  return m ? m[1] : (head ? head.slice(0, 7) : null);
}

module.exports = { branch, gitDir };
