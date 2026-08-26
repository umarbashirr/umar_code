'use strict';
// The project folders, read on demand for the Files pane. A window holds
// several projects open at once, so every call names the root it is working on
// and nothing is remembered that is not keyed by that root. Nothing is cached
// except the filename index the search box uses, and every path that comes in
// from the renderer is resolved against its own project root first, so a "../.."
// cannot walk out of the folder. A symlink you put in the project yourself is
// followed when you click it, which is the point of putting it there; the
// search index does not follow one, so a link to a home directory cannot quietly
// pull the whole machine into a listing labelled with the project's name.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const MAX_TEXT = 512 * 1024;       // above this a file is offered, not shown
const MAX_IMAGE = 8 * 1024 * 1024; // a data: URL of a 20MB png helps nobody
const MAX_ENTRIES = 3000;          // per directory
const WALK_CAP = 30000;            // filenames held for the search box
const INDEX_TTL = 15000;
// Indexes are held per project root and each one runs to WALK_CAP names, so
// keeping every folder a person has ever opened would be paying real memory for
// a search box nobody is typing in. Four covers the projects you move between in
// a sitting. The one that falls off the end costs a single walk to come back,
// which is what opening it cost in the first place.
const MAX_INDEXES = 4;

const IMAGE_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
};

// Walked for the search box, not hidden from the tree: expanding node_modules
// by hand is your business, indexing 40000 of its files to answer a keystroke
// is not.
const UNWALKED = new Set([
  '.git', 'node_modules', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache',
  'dist', 'build', 'out', 'target', 'vendor', 'coverage', '__pycache__',
  '.venv', 'venv', '.gradle', '.idea', 'Pods', 'DerivedData',
]);

const LANGS = {
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'jsx',
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'tsx',
  '.json': 'json', '.jsonc': 'jsonc', '.json5': 'json5',
  '.css': 'css', '.scss': 'scss', '.sass': 'sass', '.less': 'less',
  '.html': 'html', '.htm': 'html', '.vue': 'vue', '.svelte': 'svelte', '.astro': 'astro',
  '.md': 'markdown', '.mdx': 'mdx', '.markdown': 'markdown',
  '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust', '.java': 'java',
  '.kt': 'kotlin', '.swift': 'swift', '.c': 'c', '.h': 'c', '.cc': 'cpp',
  '.cpp': 'cpp', '.hpp': 'cpp', '.cs': 'csharp', '.php': 'php', '.pl': 'perl',
  '.lua': 'lua', '.r': 'r', '.dart': 'dart', '.ex': 'elixir', '.exs': 'elixir',
  '.erl': 'erlang', '.hs': 'haskell', '.clj': 'clojure', '.scala': 'scala',
  '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash', '.fish': 'fish', '.ps1': 'powershell',
  '.sql': 'sql', '.graphql': 'graphql', '.gql': 'graphql', '.proto': 'proto',
  '.yml': 'yaml', '.yaml': 'yaml', '.toml': 'toml', '.ini': 'ini', '.env': 'dotenv',
  '.xml': 'xml', '.svg': 'xml', '.tf': 'terraform', '.hcl': 'hcl',
  '.dockerfile': 'docker', '.diff': 'diff', '.patch': 'diff',
};

const BY_NAME = {
  dockerfile: 'docker', makefile: 'make', gemfile: 'ruby', rakefile: 'ruby',
  'cmakelists.txt': 'cmake', procfile: 'bash', brewfile: 'ruby',
  '.gitignore': 'ini', '.dockerignore': 'ini', '.npmignore': 'ini',
  '.env': 'dotenv', '.editorconfig': 'ini', '.bashrc': 'bash', '.zshrc': 'bash',
};

function langOf(name) {
  const lower = name.toLowerCase();
  if (BY_NAME[lower]) return BY_NAME[lower];
  const ext = path.extname(lower);
  if (ext === '.env' || lower.startsWith('.env.')) return 'dotenv';
  return LANGS[ext] || 'text';
}

