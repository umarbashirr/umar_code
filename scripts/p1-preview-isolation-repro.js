'use strict';
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const electron = require('electron');
const ROOT = process.env.TANDEM_ROOT || path.join(__dirname, '..');
const { normalizeUrl, isAllowedUrl } = require(path.join(ROOT, 'src/main/url.js'));

const failures = [];
const pass = (name) => console.log(`PASS ${name}`);
const fail = (name, detail) => { console.log(`FAIL ${name}: ${detail}`); failures.push(name); };

function checkSchemeAllowlist() {
  if (typeof isAllowedUrl !== 'function') {
    fail('isAllowedUrl-exported', 'isAllowedUrl missing from url.js');
  } else {
    pass('isAllowedUrl-exported');
  }

  const allowed = [
    ['https://example.com/', 'https://example.com/'],
    ['http://localhost:3000', 'http://localhost:3000/'],
    ['localhost:5173', 'http://localhost:5173/'],
    ['example.com', 'https://example.com/'],
    ['about:blank', 'about:blank'],
  ];
  for (const [input, wantPrefix] of allowed) {
    let got;
    try {
      got = normalizeUrl(input);
    } catch (e) {
      fail(`allow-${input}`, e.message);
      continue;
    }
    if (got === wantPrefix || got.startsWith(wantPrefix.replace(/\/$/, ''))) pass(`allow-${input}`);
    else fail(`allow-${input}`, `got ${got}`);
  }

  const blocked = [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,hi',
    'chrome://version',
    'blob:https://example.com/abc',
  ];
  for (const input of blocked) {
    let threw = false;
    let got;
    try {
      got = normalizeUrl(input);
    } catch (e) {
      threw = true;
      if (/blocked|scheme/i.test(e.message)) pass(`block-${input}`);
      else fail(`block-${input}`, `threw wrong: ${e.message}`);
    }
    if (!threw) fail(`block-${input}`, `returned ${got}`);
  }

  if (typeof isAllowedUrl === 'function') {
    if (isAllowedUrl('https://ok.example/') && !isAllowedUrl('file:///tmp/x')) {
      pass('isAllowedUrl-behavior');
    } else {
      fail('isAllowedUrl-behavior', 'http ok / file blocked expected');
    }
  }
}

function checkPartitionWiring() {
  const browserSrc = fs.readFileSync(path.join(ROOT, 'src/main/browser.js'), 'utf8');
  const indexSrc = fs.readFileSync(path.join(ROOT, 'src/main/index.js'), 'utf8');

  if (/partition\s*:/.test(browserSrc) || /webPreferences:\s*\{[^}]*partition/.test(browserSrc)) {
    pass('browser-sets-partition');
  } else {
    fail('browser-sets-partition', 'WebContentsView has no partition');
  }

  if (/will-navigate/.test(browserSrc)) pass('browser-guards-will-navigate');
  else fail('browser-guards-will-navigate', 'no will-navigate handler');

  if (/new BrowserPane\(\s*win\s*,\s*HOME_URL\s*,/.test(indexSrc)
    || /new BrowserPane\(win,\s*HOME_URL,\s*\{/.test(indexSrc)) {
    pass('paneOf-passes-partition-opts');
  } else {
    fail('paneOf-passes-partition-opts', 'paneOf still constructs BrowserPane without opts');
  }

  if (/partitionFor|persist:tandem/.test(browserSrc) || /partitionFor|persist:tandem/.test(indexSrc)) {
    pass('partition-namespaced');
  } else {
    fail('partition-namespaced', 'no persist:tandem partition naming');
  }
}

function runCookieIsolation() {
  return new Promise((resolve) => {
    const probe = path.join(ROOT, 'scripts', '_p1-preview-cookie-probe.js');
    if (!fs.existsSync(probe)) {
      fail('cookie-probe-script', 'missing scripts/_p1-preview-cookie-probe.js');
      return resolve();
    }
    const child = spawn(electron, [probe], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail('cookie-isolation-runtime', 'timed out');
      resolve();
    }, 45000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      process.stdout.write(out);
      if (err.trim()) process.stderr.write(err);
      if (code !== 0) fail('cookie-isolation-runtime', `exit ${code}`);
      else if (!/PASS cookie-partitions-isolated/.test(out)) {
        fail('cookie-isolation-runtime', 'probe exited 0 without PASS line');
      }
      resolve();
    });
  });
}

async function main() {
  console.log('=== P1 preview isolation ===');
  checkSchemeAllowlist();
  checkPartitionWiring();
  await runCookieIsolation();
  if (failures.length) {
    console.log(`\n${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log('\nall passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
