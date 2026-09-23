#!/usr/bin/env node
'use strict';
// P2: update notices. Proves two things in src/main/updates.js without a
// network or a window:
//   - the snapshot describes the process that is running, not the one that
//     wrote update-check.json. After an update, the cache still carries the
//     old `current` and `behind: true` until a new check lands.
//   - whatsNew(seen) returns the running version's release notes exactly
//     once after a version bump, and nothing on a fresh install or when the
//     running version's notes were already seen.
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { EventEmitter } = require('events');

const ROOT = process.env.TANDEM_ROOT || path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-notices-'));
os.homedir = () => tmp;

const { DIR } = require(path.join(ROOT, 'src/main/projects'));
if (!DIR.startsWith(tmp)) {
  console.error(`refusing to run: cache dir ${DIR} is not under ${tmp}`);
  process.exit(2);
}

const { Updates, currentVersion } = require(path.join(ROOT, 'src/main/updates'));
const CACHE = path.join(DIR, 'update-check.json');
const RUNNING = currentVersion();
const OLDER = '0.0.1';

const failures = [];
const pass = (name) => console.log(`PASS ${name}`);
const fail = (name, detail) => {
  console.log(`FAIL ${name}: ${detail}`);
  failures.push(name);
};
const expect = (name, ok, detail) => (ok ? pass(name) : fail(name, detail));

const release = (version, body) => ({
  tag_name: `v${version}`,
  name: `v${version}`,
  body,
  published_at: '2026-09-23T00:00:00Z',
  html_url: `https://github.com/example/releases/tag/v${version}`,
  assets: [],
});

// Every GitHub request is answered from `byTag`, keyed by the URL's tail.
const hits = [];
https.get = (url, opts, cb) => {
  const href = String(url);
  hits.push(href);
  const req = new EventEmitter();
  req.setTimeout = () => req;
  req.destroy = (err) => req.emit('error', err || new Error('destroyed'));
  queueMicrotask(() => {
    const m = href.match(/releases\/tags\/v(.+)$/);
    const body = m ? release(m[1], `notes for ${m[1]}`) : null;
    const res = new EventEmitter();
    res.statusCode = body ? 200 : 404;
    res.headers = {};
    res.setEncoding = () => {};
    res.resume = () => {};
    cb(res);
    queueMicrotask(() => { res.emit('data', JSON.stringify(body || {})); res.emit('end'); });
  });
  return req;
};

function seed(app) {
  fs.mkdirSync(DIR, { recursive: true });
  if (app) fs.writeFileSync(CACHE, JSON.stringify({ app, checkedAt: Date.now(), error: null }));
  else fs.rmSync(CACHE, { force: true });
}

(async () => {
  try {
    // Written by the previous version's last check, when RUNNING was news.
    seed({ current: OLDER, latest: RUNNING, behind: true, name: `v${RUNNING}`, notes: 'cached notes', page: 'p', asset: null });
    let u = new Updates();
    const app = u.snapshot().app;
    expect('snapshot-current-is-running', app.current === RUNNING, `current=${app.current}, running ${RUNNING}`);
    expect('snapshot-not-behind-after-update', app.behind === false, `behind=${app.behind}`);

    const first = await u.whatsNew('').catch((e) => ({ threw: e.message }));
    expect('whats-new-after-bump', first?.version === RUNNING && first?.notes === 'cached notes',
      `got ${JSON.stringify(first)}`);

    const again = await u.whatsNew(RUNNING).catch((e) => ({ threw: e.message }));
    expect('whats-new-once', again === null, `got ${JSON.stringify(again)}`);

    // The cached latest is some other release, so the notes come from the tag.
    seed({ current: OLDER, latest: '999.0.0', behind: true, notes: 'not these', page: 'p', asset: null });
    u = new Updates();
    hits.length = 0;
    const byTag = await u.whatsNew(OLDER).catch((e) => ({ threw: e.message }));
    expect('whats-new-fetches-running-tag', byTag?.notes === `notes for ${RUNNING}`
      && hits.some((h) => h.endsWith(`/releases/tags/v${RUNNING}`)), `got ${JSON.stringify(byTag)} hits=${hits}`);

    seed(null);
    u = new Updates();
    const fresh = await u.whatsNew('').catch((e) => ({ threw: e.message }));
    expect('no-whats-new-on-fresh-install', fresh === null, `got ${JSON.stringify(fresh)}`);
  } catch (e) {
    fail('probe-threw', e.stack || e.message);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  if (failures.length) {
    console.error(`\n${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log('\nall passed');
})();