// Every path from the renderer lands here first. Returns null when the result
// would sit outside the project folder.
function within(root, rel) {
  if (typeof rel !== 'string') return null;
  const base = path.resolve(root);
  const abs = path.resolve(base, rel || '.');
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

const relOf = (root, abs) => {
  const r = path.relative(path.resolve(root), abs);
  return r === '' ? '' : r;
};

// Directories first, then names the way a person reads them: case folded, with
// runs of digits compared as numbers so item10 lands after item9.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const order = (a, b) => (a.dir === b.dir ? collator.compare(a.name, b.name) : a.dir ? -1 : 1);

async function list(root, rel = '') {
  const dir = within(root, rel);
  if (!dir) return { rel, entries: [], error: 'that path is outside the project folder' };

  let raw;
  try {
    raw = await fsp.readdir(dir, { withFileTypes: true });
  } catch (e) {
    const msg = e.code === 'ENOENT' ? 'that folder is gone'
      : e.code === 'EACCES' ? 'no permission to read that folder'
        : e.message;
    return { rel, entries: [], error: msg };
  }

  const truncated = raw.length > MAX_ENTRIES;
  const slice = truncated ? raw.slice(0, MAX_ENTRIES) : raw;

  const entries = await Promise.all(slice.map(async (d) => {
    const abs = path.join(dir, d.name);
    let isDir = d.isDirectory();
    const link = d.isSymbolicLink();
    let size = 0;
    let mtime = 0;
    try {
      // A symlink is described by what it points at, which is what you get if
      // you click it. Broken ones fall back to being a plain file row.
      const st = link ? await fsp.stat(abs) : await fsp.lstat(abs);
      isDir = st.isDirectory();
      size = st.size;
      mtime = st.mtimeMs;
    } catch { if (link) isDir = false; }

    return {
      name: d.name,
      path: relOf(root, abs),
      dir: isDir,
      link,
      hidden: d.name.startsWith('.'),
      size: isDir ? 0 : size,
      mtime,
    };
  }));

  entries.sort(order);
  return { rel, entries, truncated, error: null };
}

async function read(root, rel) {
  const abs = within(root, rel);
  if (!abs) return { error: 'that path is outside the project folder' };

  let st;
  try {
    st = await fsp.stat(abs);
  } catch (e) {
    return { error: e.code === 'ENOENT' ? 'that file is gone' : e.message };
  }
  if (st.isDirectory()) return { error: 'that is a folder' };

  const name = path.basename(abs);
  const meta = { path: rel, name, size: st.size, mtime: st.mtimeMs };
  const ext = path.extname(name).toLowerCase();
  const image = IMAGE_TYPES[ext];

  // An SVG is both a picture and a file you edit, so it gets shown as text and
  // the viewer offers the rendered version alongside.
  if (image && ext !== '.svg') {
    if (st.size > MAX_IMAGE) return { ...meta, kind: 'toobig' };
    try {
      const buf = await fsp.readFile(abs);
      return { ...meta, kind: 'image', dataUrl: `data:${image};base64,${buf.toString('base64')}` };
    } catch (e) {
      return { ...meta, error: e.code === 'EACCES' ? 'no permission to read that file' : e.message };
    }
  }

  if (st.size > MAX_TEXT) return { ...meta, kind: 'toobig' };

  let buf;
  try {
    buf = await fsp.readFile(abs);
  } catch (e) {
    return { ...meta, error: e.code === 'EACCES' ? 'no permission to read that file' : e.message };
  }

  // A NUL byte in the first few kilobytes is the cheap test every editor uses,
  // and it is right often enough that the alternative is not worth the code.
  const head = buf.subarray(0, 8192);
  if (head.includes(0)) return { ...meta, kind: 'binary' };

  const text = buf.toString('utf8');
  return {
    ...meta,
    kind: 'text',
    lang: langOf(name),
    text,
    lines: text.length ? text.split('\n').length : 0,
    svg: ext === '.svg' ? `data:image/svg+xml;base64,${buf.toString('base64')}` : null,
  };
}

// ------------------------------------------------------------- search index

// One flat list of filenames per project root, rebuilt when it goes stale or
// when a watched folder changes underneath it. Directories in UNWALKED are
// skipped: they are still browsable by hand, they are just not worth 40000
// index entries.
//
// The Map is also the eviction order. A root that gets used is deleted and put
// back, so the key at the front is always the one nobody has searched in the
// longest and it is the one to throw away.
const indexes = new Map(); // root key -> { at, files, capped, building }

// Roots reach us from a folder picker, a recents list and the command line, and
// "/p" and "/p/" are the same project to everyone except a Map. Everything that
// keys on a root goes through here first.
const keyOf = (root) => path.resolve(String(root == null ? '.' : root));

function touch(key) {
  const entry = indexes.get(key);
  if (!entry) return null;
  indexes.delete(key);
  indexes.set(key, entry);
  return entry;
}

// A write in one project says nothing about the state of another, so a root
// drops on its own. With no argument every root drops, for a window closing or
// a person reloading the whole thing.
function invalidate(root) {
  if (root == null) indexes.clear();
  else indexes.delete(keyOf(root));
}

async function buildIndex(root) {
  const files = [];
  const seen = new Set();
  const queue = [''];
  let capped = false;

  while (queue.length && !capped) {
    const rel = queue.shift();
    const dir = within(root, rel);
    if (!dir) continue;

    // Symlinked folders can point back up the tree. Following one twice is how
    // a walk turns into a hang.
    let real;
    try { real = await fsp.realpath(dir); } catch { continue; }
    if (seen.has(real)) continue;
    seen.add(real);

    let raw;
    try { raw = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }

    for (const d of raw) {
      const child = rel ? `${rel}/${d.name}` : d.name;
      // A symlinked folder is followed when you click it, because you made it
      // and clicking it should work. It is not followed here: one link pointing
      // at a home directory would put every file on the machine in a listing
      // that says it is searching the project.
      if (d.isSymbolicLink()) continue;
      if (d.isDirectory()) {
        if (!UNWALKED.has(d.name)) queue.push(child);
        continue;
      }
      files.push(child);
      if (files.length >= WALK_CAP) { capped = true; break; }
    }
  }

  return { files, capped };
}

// A walk writes into the entry object rather than back into the Map. If the root
// is invalidated or evicted while its walk is in flight, the walk lands on an
// object nobody can reach any more instead of quietly restoring the listing that
// was already known to be out of date.
function ensureIndex(root) {
  const key = keyOf(root);
  const live = touch(key);
  if (live) {
    if (live.building) return live.building;
    if (Date.now() - live.at < INDEX_TTL) return Promise.resolve(live);
  }

  const entry = live || { at: 0, files: [], capped: false, building: null };
  if (!live) {
    indexes.set(key, entry);
    while (indexes.size > MAX_INDEXES) indexes.delete(indexes.keys().next().value);
  }

  entry.building = buildIndex(root).then((built) => {
    entry.files = built.files;
    entry.capped = built.capped;
    entry.at = Date.now();
    return entry;
  }).finally(() => { entry.building = null; });
  return entry.building;
}

// Substring on the basename beats substring anywhere in the path, and a shorter
// path wins ties. No fuzzy matching: typing "app" and getting `a/p/p.js` back
// is clever and useless.
async function search(root, query, limit = 200) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return { matches: [], capped: false };

  const entry = await ensureIndex(root);
  const hits = [];
  for (const rel of entry.files) {
    const lower = rel.toLowerCase();
    const at = lower.indexOf(q);
    if (at === -1) continue;
    const slash = lower.lastIndexOf('/');
    hits.push({ path: rel, rank: at > slash ? 0 : 1, len: rel.length });
  }

  hits.sort((a, b) => a.rank - b.rank || a.len - b.len || collator.compare(a.path, b.path));
  return {
    matches: hits.slice(0, limit).map((h) => ({ path: h.path, name: path.basename(h.path) })),
    total: hits.length,
    capped: entry.capped,
  };
}

