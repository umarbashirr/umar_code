'use strict';
const path = require('path');

// Paths under resources/app.asar are a real file to Electron and a dead end to
// system node and shells. Rewrite to the unpacked twin before handing them out.
function externalPath(p) {
  if (!p || typeof p !== 'string') return p;
  return p.replace(/([/\\])app\.asar(?!\.unpacked)(?=[/\\]|$)/g, '$1app.asar.unpacked');
}

function mcpServerPath(root) {
  return externalPath(path.join(root, 'mcp', 'server.js'));
}

function binDir(root) {
  return externalPath(path.join(root, 'bin'));
}

module.exports = { externalPath, mcpServerPath, binDir };
