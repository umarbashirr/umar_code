'use strict';
// The project folder, read on demand for the Files pane. Nothing is cached
// except the filename index the search box uses, and every path that comes in
// from the renderer is resolved against the project root first, so a "../.."
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

// One flat list of filenames, rebuilt when it goes stale or when a watched
// folder changes underneath it. Directories in UNWALKED are skipped: they are
// still browsable by hand, they are just not worth 40000 index entries.
const index = { root: null, at: 0, files: [], capped: false, building: null, buildingRoot: null };

function invalidate() { index.at = 0; }

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

  index.root = root;
  index.files = files;
  index.capped = capped;
  index.at = Date.now();
  return files;
}

async function ensureIndex(root) {
  if (index.root === root && Date.now() - index.at < INDEX_TTL) return index.files;
  // A walk started before the window changed folders is answering about the
  // wrong tree, so it is left to finish and a new one is started.
  if (!index.building || index.buildingRoot !== root) {
    index.buildingRoot = root;
    index.building = buildIndex(root).finally(() => {
      if (index.buildingRoot === root) { index.building = null; index.buildingRoot = null; }
    });
  }
  return index.building;
}

// Substring on the basename beats substring anywhere in the path, and a shorter
// path wins ties. No fuzzy matching: typing "app" and getting `a/p/p.js` back
// is clever and useless.
async function search(root, query, limit = 200) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return { matches: [], capped: false };

  const files = await ensureIndex(root);
  const hits = [];
  for (const rel of files) {
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
    capped: index.capped,
  };
}

// ---------------------------------------------------------------- watching

// One inotify watch per folder the tree has expanded, reconciled whenever the
// renderer expands or collapses something. Recursive watching is a Windows and
// macOS luxury, and watching a whole checkout would be wrong anyway: the tree
// only redraws the folders you can actually see.
class Watcher {
  constructor(onChange) {
    this.onChange = onChange;
    this.root = null;
    this.handles = new Map(); // rel -> FSWatcher
    this.timers = new Map();
  }

  // Editors write a file by renaming a temp file over it, which fires two or
  // three events. One redraw per folder per burst is enough.
  ping(rel) {
    clearTimeout(this.timers.get(rel));
    this.timers.set(rel, setTimeout(() => {
      this.timers.delete(rel);
      invalidate();
      this.onChange(rel);
    }, 120));
  }

  sync(root, dirs) {
    if (root !== this.root) { this.clear(); this.root = root; }
    // The renderer sends its expanded folders in the order they were opened, so
    // the newest are the ones worth keeping when there are more than the cap.
    const want = new Set(Array.isArray(dirs) ? dirs.slice(-64) : []);

    for (const [rel, h] of this.handles) {
      if (want.has(rel)) continue;
      try { h.close(); } catch {}
      this.handles.delete(rel);
    }

    for (const rel of want) {
      if (this.handles.has(rel)) continue;
      const abs = within(root, rel);
      if (!abs) continue;
      try {
        const h = fs.watch(abs, { persistent: false }, () => this.ping(rel));
        // A deleted folder takes its watch down with an EPERM on some systems.
        h.on('error', () => { try { h.close(); } catch {} this.handles.delete(rel); });
        this.handles.set(rel, h);
      } catch { /* unreadable or gone: the next refresh will say so */ }
    }
    return this.handles.size;
  }

  clear() {
    for (const h of this.handles.values()) { try { h.close(); } catch {} }
    this.handles.clear();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}

module.exports = { list, read, search, within, langOf, invalidate, Watcher, MAX_TEXT };
