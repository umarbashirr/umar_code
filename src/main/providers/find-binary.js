'use strict';
const fs = require('fs');
const path = require('path');
const shellEnv = require('../shell-env');

function namesFor(base) {
  const list = Array.isArray(base) ? base : [base];
  if (process.platform !== 'win32') return list;
  const out = [];
  for (const n of list) {
    if (/\.(exe|cmd|bat)$/i.test(n)) out.push(n);
    else out.push(`${n}.exe`, `${n}.cmd`, `${n}.bat`, n);
  }
  return out;
}

function findOnPath(binaries, accept) {
  const names = namesFor(binaries);
  for (const dir of (shellEnv.cached() || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (!fs.existsSync(candidate)) continue;
        const realPath = fs.realpathSync(candidate);
        if (typeof accept === 'function' && !accept(realPath, name)) continue;
        return realPath;
      } catch {}
    }
  }
  return null;
}

function makeLocator(binaries, accept) {
  let preferred = null;
  return {
    prefer(p) {
      preferred = p && typeof p === 'string' && fs.existsSync(p) ? p : null;
      return preferred;
    },
    current() {
      if (preferred) {
        try { if (fs.existsSync(preferred)) return preferred; } catch {}
      }
      return findOnPath(binaries, accept);
    },
  };
}

module.exports = { findOnPath, makeLocator, namesFor };
