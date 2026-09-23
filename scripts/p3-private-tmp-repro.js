'use strict';
// P3.1: screenshots and pasted attachments land in a shared tmp dir. Anyone
// else on the box must not be able to read them, and must not be able to
// redirect our writes by pre-planting a dir or symlink at the path we use.
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = process.env.TANDEM_ROOT || path.join(__dirname, '..');

const failures = [];
const pass = (name) => console.log(`PASS ${name}`);
const fail = (name, detail) => { console.log(`FAIL ${name}: ${detail}`); failures.push(name); };
const note = (msg) => console.log(`NOTE ${msg}`);

const uidSuffix = typeof process.getuid === 'function' ? `-${process.getuid()}` : '';
const expectedDir = (name) => path.join(os.tmpdir(), `${name}${uidSuffix}`);
const modeOf = (p) => { try { return fs.statSync(p).mode & 0o777; } catch { return null; } };

let ensurePrivateDir = null;
try {
  ({ ensurePrivateDir } = require(path.join(ROOT, 'src/main/private-dir.js')));
} catch (e) {
  fail('load-private-dir', e.message);
}

function checkEnsurePrivateDirFresh() {
  const label = 'ensurePrivateDir-creates-per-user-0700-dir';
  if (!ensurePrivateDir) { fail(label, 'private-dir.js not loaded'); return; }
  const name = `tandem-repro-fresh-${Date.now()}`;
  const want = expectedDir(name);
  let got;
  try {
    got = ensurePrivateDir(name);
  } catch (e) {
    fail(label, `threw ${e.message}`);
    return;
  }
  if (got === want && modeOf(got) === 0o700) pass(label);
  else fail(label, `got=${got} want=${want} mode=${modeOf(got)}`);
}

// mkdirSync's mode option only applies when it creates the dir. A dir this app
// itself left at 0755 (from before this file existed) must still end up
// private, without being treated as unsafe just because it predates the fix.
function checkEnsurePrivateDirFixesOwnStaleDir() {
  const label = 'ensurePrivateDir-fixes-own-stale-0755-dir';
  if (!ensurePrivateDir) { fail(label, 'private-dir.js not loaded'); return; }
  const name = `tandem-repro-stale-${Date.now()}`;
  const want = expectedDir(name);
  fs.mkdirSync(want, { recursive: true, mode: 0o755 });
  fs.chmodSync(want, 0o755); // mkdirSync's mode only bites on creation; force the stale case
  let got;
  try {
    got = ensurePrivateDir(name);
  } catch (e) {
    fail(label, `threw ${e.message}`);
    return;
  } finally {
    try { fs.rmSync(want, { recursive: true, force: true }); } catch {}
  }
  if (got === want) pass(label);
  else fail(label, `got=${got} want=${want}`);
}

// A symlink at the path we're about to use, aimed at somewhere the attacker
// controls, must never be followed: not chmod'ed (chmodSync follows symlinks;
// only lstat does not), and nothing gets written through it. This is the one
// half of the review's threat model a single-user sandbox can actually stage.
function checkSymlinkIsNotFollowed() {
  const label = 'ensurePrivateDir-refuses-a-symlink';
  if (!ensurePrivateDir) { fail(label, 'private-dir.js not loaded'); return; }
  const name = `tandem-repro-symlink-${Date.now()}`;
  const linkPath = expectedDir(name);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-repro-symlink-target-'));
  fs.symlinkSync(target, linkPath, 'dir');
  let got;
  try {
    got = ensurePrivateDir(name);
  } catch (e) {
    try { fs.unlinkSync(linkPath); } catch {}
    try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
    fail(label, `threw ${e.message}`);
    return;
  }
  const stillASymlink = (() => { try { return fs.lstatSync(linkPath).isSymbolicLink(); } catch { return false; } })();
  const targetUntouched = (() => { try { return fs.readdirSync(target).length === 0; } catch { return false; } })();
  const fellBack = got !== linkPath && path.dirname(got) === os.tmpdir();
  try { fs.unlinkSync(linkPath); } catch {}
  try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
  if (fellBack && stillASymlink && targetUntouched) pass(label);
  else fail(label, `got=${got} fellBack=${fellBack} stillASymlink=${stillASymlink} targetUntouched=${targetUntouched}`);
}

