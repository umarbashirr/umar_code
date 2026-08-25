'use strict';
// Which editors this machine has, so the project folder is one click from the
// one you already use. Tandem is a terminal and an agent, not an IDE, and the
// day you want a real editor open on the same folder should not start with
// finding a file manager.
//
// Detection is a search for launchers, not a package query: a name on PATH, a
// JetBrains Toolbox script, a flatpak export, an AppImage in the usual folders.
// That covers how these things actually arrive on a Linux machine, costs a few
// stat calls, and never shells out to a package manager that may not exist.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const TTL_MS = 60000;

// Ordered by how likely someone is to want it, which is the order the menu
// shows when nothing has been picked yet. `bins` are the launchers to look for,
// `flatpak` is the id flatpak exports as a binary of the same name, and
// `appimage` matches the file someone downloaded and never renamed.
const CATALOG = [
  { id: 'code', name: 'VS Code', bins: ['code'], flatpak: 'com.visualstudio.code', appimage: /^vscode|^code/i },
  { id: 'cursor', name: 'Cursor', bins: ['cursor'], appimage: /^cursor/i },
  { id: 'windsurf', name: 'Windsurf', bins: ['windsurf'], appimage: /^windsurf/i },
  { id: 'zed', name: 'Zed', bins: ['zed', 'zeditor'], flatpak: 'dev.zed.Zed', appimage: /^zed/i },
  { id: 'code-insiders', name: 'VS Code Insiders', bins: ['code-insiders'] },
  { id: 'codium', name: 'VSCodium', bins: ['codium', 'vscodium'], flatpak: 'com.vscodium.codium' },
  { id: 'sublime', name: 'Sublime Text', bins: ['subl', 'sublime_text'] },
  { id: 'webstorm', name: 'WebStorm', bins: ['webstorm'] },
  { id: 'idea', name: 'IntelliJ IDEA', bins: ['idea', 'idea-ultimate', 'idea-community'] },
  { id: 'pycharm', name: 'PyCharm', bins: ['pycharm', 'pycharm-professional', 'charm'] },
  { id: 'phpstorm', name: 'PhpStorm', bins: ['phpstorm'] },
  { id: 'goland', name: 'GoLand', bins: ['goland'] },
  { id: 'rustrover', name: 'RustRover', bins: ['rustrover'] },
  { id: 'clion', name: 'CLion', bins: ['clion'] },
  { id: 'rider', name: 'Rider', bins: ['rider'] },
  { id: 'rubymine', name: 'RubyMine', bins: ['rubymine'] },
  { id: 'datagrip', name: 'DataGrip', bins: ['datagrip'] },
  { id: 'fleet', name: 'Fleet', bins: ['fleet'] },
  { id: 'android-studio', name: 'Android Studio', bins: ['android-studio', 'studio'] },
  { id: 'positron', name: 'Positron', bins: ['positron'] },
  { id: 'lapce', name: 'Lapce', bins: ['lapce'] },
  { id: 'kate', name: 'Kate', bins: ['kate'], flatpak: 'org.kde.kate' },
  { id: 'gnome-builder', name: 'GNOME Builder', bins: ['gnome-builder'], flatpak: 'org.gnome.Builder' },
];

const home = () => os.homedir();

// Where .desktop entries live, in the order freedesktop says to prefer them.
// snapd and flatpak both write their own, which is how a snap of VS Code and a
// flatpak of Zed end up with icons here without either being special-cased.
const APP_DIRS = () => [
  path.join(home(), '.local', 'share', 'applications'),
  '/usr/local/share/applications',
  '/usr/share/applications',
  '/var/lib/snapd/desktop/applications',
  '/var/lib/flatpak/exports/share/applications',
  path.join(home(), '.local', 'share', 'flatpak', 'exports', 'share', 'applications'),
];

const ICON_DIRS = () => [
  path.join(home(), '.local', 'share', 'icons'),
  '/usr/local/share/icons',
  '/usr/share/icons',
  '/var/lib/flatpak/exports/share/icons',
  path.join(home(), '.local', 'share', 'flatpak', 'exports', 'share', 'icons'),
  '/usr/share/pixmaps',
];

// Big enough to stay sharp on a HiDPI screen at the sixteen pixels the menu
// draws, small enough that a dozen of them over IPC is nothing.
const ICON_SIZES = ['128x128', '96x96', '64x64', '256x256', '48x48', '512x512', 'scalable'];
const MAX_ICON_BYTES = 256 * 1024;
const MIME = { '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

// PATH first, then the places a launcher lands without being on it. A flatpak
// export directory holds binaries named after the app id, which is why the id
// is searched for as though it were a command.
function searchDirs() {
  const seen = new Set();
  const dirs = [];
  const add = (d) => { if (d && !seen.has(d)) { seen.add(d); dirs.push(d); } };

  for (const d of (process.env.PATH || '').split(path.delimiter)) add(d);
  add('/usr/local/bin');
  add('/usr/bin');
  add('/snap/bin');
  add(path.join(home(), '.local', 'bin'));
  add(path.join(home(), 'bin'));
  // JetBrains Toolbox writes one script per IDE here and only puts it on PATH
  // if you let it.
  add(path.join(home(), '.local', 'share', 'JetBrains', 'Toolbox', 'scripts'));
  add('/var/lib/flatpak/exports/bin');
  add(path.join(home(), '.local', 'share', 'flatpak', 'exports', 'bin'));
  return dirs;
}

const APPIMAGE_DIRS = () => [
  path.join(home(), 'Applications'),
  path.join(home(), 'Apps'),
  path.join(home(), 'AppImages'),
  path.join(home(), '.local', 'bin'),
];

const runnable = (p) => {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

function findLauncher(entry, dirs, appimages) {
  const names = entry.flatpak ? [...entry.bins, entry.flatpak] : entry.bins;
  for (const name of names) {
    for (const dir of dirs) {
      const p = path.join(dir, name);
      if (runnable(p)) return p;
    }
  }
  if (entry.appimage) {
    const hit = appimages.find((f) => entry.appimage.test(path.basename(f)));
    if (hit) return hit;
  }
  return null;
}

function listAppImages() {
  const out = [];
  for (const dir of APPIMAGE_DIRS()) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.toLowerCase().endsWith('.appimage')) continue;
      const p = path.join(dir, n);
      if (runnable(p)) out.push(p);
    }
  }
  return out;
}

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

