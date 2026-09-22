'use strict';
const path = require('path');

function screenshotFilePath(shotDir, name) {
  const fallback = () => `shot-${Date.now()}`;
  let stem;
  if (name != null && String(name).trim() !== '') {
    const base = path.basename(String(name)).replace(/\.png$/i, '');
    if (!base || base === '.' || base === '..') stem = fallback();
    else stem = base;
  } else {
    stem = fallback();
  }
  const file = path.resolve(shotDir, `${stem}.png`);
  const root = path.resolve(shotDir);
  if (file !== root && !file.startsWith(root + path.sep)) {
    return path.join(shotDir, `${fallback()}.png`);
  }
  return path.join(shotDir, `${stem}.png`);
}

module.exports = { screenshotFilePath };
