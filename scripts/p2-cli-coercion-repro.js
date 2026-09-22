#!/usr/bin/env node
'use strict';
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { localUrls } = require('../src/main/sniff');

const ROOT = path.join(__dirname, '..');
const failures = [];
const pass = (name) => console.log(`PASS ${name}`);
const fail = (name, detail) => { console.log(`FAIL ${name}: ${detail}`); failures.push(name); };

function checkLocalHosts() {
  const text = [
    'Local:   http://localhost:3000/',
    'loop    http://127.0.0.1:8080/health',
    'sub     http://app.localhost:3000/',
    'public  http://notlocalhost.example.com/app',
    'prefix  http://localhost.example.com/',
    'ip      http://127.0.0.1.example.com/',
    'path    http://evil.com/localhost',
  ].join('\n');
  const found = localUrls(text);
  const want = [
    'http://localhost:3000/',
    'http://127.0.0.1:8080/health',
    'http://app.localhost:3000/',
  ];
  if (found.length === want.length && want.every((url, i) => found[i] === url)) pass('localhost-host-boundary');
  else fail('localhost-host-boundary', JSON.stringify({ found, want }));
}

function runFill(base, token) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'cli/tandem.js'), 'fill', 'e3', '007'], {
      cwd: ROOT,
      env: { ...process.env, TANDEM_BRIDGE_URL: base, TANDEM_TOKEN: token },
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stderr }));
  });
}

async function checkNumericString() {
  let body = null;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const payload = JSON.stringify({ result: 'ok' });
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      });
      res.end(payload);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const ran = await runFill(`http://127.0.0.1:${port}`, 'repro-token');
    if (ran.code !== 0) {
      fail('numeric-string-preserved', `exit ${ran.code} ${ran.stderr.trim()}`);
      return;
    }
    if (body && body.target === 'e3' && body.value === '007' && typeof body.value === 'string') {
      pass('numeric-string-preserved');
    } else {
      fail('numeric-string-preserved', JSON.stringify(body));
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

(async () => {
  checkLocalHosts();
  await checkNumericString();
  if (failures.length) {
    console.log(`FAIL ${failures.length}`);
    process.exit(1);
  }
  console.log('ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