// The Exec line is a command plus field codes, and it may be prefixed with env
// or a full path. What matters here is the name of the program it runs.
function execName(line) {
  const parts = String(line || '').trim().split(/\s+/).filter(Boolean);
  for (const part of parts) {
    if (part.includes('=') && !part.startsWith('/')) continue;   // VAR=value
    if (part === 'env' || part === 'sh' || part === '-c') continue;
    if (part.startsWith('%') || part.startsWith('-')) continue;
    return path.basename(part.replace(/^"|"$/g, ''));
  }
  return null;
}

// One pass over the .desktop files, keyed by the program each one launches.
// A url handler entry names the same program and carries the same icon, so the
// first plain entry wins and the rest are only a fallback.
function desktopIndex() {
  const byExec = new Map();
  for (const dir of APP_DIRS()) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.desktop')) continue;
      let text = '';
      try { text = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
      const icon = /^Icon=(.+)$/m.exec(text)?.[1]?.trim();
      if (!icon) continue;
      const exec = execName(/^Exec=(.+)$/m.exec(text)?.[1]);
      if (!exec) continue;
      const weak = /url-handler|uri-handler/.test(name);
      const held = byExec.get(exec);
      if (!held || (held.weak && !weak)) byExec.set(exec, { icon, weak });
    }
  }
  return byExec;
}

// An Icon= is either a path or a name to look up in the icon theme. Themes are
// a spec with inheritance and index files; this walks the sizes directly, which
// is the part of it that matters for an application icon.
function iconFile(name) {
  if (!name) return null;
  if (name.startsWith('/')) return isFile(name) ? name : null;

  for (const base of ICON_DIRS()) {
    for (const ext of ['.png', '.svg']) {
      const flat = path.join(base, name + ext);
      if (isFile(flat)) return flat;
    }
    for (const size of ICON_SIZES) {
      for (const ext of ['.png', '.svg']) {
        const p = path.join(base, 'hicolor', size, 'apps', name + ext);
        if (isFile(p)) return p;
      }
    }
  }
  return null;
}

// Icons change about as often as the machine is reinstalled, so a path read
// once is remembered for as long as the app is running.
const iconCache = new Map();

function iconData(file) {
  if (!file) return null;
  if (iconCache.has(file)) return iconCache.get(file);

  let url = null;

  // An application icon on disk is often 512 pixels square. The menu draws it
  // at sixteen, and every one of these crosses IPC, so Electron shrinks them
  // first. It cannot read SVG, which is what the raw read below is for.
  try {
    const { nativeImage } = require('electron');
    const img = nativeImage.createFromPath(file);
    if (!img.isEmpty()) {
      const wide = img.getSize().width > 96;
      url = (wide ? img.resize({ width: 96, height: 96, quality: 'good' }) : img).toDataURL();
    }
  } catch {}

  if (!url) {
    try {
      const st = fs.statSync(file);
      const mime = MIME[path.extname(file).toLowerCase()];
      if (mime && st.size <= MAX_ICON_BYTES) {
        url = `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
      }
    } catch {}
  }

  iconCache.set(file, url);
  return url;
}

let cache = { at: 0, list: null };

// The list the menu draws. Cached for a minute: the answer changes when
// somebody installs an editor, which is not something worth stat-ing the disk
// for every time a menu opens.
function detect({ fresh = false } = {}) {
  if (!fresh && cache.list && Date.now() - cache.at < TTL_MS) return cache.list;

  const dirs = searchDirs();
  const appimages = listAppImages();
  const desktops = desktopIndex();
  const list = [];

  for (const entry of CATALOG) {
    const bin = findLauncher(entry, dirs, appimages);
    if (!bin) continue;

    // The desktop entry is looked up by every name this editor answers to,
    // including the one the launcher actually has on disk: a snap of VS Code
    // is /snap/bin/code, and its .desktop is called code_code.
    const names = [path.basename(bin), ...entry.bins];
    if (entry.flatpak) names.push(entry.flatpak);
    let icon = null;
    for (const name of names) {
      const found = desktops.get(name);
      if (found) { icon = iconData(iconFile(found.icon)); if (icon) break; }
    }
    // Nothing in the theme, but an AppImage carries its own name and a flatpak
    // exports its icon under the app id.
    if (!icon && entry.flatpak) icon = iconData(iconFile(entry.flatpak));

    list.push({ id: entry.id, name: entry.name, bin, icon });
  }

  cache = { at: Date.now(), list };
  return list;
}

// Every editor here takes a folder as its argument. Detached and with its
// streams let go, so closing Tandem does not take the editor with it.
function open(id, dir) {
  if (!dir) return { error: 'no folder is open' };
  const found = detect().find((e) => e.id === id) || detect({ fresh: true }).find((e) => e.id === id);
  if (!found) return { error: 'that editor is not installed any more' };

  try {
    const child = spawn(found.bin, [dir], { cwd: dir, detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch (e) {
    return { error: `could not start ${found.name}: ${e.message}` };
  }
  return { ok: true, id: found.id, name: found.name };
}

module.exports = { detect, open, CATALOG };
