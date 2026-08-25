'use strict';
// What has changed in the project folder and has not been committed yet, which
// is the thing you want to look at after an agent has been working: every edit
// it made is sitting in the working tree, mixed in with your own.
//
// This shells out to git rather than reading .git by hand. The branch pill next
// to the chat reads HEAD directly because it asks every few seconds and forking
// a process for one line is silly; a diff is asked for when someone opens the
// pane, and reimplementing index parsing and rename detection to save one fork
// would be a bad trade.
//
// Two calls answer the list: status for what changed, numstat for how much.
// The patch for one file is fetched when that file is clicked, because a repo
// mid-refactor can hold more diff than anyone wants sent over IPC at once.
const { execFile } = require('child_process');
const fsp = require('fs').promises;
const path = require('path');

const { gitDir } = require('./git');

const MAX_PATCH = 1024 * 1024;  // per file, before the renderer gets it
const MAX_FILES = 500;          // rows in the list
const MAX_COUNTED = 300;        // untracked files whose lines are worth counting
const MAX_NEW_BYTES = 1024 * 1024;
const TIMEOUT_MS = 15000;

// GIT_OPTIONAL_LOCKS=0 keeps a status from taking the index lock. The pane
// re-reads on a timer, and a background status that blocks the commit someone
// is typing in the terminal would be its own kind of bug.
function git(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd,
      timeout: TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '0' },
    }, (err, stdout, stderr) => resolve({
      code: err ? (err.code ?? 1) : 0,
      missing: err?.code === 'ENOENT',
      stdout: stdout || '',
      stderr: stderr || '',
    }));
  });
}

// Porcelain v1 says what happened in two columns: the index, then the working
// tree. One row per file is enough for reading, so they collapse into a single
// word and the pair is kept for the letter in the margin.
function label(x, y) {
  if (x === '?' ) return 'new';
  if (x === 'A' || y === 'A') return 'added';
  if (x === 'D' || y === 'D') return 'deleted';
  if (x === 'R') return 'renamed';
  if (x === 'C') return 'copied';
  if (x === 'U' || y === 'U') return 'conflict';
  return 'edited';
}

const relToProject = (root, top, p) => {
  const rel = path.relative(root, path.join(top, p));
  return rel.startsWith('..') || path.isAbsolute(rel) ? null : rel;
};

// git talks in paths relative to the repository root; the rest of the app talks
// in paths relative to the project folder, which may sit below it.
const toGit = (root, top, rel) => path.relative(top, path.join(root, rel));

async function countLines(abs) {
  try {
    const st = await fsp.stat(abs);
    if (!st.isFile() || st.size > MAX_NEW_BYTES) return null;
    const buf = await fsp.readFile(abs);
    if (buf.subarray(0, 8192).includes(0)) return null;   // binary
    if (!buf.length) return 0;
    let n = 0;
    for (const b of buf) if (b === 10) n++;
    return buf[buf.length - 1] === 10 ? n : n + 1;
  } catch {
    return null;
  }
}

