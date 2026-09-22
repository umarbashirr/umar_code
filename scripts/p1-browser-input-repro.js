'use strict';
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const electron = require('electron');
const ROOT = process.env.TANDEM_ROOT || path.join(__dirname, '..');

const failures = [];
const pass = (name) => console.log(`PASS ${name}`);
const fail = (name, detail) => { console.log(`FAIL ${name}: ${detail}`); failures.push(name); };

function checkHelpClaims() {
  const tools = fs.readFileSync(path.join(ROOT, 'src/main/tools.js'), 'utf8');
  const shared = fs.readFileSync(path.join(ROOT, 'src/shared/browser-tools.js'), 'utf8');
  if (/fill:.*contenteditable/s.test(tools) || /help:.*contenteditable/.test(tools)) {
    pass('help-fill-claims-contenteditable');
  } else {
    fail('help-fill-claims-contenteditable', 'tools.js fill help missing contenteditable');
  }
  if (/Send real keystrokes/.test(tools) && /page listens for keydown/.test(shared)) {
    pass('help-type-claims-real-keystrokes');
  } else {
    fail('help-type-claims-real-keystrokes', 'type help/description drift');
  }
}

function checkSourceMismatches() {
  const browser = fs.readFileSync(path.join(ROOT, 'src/main/browser.js'), 'utf8');
  const page = fs.readFileSync(path.join(ROOT, 'src/main/page-script.js'), 'utf8');

  // type() should send keyDown (and typically keyUp), not only char.
  const typeFn = browser.match(/async type\(text[\s\S]*?^  async /m);
  const typeBody = typeFn ? typeFn[0] : '';
  if (/type:\s*'keyDown'/.test(typeBody) && /type:\s*'keyUp'/.test(typeBody)) {
    pass('source-type-keydown-keyup');
  } else {
    fail('source-type-keydown-keyup', 'type() still char-only or missing keyUp');
  }

  // fill must branch contenteditable before borrowing HTMLInputElement's setter.
  const fillFn = page.match(/fill\(target, value\) \{[\s\S]*?\n    \},/);
  const fillBody = fillFn ? fillFn[0] : '';
  const ceIdx = fillBody.search(/isContentEditable/);
  const inputSetterIdx = fillBody.search(/HTMLInputElement\.prototype/);
  if (ceIdx >= 0 && (inputSetterIdx < 0 || ceIdx < inputSetterIdx)) {
    pass('source-fill-contenteditable-first');
  } else {
    fail('source-fill-contenteditable-first', 'contenteditable path unreachable or missing');
  }

  // resolve must look inside same-origin iframes, matching walk().
  const resolveFn = page.match(/const resolve = \(target\) => \{[\s\S]*?\n  \};/);
  const resolveBody = resolveFn ? resolveFn[0] : '';
  if (/contentDocument|iframe/.test(resolveBody)) {
    pass('source-resolve-searches-iframes');
  } else {
    fail('source-resolve-searches-iframes', 'resolve() is top-document only');
  }

  // navigate's wait fail handler must filter like wireEvents (isMainFrame, not -3).
  const navFn = browser.match(/async navigate\(url[\s\S]*?^  async /m);
  const navBody = navFn ? navFn[0] : '';
  if (/isMainFrame/.test(navBody) && /!== -3|=== -3/.test(navBody)) {
    pass('source-navigate-filters-subframe-fail');
  } else {
    fail('source-navigate-filters-subframe-fail', 'navigate fail handler ignores isMainFrame/-3');
  }
}

function runProbe() {
  return new Promise((resolve) => {
    const probe = path.join(ROOT, 'scripts', '_p1-browser-input-probe.js');
    if (!fs.existsSync(probe)) {
      fail('probe-script', 'missing scripts/_p1-browser-input-probe.js');
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
      fail('runtime-probe', 'timed out');
      resolve();
    }, 60000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      process.stdout.write(out);
      if (err.trim()) process.stderr.write(err);
      if (code !== 0) fail('runtime-probe', `exit ${code}`);
      else if (!/all probe checks passed/.test(out)) {
        fail('runtime-probe', 'probe exited 0 without success line');
      }
      resolve();
    });
  });
}

async function main() {
  console.log('=== P1 browser input help vs behavior ===');
  checkHelpClaims();
  checkSourceMismatches();
  await runProbe();
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
