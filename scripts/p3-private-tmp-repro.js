'use strict';
// P3.1: screenshots and pasted attachments land in a shared tmp dir. Anyone
// else on the box must not be able to read them.
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = process.env.TANDEM_ROOT || path.join(__dirname, '..');

const failures = [];
const pass = (name) => console.log(`PASS ${name}`);
const fail = (name, detail) => { console.log(`FAIL ${name}: ${detail}`); failures.push(name); };

const mode = (p) => fs.statSync(p).mode & 0o777;

let ensurePrivateDir = null;
try {
  ({ ensurePrivateDir } = require(path.join(ROOT, 'src/main/private-dir.js')));
} catch (e) {
  fail('load-private-dir', e.message);
}

function checkEnsurePrivateDirFresh() {
  if (!ensurePrivateDir) { fail('ensurePrivateDir-creates-0700', 'private-dir.js not loaded'); return; }
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-repro-')), 'shots');
  ensurePrivateDir(dir);
  if (mode(dir) === 0o700) pass('ensurePrivateDir-creates-0700');
  else fail('ensurePrivateDir-creates-0700', `mode=${mode(dir).toString(8)}`);
}

// mkdirSync's mode option only applies when it creates the dir. A dir an older
// build already left at 0755 must still end up private.
function checkEnsurePrivateDirFixesStaleDir() {
  if (!ensurePrivateDir) { fail('ensurePrivateDir-fixes-stale-0755-dir', 'private-dir.js not loaded'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-repro-stale-'));
  fs.chmodSync(dir, 0o755);
  ensurePrivateDir(dir);
  if (mode(dir) === 0o700) pass('ensurePrivateDir-fixes-stale-0755-dir');
  else fail('ensurePrivateDir-fixes-stale-0755-dir', `mode=${mode(dir).toString(8)}`);
}

// attachments.js's fromDataUrl writes a pasted image to disk without touching
// Electron, so it can run for real here (unlike browser.js, which needs a
// live WebContentsView).
async function checkAttachmentFileIsPrivate() {
  let fromDataUrl;
  try {
    ({ fromDataUrl } = require(path.join(ROOT, 'src/main/attachments.js')));
  } catch (e) {
    fail('load-attachments', e.message);
    return;
  }
  // fromDataUrl always writes into the same real os.tmpdir()/tandem-attachments,
  // regardless of which checkout's copy of the function is under test here, so a
  // dir a previous run left behind (private or not) must not leak into this one.
  try { fs.rmSync(path.join(os.tmpdir(), 'tandem-attachments'), { recursive: true, force: true }); } catch {}
  const dataUrl = `data:image/png;base64,${Buffer.from('not really a png').toString('base64')}`;
  const res = await fromDataUrl({ dataUrl, name: 'p3-repro.png' });
  if (res.error) { fail('attachment-write-ok', res.error); return; }
  const dir = path.dirname(res.path);
  const dirOk = mode(dir) === 0o700;
  const fileOk = mode(res.path) === 0o600;
  if (dirOk && fileOk) pass('attachment-dir-and-file-private');
  else fail('attachment-dir-and-file-private', `dir=${mode(dir).toString(8)} file=${mode(res.path).toString(8)}`);
}

// browser.js and index.js's captureWindow both need a live Electron process to
// run their write path end to end, so their wiring is checked in source: both
// must route through the same ensurePrivateDir/0o600 the two runtime checks
// above just proved private.
function checkBrowserAndCaptureWindowWiring() {
  const browserSrc = fs.readFileSync(path.join(ROOT, 'src/main/browser.js'), 'utf8');
  const indexSrc = fs.readFileSync(path.join(ROOT, 'src/main/index.js'), 'utf8');

  if (/ensurePrivateDir\(this\.shotDir\)/.test(browserSrc)
    && /writeFileSync\(file, image\.toPNG\(\), \{ mode: 0o600 \}\)/.test(browserSrc)) {
    pass('browser-shotdir-wired-private');
  } else {
    fail('browser-shotdir-wired-private', 'browser.js does not call ensurePrivateDir + 0o600 writeFileSync');
  }

  if (/ensurePrivateDir\(dir\)/.test(indexSrc)
    && /writeFileSync\(file, img\.toPNG\(\), \{ mode: 0o600 \}\)/.test(indexSrc)) {
    pass('capturewindow-wired-private');
  } else {
    fail('capturewindow-wired-private', 'index.js captureWindow does not call ensurePrivateDir + 0o600 writeFileSync');
  }
}

(async () => {
  console.log('=== P3.1 screenshots and attachments must be private ===');
  checkEnsurePrivateDirFresh();
  checkEnsurePrivateDirFixesStaleDir();
  await checkAttachmentFileIsPrivate();
  checkBrowserAndCaptureWindowWiring();
  console.log(failures.length ? `\n${failures.length} FAIL(s)` : '\nALL PASS');
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