// The list behind the pane: one row per changed file, with the numbers the
// summary line needs. `repo: false` is not an error, it is a folder that is not
// under git, and the pane says so rather than showing an empty list.
async function status(root) {
  if (!root) return { repo: false, reason: 'nofolder', files: [] };
  if (!gitDir(root)) return { repo: false, reason: 'norepo', files: [] };

  const top = await git(['rev-parse', '--show-toplevel'], root);
  if (top.missing) return { repo: false, reason: 'nogit', files: [] };
  if (top.code !== 0) return { repo: false, reason: 'norepo', files: [] };
  const topDir = top.stdout.trim();

  const [head, st] = await Promise.all([
    git(['rev-parse', '--verify', '--quiet', 'HEAD'], root),
    git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--', '.'], root),
  ]);
  if (st.code !== 0) {
    return { repo: true, error: st.stderr.trim().split('\n')[0] || 'git status failed', files: [] };
  }
  const born = head.code === 0;   // a repo with no commit yet has nothing to diff against

  const rows = [];
  for (const entry of st.stdout.split('\0')) {
    if (!entry) continue;
    const x = entry[0];
    const y = entry[1];
    const rel = relToProject(root, topDir, entry.slice(3));
    if (!rel) continue;
    rows.push({ path: rel, x, y, kind: label(x, y), staged: x !== ' ' && x !== '?', added: null, removed: null });
  }
  rows.sort((a, b) => a.path.localeCompare(b.path));

  const capped = rows.length > MAX_FILES ? rows.length - MAX_FILES : 0;
  const files = rows.slice(0, MAX_FILES);
  const byPath = new Map(files.map((f) => [f.path, f]));

  // One numstat covers everything git already tracks, staged or not. Untracked
  // files are not in it, so those are counted off the disk, up to a point: a
  // folder someone has just dropped in can hold thousands.
  if (born) {
    const nums = await git(['diff', '--numstat', '-z', 'HEAD', '--', '.'], root);
    if (nums.code === 0) {
      const parts = nums.stdout.split('\0');
      for (let i = 0; i < parts.length; i++) {
        const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(parts[i]);
        if (!m) continue;
        // A -z numstat with no path on the line means the path is the next
        // field, which is how git writes a rename.
        let p = m[3];
        if (!p) { p = parts[i + 2] || ''; i += 2; }
        const rel = relToProject(root, topDir, p);
        const row = rel && byPath.get(rel);
        if (!row) continue;
        row.added = m[1] === '-' ? null : Number(m[1]);
        row.removed = m[2] === '-' ? null : Number(m[2]);
        row.binary = m[1] === '-';
      }
    }
  }

  let counted = 0;
  for (const f of files) {
    if (f.added !== null || f.removed !== null) continue;
    if (f.kind === 'deleted') { f.added = 0; continue; }
    if (counted++ >= MAX_COUNTED) break;
    const n = await countLines(path.join(root, f.path));
    if (n === null) { f.binary = true; continue; }
    f.added = n;
    f.removed = 0;
  }

  return { repo: true, born, files, capped, top: topDir };
}

// One file's patch, in the form git writes it. `context: 'full'` asks git for
// the whole file as context, which is how the pane shows a change in the place
// it happens rather than as three lines floating on their own. Untracked files
// have no patch to ask for, so one is written here that says the same thing:
// every line is new.
async function patch(root, rel, { context = 'full' } = {}) {
  if (!root || !rel) return { error: 'nothing to show' };
  if (!gitDir(root)) return { error: 'that folder is not a git repository' };

  const top = await git(['rev-parse', '--show-toplevel'], root);
  if (top.missing) return { error: 'git is not on PATH' };
  if (top.code !== 0) return { error: 'that folder is not a git repository' };
  const topDir = top.stdout.trim();

  const abs = path.resolve(root, rel);
  if (path.relative(root, abs).startsWith('..')) return { error: 'that path is outside the project folder' };
  const gitPath = toGit(root, topDir, rel);

  const tracked = await git(['ls-files', '--error-unmatch', '--', gitPath], root);
  if (tracked.code !== 0) {
    // Untracked: the whole file is the diff.
    let buf;
    try {
      const st = await fsp.stat(abs);
      if (st.size > MAX_NEW_BYTES) return { path: rel, kind: 'new', toobig: true, size: st.size };
      buf = await fsp.readFile(abs);
    } catch (e) {
      return { path: rel, error: e.code === 'ENOENT' ? 'that file is gone' : e.message };
    }
    if (buf.subarray(0, 8192).includes(0)) return { path: rel, kind: 'new', binary: true };
    const text = buf.toString('utf8');
    const rows = text.length ? text.split('\n') : [];
    if (rows.length > 1 && rows[rows.length - 1] === '') rows.pop();
    const body = rows.map((l) => `+${l}`).join('\n');
    return { path: rel, kind: 'new', context: 'full', patch: `@@ -0,0 +1,${rows.length} @@\n${body}` };
  }

  const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD'], root);
  // A context of a hundred thousand lines is git's own idiom for "the whole
  // file". There is no flag that says it.
  const args = ['diff', '--no-color', '--no-ext-diff', context === 'full' ? '-U100000' : '-U3'];
  if (head.code === 0) args.push('HEAD');
  args.push('--', gitPath);

  const res = await git(args, root);
  if (res.code !== 0) return { path: rel, error: res.stderr.trim().split('\n')[0] || 'git diff failed' };

  let text = res.stdout;
  if (/^Binary files /m.test(text)) return { path: rel, kind: 'edited', binary: true };
  const truncated = text.length > MAX_PATCH;
  if (truncated) text = text.slice(0, MAX_PATCH);
  return { path: rel, kind: 'edited', context, patch: text, truncated };
}

module.exports = { status, patch };