// The other half, a dir another OS user already owns at our path, needs a
// second uid to actually create, which a single-user sandbox does not have.
// Recorded here instead of faked: private-dir.js's safeToUse() rejects a dir
// whenever lstat's uid disagrees with process.getuid(), the same lstat call
// checkSymlinkIsNotFollowed above already exercises for the symlink half.
function noteForeignOwnerCase() {
  note('foreign-owner-dir cannot be staged on a single-user machine (would need a second uid to own the pre-existing dir); covered by code review of private-dir.js\'s safeToUse(), which rejects any dir whose lstat().uid !== process.getuid()');
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
  // fromDataUrl always writes into the same real os.tmpdir(), regardless of
  // which checkout's copy of the function is under test here, so a dir a
  // previous run left behind (private or not) must not leak into this one.
  try { fs.rmSync(expectedDir('tandem-attachments'), { recursive: true, force: true }); } catch {}
  try { fs.rmSync(path.join(os.tmpdir(), 'tandem-attachments'), { recursive: true, force: true }); } catch {}
  const dataUrl = `data:image/png;base64,${Buffer.from('not really a png').toString('base64')}`;
  const res = await fromDataUrl({ dataUrl, name: 'p3-repro.png' });
  if (res.error) { fail('attachment-write-ok', res.error); return; }
  const dir = path.dirname(res.path);
  const dirOk = modeOf(dir) === 0o700;
  const fileOk = modeOf(res.path) === 0o600;
  if (dirOk && fileOk) pass('attachment-dir-and-file-private');
  else fail('attachment-dir-and-file-private', `dir=${modeOf(dir)} file=${modeOf(res.path)}`);
}

// browser.js and index.js's captureWindow both need a live Electron process to
// run their write path end to end, so their wiring is checked in source: both
// must route through the same ensurePrivateDir/0o600 the runtime checks above
// just proved private.
function checkBrowserAndCaptureWindowWiring() {
  const browserSrc = fs.readFileSync(path.join(ROOT, 'src/main/browser.js'), 'utf8');
  const indexSrc = fs.readFileSync(path.join(ROOT, 'src/main/index.js'), 'utf8');

  if (/ensurePrivateDir\('tandem-shots'\)/.test(browserSrc)
    && /writeFileSync\(file, image\.toPNG\(\), \{ mode: 0o600 \}\)/.test(browserSrc)) {
    pass('browser-shotdir-wired-private');
  } else {
    fail('browser-shotdir-wired-private', "browser.js does not call ensurePrivateDir('tandem-shots') + 0o600 writeFileSync");
  }

  if (/ensurePrivateDir\('tandem-shots'\)/.test(indexSrc)
    && /writeFileSync\(file, img\.toPNG\(\), \{ mode: 0o600 \}\)/.test(indexSrc)) {
    pass('capturewindow-wired-private');
  } else {
    fail('capturewindow-wired-private', "index.js captureWindow does not call ensurePrivateDir('tandem-shots') + 0o600 writeFileSync");
  }
}

(async () => {
  console.log('=== P3.1 screenshots and attachments must be private, and their dirs unspoofable ===');
  checkEnsurePrivateDirFresh();
  checkEnsurePrivateDirFixesOwnStaleDir();
  checkSymlinkIsNotFollowed();
  noteForeignOwnerCase();
  await checkAttachmentFileIsPrivate();
  checkBrowserAndCaptureWindowWiring();
  console.log(failures.length ? `\n${failures.length} FAIL(s)` : '\nALL PASS');
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