// ---------------------------------------------------------------- watching

// One inotify watch per folder the tree has expanded, reconciled whenever the
// renderer expands or collapses something. Recursive watching is a Windows and
// macOS luxury, and watching a whole checkout would be wrong anyway: the tree
// only redraws the folders you can actually see.
//
// One Watcher serves the whole window. Its watches are grouped by project root
// so that closing one project takes down its own and leaves the other projects
// watching what they were watching.
class Watcher {
  // onChange is called with the folder that changed and the root it belongs to,
  // because the same rel path exists in two projects and the renderer has to
  // know which tree to redraw.
  constructor(onChange) {
    this.onChange = onChange;
    this.roots = new Map(); // root key -> { handles: Map(rel -> FSWatcher), timers: Map(rel -> Timeout) }
  }

  forRoot(root) {
    const key = keyOf(root);
    let entry = this.roots.get(key);
    if (!entry) { entry = { handles: new Map(), timers: new Map() }; this.roots.set(key, entry); }
    return entry;
  }

  // Editors write a file by renaming a temp file over it, which fires two or
  // three events. One redraw per folder per burst is enough.
  ping(root, rel) {
    const entry = this.roots.get(keyOf(root));
    if (!entry) return;
    clearTimeout(entry.timers.get(rel));
    entry.timers.set(rel, setTimeout(() => {
      entry.timers.delete(rel);
      invalidate(root);
      this.onChange(rel, root);
    }, 120));
  }

  // Replaces the watches for this root only. The other projects in the window
  // are mid-session too and their expanded folders are none of this call's
  // business.
  sync(root, dirs) {
    const { handles } = this.forRoot(root);
    // The renderer sends its expanded folders in the order they were opened, so
    // the newest are the ones worth keeping when there are more than the cap.
    // The cap is per project, since each project is a tree someone is browsing.
    const want = new Set(Array.isArray(dirs) ? dirs.slice(-64) : []);

    for (const [rel, h] of handles) {
      if (want.has(rel)) continue;
      try { h.close(); } catch {}
      handles.delete(rel);
    }

    for (const rel of want) {
      if (handles.has(rel)) continue;
      const abs = within(root, rel);
      if (!abs) continue;
      try {
        const h = fs.watch(abs, { persistent: false }, () => this.ping(root, rel));
        // A deleted folder takes its watch down with an EPERM on some systems.
        h.on('error', () => { try { h.close(); } catch {} handles.delete(rel); });
        handles.set(rel, h);
      } catch { /* unreadable or gone: the next refresh will say so */ }
    }
    return handles.size;
  }

  // Closing a project. Its index goes with the watches, since holding an index
  // for a folder the window is no longer showing is the thing MAX_INDEXES is
  // there to avoid.
  drop(root) {
    const key = keyOf(root);
    const entry = this.roots.get(key);
    if (!entry) return;
    for (const h of entry.handles.values()) { try { h.close(); } catch {} }
    for (const t of entry.timers.values()) clearTimeout(t);
    this.roots.delete(key);
    invalidate(key);
  }

  clear() {
    for (const root of [...this.roots.keys()]) this.drop(root);
  }
}

module.exports = { list, read, search, within, langOf, invalidate, Watcher, MAX_TEXT };
