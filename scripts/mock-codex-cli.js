#!/usr/bin/env node
'use strict';
// Stand-in for `codex`: enough of `--version` and `app-server` to let
// codex-driver.js's probe finish, for tests that need a real installed-CLI
// answer rather than a stubbed one.
const readline = require('readline');

if (process.argv.includes('--version')) {
  process.stdout.write('mock-codex 0.0.1\n');
  process.exit(0);
}

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function onMessage(msg) {
  if (!msg || typeof msg !== 'object' || msg.id === undefined || !msg.method) return;
  if (msg.method === 'initialize') {
    return send({ jsonrpc: '2.0', id: msg.id, result: { userAgent: 'mock-codex' } });
  }
  if (msg.method === 'model/list') {
    return send({
      jsonrpc: '2.0', id: msg.id,
      result: { data: [{ id: 'mock-codex-model', displayName: 'Mock Codex Model' }] },
    });
  }
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
}

if (process.argv.includes('app-server')) {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    try { onMessage(JSON.parse(line)); } catch {}
  });
  rl.on('close', () => process.exit(0));
} else {
  process.exit(1);
}
