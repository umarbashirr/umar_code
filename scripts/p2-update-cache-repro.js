#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { EventEmitter } = require('events');

const ROOT = process.env.TANDEM_ROOT || path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-p212-'));
os.homedir = () => tmp;

const shellEnv = require(path.join(ROOT, 'src/main/shell-env'));
shellEnv.cached = () => '';

const { DIR } = require(path.join(ROOT, 'src/main/projects'));
if (!DIR.startsWith(tmp)) {
  console.error(`refusing to run: cache dir ${DIR} is not under ${tmp}`);
  process.exit(2);
}

const { Updates } = require(path.join(ROOT, 'src/main/updates'));

const CACHE = path.join(DIR, 'update-check.json');
const GITHUB_LATEST = /api\.github\.com\/repos\/[^/]+\/[^/]+\/releases\/latest/;
const NPM_LATEST = /registry\.npmjs\.org\//;

const failures = [];
const pass = (name) => console.log(`PASS ${name}`);
const fail = (name, detail) => {
  console.log(`FAIL ${name}: ${detail}`);
  failures.push(name);
};

function seedCache() {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify({
    app: {
      current: '0.9.1',
      latest: '0.9.1',
      behind: false,
      name: '0.9.1',
      notes: 'yesterday',
      publishedAt: '2026-09-21T00:00:00Z',
      page: 'https://github.com/example/releases/tag/v0.9.1',
      asset: null,
    },
    claude: { path: '/bin/claude', version: '1.0.0', latest: '1.0.0' },
    codex: { path: null, version: null, latest: null },
    checkedAt: Date.now(),
    error: null,
  }, null, 2));
}

function jsonRes(statusCode, body) {
  return { statusCode, body, headers: {} };
}

function installHttps(handler) {
  const orig = https.get;
  const hits = [];
  https.get = (url, opts, cb) => {
    if (typeof opts === 'function') cb = opts;
    const href = String(url);
    hits.push(href);
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = (err) => { req.emit('error', err || new Error('destroyed')); };
    queueMicrotask(() => {
      let out;
      try { out = handler(href); } catch (e) {
        req.emit('error', e);
        return;
      }
      if (out.connectError) {
        req.emit('error', out.connectError);
        return;
      }
      const res = new EventEmitter();
      res.statusCode = out.statusCode;
      res.headers = out.headers || {};
      res.setEncoding = () => {};
      res.resume = () => {};
      cb(res);
      if (out.statusCode >= 300 && out.statusCode < 400) return;
      queueMicrotask(() => {
        if (out.body != null) {
          res.emit('data', typeof out.body === 'string' ? out.body : JSON.stringify(out.body));
        }
        res.emit('end');
      });
    });
    return req;
  };
  return {
    hits,
    restore() { https.get = orig; },
  };
}

async function refresh(updates) {
  const immediate = updates.current({ refresh: true });
  await Promise.resolve();
  if (updates.inflight) await updates.inflight;
  return { immediate, snap: updates.snapshot() };
}

const githubRelease = {
  tag_name: 'v0.9.9',
  name: '0.9.9',
  body: 'a newer release',
  published_at: '2026-09-22T00:00:00Z',
  html_url: 'https://github.com/example/releases/tag/v0.9.9',
  assets: [],
};

async function checkFreshGithub() {
  seedCache();
  const mock = installHttps((href) => {
    if (GITHUB_LATEST.test(href)) return jsonRes(200, githubRelease);
    if (NPM_LATEST.test(href)) return jsonRes(200, { version: '1.0.0' });
    return jsonRes(404, { message: `unexpected ${href}` });
  });
  try {
    const updates = new Updates();
    const { snap } = await refresh(updates);
    const githubHits = mock.hits.filter((h) => GITHUB_LATEST.test(h));
    if (githubHits.length < 1) {
      fail('refresh-hits-github', `hits=${JSON.stringify(mock.hits)} latest=${snap.app?.latest} behind=${snap.app?.behind}`);
    } else {
      pass('refresh-hits-github');
    }
    if (snap.app?.latest === '0.9.9' && snap.app?.behind === true) {
      pass('refresh-shows-behind');
    } else {
      fail('refresh-shows-behind', `latest=${snap.app?.latest} behind=${snap.app?.behind} error=${snap.error}`);
    }
  } finally {
    mock.restore();
  }
}

async function checkRateLimitSurfaces() {
  seedCache();
  const mock = installHttps((href) => {
    if (GITHUB_LATEST.test(href)) return jsonRes(403, { message: 'API rate limit exceeded' });
    if (NPM_LATEST.test(href)) return jsonRes(200, { version: '1.0.0' });
    return jsonRes(404, { message: `unexpected ${href}` });
  });
  try {
    const updates = new Updates();
    const { snap } = await refresh(updates);
    if (typeof snap.error === 'string' && /github/i.test(snap.error)) {
      pass('rate-limit-surfaces-error');
    } else {
      fail('rate-limit-surfaces-error', `error=${JSON.stringify(snap.error)} behind=${snap.app?.behind}`);
    }
    if (snap.error) pass('rate-limit-not-silent-current');
    else fail('rate-limit-not-silent-current', `behind=${snap.app?.behind} latest=${snap.app?.latest}`);
  } finally {
    mock.restore();
  }
}

async function checkOfflineSurfaces() {
  seedCache();
  const mock = installHttps((href) => {
    if (GITHUB_LATEST.test(href)) return { connectError: new Error('getaddrinfo ENOTFOUND api.github.com') };
    if (NPM_LATEST.test(href)) return jsonRes(200, { version: '1.0.0' });
    return jsonRes(404, { message: `unexpected ${href}` });
  });
  try {
    const updates = new Updates();
    const { snap } = await refresh(updates);
    if (typeof snap.error === 'string' && snap.error.length) {
      pass('offline-surfaces-error');
    } else {
      fail('offline-surfaces-error', `error=${JSON.stringify(snap.error)} latest=${snap.app?.latest}`);
    }
  } finally {
    mock.restore();
  }
}

(async () => {
  try {
    await checkFreshGithub();
    await checkRateLimitSurfaces();
    await checkOfflineSurfaces();
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
