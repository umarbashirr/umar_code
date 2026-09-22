'use strict';
const fs = require('fs');
const path = require('path');

async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return;
  const exeName = context.packager.executableName || 'tandem';
  const exe = path.join(context.appOutDir, exeName);
  const real = `${exe}.real`;
  if (!fs.existsSync(exe) || fs.existsSync(real)) return;
  fs.renameSync(exe, real);
  fs.copyFileSync(path.join(__dirname, 'linux-sandbox-wrapper.sh'), exe);
  fs.chmodSync(exe, 0o755);
}

module.exports = afterPack;
