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
const fs = require('fs');
const fsp = fs.promises;
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

/* The repositories a project folder holds. The folder's own, when it sits in
   one, and any others below it: a folder of several checked-out repos, with no
   git at its own root, is a common way to keep a project's pieces together,
   and a Changes view that only asked the root had nothing to say about it.

   The walk stops at a repository, since what is inside one is that
   repository's business, skips dependency and dot folders, and goes a few
   levels down at most. The answer is kept for a short while, because the pane
   asks every few seconds and the tree of repos changes about never. */
const SCAN_DEPTH = 3;
const SCAN_MAX_DIRS = 2000;
const SCAN_TTL_MS = 30000;
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'target', 'dist', 'build', 'out', '__pycache__']);
const scanned = new Map(); // root -> { at, repos }

// A .git folder, or the .git file a worktree or submodule has instead.
const hasDotGit = (dir) => fs.existsSync(path.join(dir, '.git'));

async function reposIn(root) {
  const hit = scanned.get(root);
  if (hit && Date.now() - hit.at < SCAN_TTL_MS) return hit.repos;

  // `cwd` is where git is asked from, `dir` is the repository relative to the
  // project folder: '' for the folder's own. The folder's own is asked from the
  // folder rather than its top, so a project that is one corner of a larger
  // repository only lists its own corner.
  const repos = gitDir(root) ? [{ cwd: root, dir: '' }] : [];
  let queue = [{ abs: root, depth: 0 }];
  let seen = 0;
  while (queue.length && seen < SCAN_MAX_DIRS) {
    const next = [];
    for (const { abs, depth } of queue) {
      let entries = [];
      try { entries = await fsp.readdir(abs, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
        if (++seen > SCAN_MAX_DIRS) break;
        const child = path.join(abs, e.name);
        if (hasDotGit(child)) repos.push({ cwd: child, dir: path.relative(root, child) });
        else if (depth + 1 < SCAN_DEPTH) next.push({ abs: child, depth: depth + 1 });
      }
    }
    queue = next;
  }

  scanned.set(root, { at: Date.now(), repos });
  return repos;
}

// The repository a project-relative path belongs to: the deepest one whose
// folder holds it.
function repoOf(repos, rel) {
  let best = null;
  for (const r of repos) {
    const inside = !r.dir || rel === r.dir || rel.startsWith(r.dir + path.sep);
    if (inside && (!best || r.dir.length > best.dir.length)) best = r;
  }
  return best;
}

// One repository's rows, with paths relative to the project folder.
async function statusOf(root, repo, nested) {
  const cwd = repo.cwd;
  const top = await git(['rev-parse', '--show-toplevel'], cwd);
  if (top.missing) return { missing: true };
  if (top.code !== 0) return { rows: [] };
  const topDir = top.stdout.trim();

  const [head, st] = await Promise.all([
    git(['rev-parse', '--verify', '--quiet', 'HEAD'], cwd),
    git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--', '.'], cwd),
  ]);
  if (st.code !== 0) return { error: st.stderr.trim().split('\n')[0] || 'git status failed', rows: [] };
  const born = head.code === 0;   // a repo with no commit yet has nothing to diff against

  const rows = [];
  for (const entry of st.stdout.split('\0')) {
    if (!entry) continue;
    const x = entry[0];
    const y = entry[1];
    const rel = relToProject(root, topDir, entry.slice(3));
    if (!rel) continue;
    // A repository inside this one shows up here as an untracked folder or a
    // changed submodule. Its own rows say what changed in it.
    if (nested.has(rel.replace(/[\\/]$/, ''))) continue;
    rows.push({ path: rel, repo: repo.dir, x, y, kind: label(x, y), staged: x !== ' ' && x !== '?', added: null, removed: null });
  }

  // One numstat covers everything git already tracks, staged or not.
  if (born && rows.length) {
    const byPath = new Map(rows.map((f) => [f.path, f]));
    const nums = await git(['diff', '--numstat', '-z', 'HEAD', '--', '.'], cwd);
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
  return { rows };
}

// The list behind the pane: one row per changed file across every repository
// in the folder, with the numbers the summary line needs. `repo: false` is not
// an error, it is a folder with no git in it, and the pane says so rather than
// showing an empty list.
async function status(root) {
  if (!root) return { repo: false, reason: 'nofolder', files: [] };
  const repos = await reposIn(root);
  if (!repos.length) return { repo: false, reason: 'norepo', files: [] };

  const nested = new Set(repos.map((r) => r.dir).filter(Boolean));
  const answers = await Promise.all(repos.map((r) => statusOf(root, r, nested)));
  if (answers.some((a) => a.missing)) return { repo: false, reason: 'nogit', files: [] };
  // One repository failing is its own trouble. The pane only gives up when
  // every one of them did.
  const failed = answers.filter((a) => a.error);
  if (failed.length === answers.length) return { repo: true, error: failed[0].error, files: [] };

  const rows = answers.flatMap((a) => a.rows);
  rows.sort((a, b) => a.path.localeCompare(b.path));

  const capped = rows.length > MAX_FILES ? rows.length - MAX_FILES : 0;
  const files = rows.slice(0, MAX_FILES);

  // Untracked files are not in numstat, so those are counted off the disk, up
  // to a point: a folder someone has just dropped in can hold thousands.
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

  return { repo: true, files, capped, repos: repos.map((r) => r.dir) };
}

// One file's patch, in the form git writes it. `context: 'full'` asks git for
// the whole file as context, which is how the pane shows a change in the place
// it happens rather than as three lines floating on their own. Untracked files
// have no patch to ask for, so one is written here that says the same thing:
// every line is new.
async function patch(root, rel, { context = 'full' } = {}) {
  if (!root || !rel) return { error: 'nothing to show' };
  const repo = repoOf(await reposIn(root), rel);
  if (!repo) return { error: 'that file is not in a git repository' };
  const cwd = repo.cwd;

  const top = await git(['rev-parse', '--show-toplevel'], cwd);
  if (top.missing) return { error: 'git is not on PATH' };
  if (top.code !== 0) return { error: 'that folder is not a git repository' };
  const topDir = top.stdout.trim();

  const abs = path.resolve(root, rel);
  if (path.relative(root, abs).startsWith('..')) return { error: 'that path is outside the project folder' };
  const gitPath = toGit(root, topDir, rel);

  const tracked = await git(['ls-files', '--error-unmatch', '--', gitPath], cwd);
  // Out of the index and still on disk is untracked. Out of the index and gone
  // from disk is a `git rm`, which git diffs like any other change.
  const onDisk = await fsp.stat(abs).then(() => true, () => false);
  if (tracked.code !== 0 && onDisk) {
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

  const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD'], cwd);
  // A context of a hundred thousand lines is git's own idiom for "the whole
  // file". There is no flag that says it.
  const args = ['diff', '--no-color', '--no-ext-diff', context === 'full' ? '-U100000' : '-U3'];
  if (head.code === 0) args.push('HEAD');
  args.push('--', gitPath);

  const res = await git(args, cwd);
  if (res.code !== 0) return { path: rel, error: res.stderr.trim().split('\n')[0] || 'git diff failed' };

  let text = res.stdout;
  if (/^Binary files /m.test(text)) return { path: rel, kind: 'edited', binary: true };
  const truncated = text.length > MAX_PATCH;
  if (truncated) text = text.slice(0, MAX_PATCH);
  return { path: rel, kind: 'edited', context, patch: text, truncated };
}

module.exports = { status, patch };
