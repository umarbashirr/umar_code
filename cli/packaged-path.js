'use strict';
const path = require('path');

// Electron can read files inside resources/app.asar. System node and plain
// shells cannot. Paths handed to those outsiders must land on a real directory
// (app.asar.unpacked). MCP is the opposite case: its entry must stay inside
// the asar so electron-as-node can resolve packed node_modules. An unpacked
// mcp/server.js cannot see deps that remain in the archive.

function externalPath(p) {
  if (!p || typeof p !== 'string') return p;
  return p.replace(/([/\\])app\.asar(?!\.unpacked)(?=[/\\]|$)/g, '$1app.asar.unpacked');
}

function asarPath(p) {
  if (!p || typeof p !== 'string') return p;
  return p.replace(/([/\\])app\.asar\.unpacked(?=[/\\]|$)/g, '$1app.asar');
}

function mcpServerPath(root) {
  return path.join(asarPath(root), 'mcp', 'server.js');
}

function binDir(root) {
  return externalPath(path.join(root, 'bin'));
}

module.exports = { externalPath, asarPath, mcpServerPath, binDir };
