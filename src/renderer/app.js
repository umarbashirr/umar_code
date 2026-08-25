import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import {
  createIcons,
  AppWindow, ArrowLeft, ArrowRight, Binary, Camera, Check, ChevronDown,
  ChevronRight, ChevronUp, CodeXml, Copy, Crosshair, EllipsisVertical,
  ExternalLink, Eye, EyeOff, File, FileCode, FileImage, FileJson, FileText,
  Folder, FolderOpen, FolderTree, GitCompare, Globe, Hexagon, Laptop, Maximize2,
  MessageSquare, MessageSquareDot, Minimize2, Minus, Monitor, Moon, PanelBottom,
  PanelLeft, Plus, RotateCw, Scan, Search, Smartphone, Sparkles, Square,
  SquarePen, SquareTerminal, Sun, Tablet, X,
} from 'lucide';
import { showMenu, closeMenu } from './menu-pop.js';

export const $ = (sel) => document.querySelector(sel);
export const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

// lucide swaps <i data-lucide="name"> for inline SVG. Anything drawn after load
// has to ask for another pass.
//
// Named imports, not `import { icons }`. That export is one object holding every
// icon in the set, so nothing can be shaken out of it: the whole ~1600 of them
// were landing in the entry chunk to draw these twenty. Adding an icon here
// means adding its PascalCase name too.
const USED = {
  AppWindow, ArrowLeft, ArrowRight, Binary, Camera, Check, ChevronDown,
  ChevronRight, ChevronUp, CodeXml, Copy, Crosshair, EllipsisVertical,
  ExternalLink, Eye, EyeOff, File, FileCode, FileImage, FileJson, FileText,
  Folder, FolderOpen, FolderTree, GitCompare, Globe, Hexagon, Laptop, Maximize2,
  MessageSquare, MessageSquareDot, Minimize2, Minus, Monitor, Moon, PanelBottom,
  PanelLeft, Plus, RotateCw, Scan, Search, Smartphone, Sparkles, Square,
  SquarePen, SquareTerminal, Sun, Tablet, X,
};

export const icons = () => { try { createIcons({ icons: USED }); } catch {} };
export const iconMark = (name) => { const n = el('i'); n.dataset.lucide = name; return n; };

const state = {
  tabs: [],
  active: null,
  autoOpen: false,
  // The right column holds one view at a time: the preview browser, the project
  // files, or the uncommitted changes. `rightOpen` is the column, `rightView` is
  // which of the three.
  rightOpen: false,
  rightView: 'browser',
  previewFull: false,
  panelOpen: false,
  paneLive: false,
  drawerTab: 'console',
  console: [],
  network: [],
  lastError: null,
};

// ------------------------------------------------------------- preferences

// The settings file, read synchronously through the preload bridge so the first
// paint is already the right theme at the right size. Main owns the file; this
// is a copy that is replaced whenever it changes, from here or from the
// settings page.
let prefs = {
  appearance: { theme: 'system', zoom: 1 },
  terminal: { fontSize: 13, fontFamily: 'ui-monospace, monospace' },
};
try { prefs = window.tandem.settings.snapshot() || prefs; } catch {}

const save = (partial) => { try { window.tandem.settings.set(partial); } catch {} };

// Theme and zoom used to live in localStorage. Carry whatever is there into the
// settings file once, then drop the old keys so this never runs again. Without
// it, upgrading silently resets someone's dark mode.
(function adoptOldPrefs() {
  try {
    const theme = localStorage.getItem('tandem.theme');
    const zoom = Number(localStorage.getItem('tandem.zoom'));
    if (!theme && !zoom) return;
    const appearance = {};
    if (theme === 'light' || theme === 'dark') appearance.theme = theme;
    if (zoom > 0) appearance.zoom = zoom;
    localStorage.removeItem('tandem.theme');
    localStorage.removeItem('tandem.zoom');
    if (!Object.keys(appearance).length) return;
    prefs = { ...prefs, appearance: { ...prefs.appearance, ...appearance } };
    save({ appearance });
  } catch {}
}());

// ------------------------------------------------------------------ theme

// xterm allocates the cell buffer per line as output arrives, so scrollback is
// a real ceiling on memory, not a reservation: 20000 lines at 120 columns is
// tens of megabytes for one tab that has printed a lot. This is enough to scroll
// back through a build log and cheap enough to open several tabs.
const SCROLLBACK = 5000;

const systemDark = () => { try { return matchMedia('(prefers-color-scheme: dark)').matches; } catch { return false; } };

// 'system' is a preference, not a colour. What the page and the terminal get is
// always one of the two real answers.
const resolvedTheme = () => {
  const pref = prefs.appearance.theme;
  return pref === 'system' ? (systemDark() ? 'dark' : 'light') : pref;
};

function applyTheme() {
  const name = resolvedTheme();
  document.documentElement.dataset.theme = name;
  const btn = $('#theme-toggle');
  btn.replaceChildren(iconMark(name === 'dark' ? 'moon' : 'sun'));
  btn.title = prefs.appearance.theme === 'system'
    ? `Following the system (${name}). Click to pin the other one`
    : name === 'dark' ? 'Switch to light' : 'Switch to dark';
  icons();
  // xterm draws its own colours, so it has to be told separately.
  for (const t of state.tabs) t.term.options.theme = termTheme();
}

function termTheme() {
  // The terminal stays dark in both themes: a white terminal fights every
  // prompt and colour scheme people already have.
  return {
    background: '#0b0d12', foreground: '#d7dce6', cursor: '#6ea8fe',
    selectionBackground: '#2a3550',
    black: '#171b26', red: '#ef6a6a', green: '#58d18a', yellow: '#e5b567',
    blue: '#6ea8fe', magenta: '#b58cf6', cyan: '#5fd0d0', white: '#d7dce6',
  };
}

applyTheme();

// Following the system means following it while the window is open, not only at
// launch. Desktops that switch at sunset do it without telling the app twice.
try {
  matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => { if (prefs.appearance.theme === 'system') applyTheme(); });
} catch {}

// The toolbar button is two-state, so it pins whichever one is not showing.
// Getting back to following the system is the settings page's job.
const toggleTheme = () => save({ appearance: { theme: resolvedTheme() === 'dark' ? 'light' : 'dark' } });

$('#theme-toggle').onclick = toggleTheme;

// ------------------------------------------------------------------- zoom

// One zoom for the whole app shell. The preview pane is its own web contents
// and keeps whatever zoom the page has; what changes here is the chrome around
// it, which is the part people squint at.
export const ZOOM_STEPS = [0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5];
let zoom = 1;

// Draws the zoom without writing it down. applyZoom is the one that remembers,
// which keeps a settings change echoing back here from being saved twice.
function drawZoom(next) {
  zoom = ZOOM_STEPS.reduce((best, z) => (Math.abs(z - next) < Math.abs(best - next) ? z : best), 1);
  window.tandem.win.zoom(zoom);
  $('#zoom-level').textContent = `${Math.round(zoom * 100)}%`;
  $('#zoom').classList.toggle('off', zoom === 1);
  // Every measurement the layout makes is in CSS pixels, which just changed
  // size, so the terminal and the pane both need telling.
  requestAnimationFrame(() => { resizeActive(); syncBounds(); });
}

function applyZoom(next) {
  drawZoom(next);
  save({ appearance: { zoom } });
}

function stepZoom(dir) {
  const at = ZOOM_STEPS.indexOf(zoom);
  const next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, at + dir))];
  if (next !== zoom) applyZoom(next);
}

drawZoom(prefs.appearance.zoom || 1);

$('#zoom-in').onclick = () => stepZoom(1);
$('#zoom-out').onclick = () => stepZoom(-1);
$('#zoom-level').onclick = () => applyZoom(1);

// One place the settings page and the toolbar both land, whichever made the
// change: main writes the file, then says so, and the shell redraws from that.
window.tandem.settings.onChanged((next) => {
  if (!next) return;
  const before = prefs;
  prefs = next;
  if (next.appearance.theme !== before.appearance.theme) applyTheme();
  if (next.appearance.zoom !== zoom) drawZoom(next.appearance.zoom || 1);
  if (next.terminal.fontSize !== before.terminal.fontSize
    || next.terminal.fontFamily !== before.terminal.fontFamily) applyTerminalFont();
});

// Font changes reflow every line xterm has buffered, so the tab has to be
// measured again afterwards or the shell keeps writing to the old grid.
function applyTerminalFont() {
  for (const t of state.tabs) {
    t.term.options.fontFamily = prefs.terminal.fontFamily;
    t.term.options.fontSize = prefs.terminal.fontSize;
  }
  requestAnimationFrame(resizeActive);
}

// --------------------------------------------------------------- terminals

function newTerminalTab(command) {
  openPanel();
  const host = el('div', 'term-host');
  $('#terms').appendChild(host);

  const term = new Terminal({
    fontFamily: prefs.terminal.fontFamily,
    fontSize: prefs.terminal.fontSize,
    lineHeight: 1.25,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: SCROLLBACK,
    theme: termTheme(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon((_e, uri) => openInPane(uri)));
  term.attachCustomKeyEventHandler((e) => !isAppChord(e));
  term.open(host);

  const tab = { id: null, term, fit, host, title: 'shell', node: null };
  state.tabs.push(tab);

  window.tandem.term.create({ cols: term.cols, rows: term.rows }).then(({ id, shell }) => {
    tab.id = id;
    if (shell) tab.title = shell;
    term.onData((d) => window.tandem.term.input(id, d));
    term.onResize(({ cols, rows }) => window.tandem.term.resize(id, cols, rows));
    activate(tab);
    // Sent as keystrokes rather than run for you: the line is visible, and an
    // interactive flow like `claude mcp login` needs a real terminal anyway.
    if (command) window.tandem.term.input(id, command + '\n');
    setTimeout(() => resizeActive(), 30);
  });

  renderStrip();
  return tab;
}

// Two rows of tabs, redrawn together whenever anything opens or closes. The
// toolbar names the two panes that live in the right column; the shells are
// listed inside the panel they run in, the way a terminal names its own tabs.
// Nothing in the toolbar lists them any more, so the panel toggle next to it is
// how you get back to a shell you cannot see.
function renderStrip() {
  const views = $('#viewstrip');
  views.innerHTML = '';

  const showing = (view) => state.rightOpen && state.rightView === view;

  const browser = el('button', 'vtab' + (showing('browser') ? ' on' : ''));
  browser.appendChild(iconMark('globe'));
  browser.appendChild(el('span', null, 'Browser'));
  browser.title = 'Preview browser (Ctrl+Shift+B)';
  browser.onclick = () => togglePreview();
  views.appendChild(browser);

  const files = el('button', 'vtab' + (showing('files') ? ' on' : ''));
  files.appendChild(iconMark('folder-tree'));
  files.appendChild(el('span', null, 'Files'));
  files.title = 'Project files (Ctrl+Shift+D)';
  files.onclick = () => toggleFiles();
  views.appendChild(files);

  // The count is the point of the tab: a glance says whether the agent has
  // been writing. It is only there once the view has read the folder at least
  // once, so a window that never opens this tab never runs git.
  const changed = window.tandemChanges?.count() || 0;
  const changes = el('button', 'vtab' + (showing('changes') ? ' on' : ''));
  changes.appendChild(iconMark('git-compare'));
  changes.appendChild(el('span', null, 'Changes'));
  if (changed) changes.appendChild(el('span', 'count', String(changed)));
  changes.title = 'Uncommitted changes (Ctrl+Shift+G)';
  changes.onclick = () => toggleChanges();
  views.appendChild(changes);

  const strip = $('#term-tabs');
  strip.innerHTML = '';

  state.tabs.forEach((tab, i) => {
    const node = el('button', 'vtab' + (tab === state.active ? ' on' : ''));
    node.appendChild(iconMark('square-terminal'));
    node.appendChild(el('span', null, tab.title));
    const close = el('span', 'close');
    close.appendChild(iconMark('x'));
    close.onclick = (e) => { e.stopPropagation(); closeTab(tab); };
    node.appendChild(close);
    node.title = `${tab.title} (Ctrl+${i + 1})`;
    node.onclick = () => activate(tab);
    tab.node = node;
    strip.appendChild(node);
  });

  const add = el('button', 'vtab add');
  add.appendChild(iconMark('plus'));
  add.title = 'New terminal (Ctrl+Shift+T)';
  add.onclick = () => newTerminalTab();
  strip.appendChild(add);

  icons();
}

function activate(tab) {
  state.active = tab;
  for (const t of state.tabs) t.host.classList.toggle('active', t === tab);
  renderStrip();
  tab.term.focus();
  resizeActive();
}

function closeTab(tab) {
  if (tab.id) window.tandem.term.kill(tab.id);
  tab.term.dispose();
  tab.host.remove();
  state.tabs = state.tabs.filter((t) => t !== tab);
  if (state.active === tab) state.active = state.tabs[state.tabs.length - 1] || null;
  renderStrip();
  if (state.active) activate(state.active);
  else closePanel(); // last shell closed: put the panel away rather than respawning
}

function resizeActive() {
  if (!state.active) return;
  try { state.active.fit.fit(); } catch {}
}

// Switching project folder pulls the ground out from under every shell: their
// processes are already gone, so drop the views and start one in the new folder
// if the panel is showing.
export function resetTerminals() {
  const wasOpen = state.panelOpen;
  for (const tab of [...state.tabs]) closeTab(tab);
  if (wasOpen) { openPanel(); requestAnimationFrame(() => state.active?.term.focus()); }
}

window.tandem.term.onData(({ id, data }) => {
  const tab = state.tabs.find((t) => t.id === id);
  tab?.term.write(data);
});

window.tandem.term.onExit(({ id }) => {
  const tab = state.tabs.find((t) => t.id === id);
  if (tab) { tab.title = 'exited'; renderStrip(); tab.term.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n'); }
});

window.tandem.term.onUrl(({ url }) => {
  if (state.autoOpen) { openInPane(url); return; }
  toastDetected(url);
});

// ---------------------------------------------------------- terminal panel

function openPanel() {
  if (state.panelOpen) return;
  state.panelOpen = true;
  $('#panel').classList.remove('closed');
  $('#panel-gutter').classList.remove('closed');
  $('#term-toggle').classList.add('on');
  renderStrip();
  // The first open is what creates the shell: nothing is spawned until asked.
  if (!state.tabs.length) requestAnimationFrame(() => newTerminalTab());
  requestAnimationFrame(() => { resizeActive(); syncBounds(); });
}

function closePanel() {
  if (!state.panelOpen) return;
  state.panelOpen = false;
  $('#panel').classList.add('closed');
  $('#panel-gutter').classList.add('closed');
  $('#term-toggle').classList.remove('on');
  renderStrip();
  requestAnimationFrame(syncBounds);
}

const togglePanel = () => {
  if (state.panelOpen) return closePanel();
  openPanel();
  requestAnimationFrame(() => state.active?.term.focus());
};

$('#term-toggle').onclick = togglePanel;

// -------------------------------------------------------------------- rail

function toggleRail() {
  const rail = $('#rail');
  const closed = rail.classList.toggle('closed');
  $('#rail-gutter').classList.toggle('closed', closed);
  requestAnimationFrame(() => { resizeActive(); syncBounds(); });
}
$('#rail-toggle').onclick = toggleRail;

// ------------------------------------------------------------ preview pane

// A dialog in the agent panel is HTML; the preview is a native view painted
// above it. Anything centred on the window would come out sliced in half, so a
// modal parks the pane the same way a closed preview is parked: offscreen, still
// laying out, back in place the moment the dialog closes.
let previewParked = false;

export function parkPreview(on) {
  if (previewParked === !!on) return;
  previewParked = !!on;
  syncBounds();
}

// The pane is placed in the window's own pixels, while everything measured in
// here is a CSS pixel. At any zoom other than 100% those are different sizes,
// so every box handed over gets scaled on the way out.
const inWindowPixels = (b) => ({
  x: Math.round(b.x * zoom), y: Math.round(b.y * zoom),
  width: Math.round(b.width * zoom), height: Math.round(b.height * zoom),
});

function syncBounds() {
  // The files view sits where the pane would be, so anything other than the
  // browser showing in that column parks the pane the same way a modal does.
  if (previewParked || !state.rightOpen || state.rightView !== 'browser') {
    // Park it just outside the window instead of hiding it. A hidden view stops
    // laying out, and the agent would get a 0x0 page while the pane is closed.
    window.tandem.browser.setBounds(inWindowPixels({
      x: window.innerWidth + 40, y: 40,
      width: window.innerWidth * 0.5,
      height: Math.max(240, window.innerHeight - 96),
    }));
    return;
  }
  const r = $('#paneslot').getBoundingClientRect();
  window.tandem.browser.setBounds(inWindowPixels({ x: r.x, y: r.y, width: r.width, height: r.height }));
}

// Open the right column on one of its two views. Switching between them keeps
// the column's width, so the browser and the files trade places rather than
// each fighting for their own slice of the window.
function showRight(view) {
  const already = state.rightOpen && state.rightView === view;
  state.rightOpen = true;
  state.rightView = view;
  $('#right').classList.remove('closed');
  $('#agent-gutter').classList.remove('closed');
  $('#browser-view').hidden = view !== 'browser';
  $('#files-view').hidden = view !== 'files';
  $('#changes-view').hidden = view !== 'changes';
  renderStrip();
  if (view === 'files') window.tandemFiles?.activate();
  if (view === 'changes') window.tandemChanges?.activate();
  else window.tandemChanges?.deactivate();
  requestAnimationFrame(() => {
    syncBounds();
    resizeActive();
    if (view === 'browser') window.tandem.browser.setVisible(true);
  });
  return already;
}

function closeRight() {
  if (!state.rightOpen) return;
  // Both panes hidden at once is a blank window, so putting the column away
  // gives the chat its half back first.
  setPreviewFull(false);
  state.rightOpen = false;
  window.tandemChanges?.deactivate();
  $('#right').classList.add('closed');
  $('#agent-gutter').classList.add('closed');
  renderStrip();
  syncBounds();
  requestAnimationFrame(resizeActive);
}

function openPreview(focusUrl = false) {
  showRight('browser');
  if (focusUrl && !state.paneLive) requestAnimationFrame(() => { $('#url').focus(); $('#url').select(); });
}

// Asked to hide the preview while the files are showing, there is no preview on
// screen to hide, so the column stays where it is.
function closePreview() {
  if (state.rightView === 'browser') closeRight();
}

const togglePreview = () => (state.rightOpen && state.rightView === 'browser' ? closeRight() : openPreview(true));
const toggleFiles = () => (state.rightOpen && state.rightView === 'files' ? closeRight() : showRight('files'));
const toggleChanges = () => (state.rightOpen && state.rightView === 'changes' ? closeRight() : showRight('changes'));

// The right column at full width: the chat collapses to nothing and whichever
// view is showing takes the whole content column. The rail is deliberately left
// alone, so a sidebar that was open stays open, and closing it hands the last of
// the window over to the page.
function setPreviewFull(on) {
  const next = on === undefined ? !state.previewFull : !!on;
  if (next === state.previewFull) return;
  state.previewFull = next;
  if (next) showRight(state.rightView);
  $('#panes').classList.toggle('preview-full', next);
  // The files and changes views keep a button for this; the preview keeps it in
  // its menu.
  for (const [sel, name] of [['#files-expand', 'Files'], ['#changes-expand', 'Changes']]) {
    const btn = $(sel);
    btn.classList.toggle('armed', next);
    btn.title = next ? 'Back to the chat (Ctrl+Shift+F)' : `${name} at full width (Ctrl+Shift+F)`;
    btn.replaceChildren(iconMark(next ? 'minimize-2' : 'maximize-2'));
  }
  icons();
  requestAnimationFrame(() => { resizeActive(); syncBounds(); });
}

$('#files-expand').onclick = () => setPreviewFull();
$('#changes-expand').onclick = () => setPreviewFull();
$('#close-files').onclick = () => closeRight();

// The changes view is its own module and needs three things from the shell:
// the column, the tab strip it puts a count in, and the way to hand a file to
// the tree next door.
window.tandemStrip = () => renderStrip();
window.tandemCloseRight = () => closeRight();
window.tandemOpenFile = (rel) => runCommand('openFile', rel);

async function openInPane(url) {
  $('#url').value = url;
  openPreview();
  await window.tandem.browser.action('navigate', url);
}

function showPane(live) {
  state.paneLive = live;
  $('#placeholder').classList.toggle('hidden', live || !!state.lastError);
  window.tandem.browser.setVisible(true); // hiding is done by parking it offscreen
  if (live) syncBounds();
}

// ------------------------------------------------------- page error state

function showPageError(err, url) {
  state.lastError = { err, url, at: Date.now() };
  $('#pe-title').textContent = /ERR_CONNECTION|refused|(-102)/i.test(err) ? "Can't connect to server" : 'This page did not load';
  $('#pe-detail').textContent = `${url || 'the page'} — ${err}`;
  $('#placeholder').classList.add('hidden');
  $('#page-error').hidden = false;
  openPreview();
}

function clearPageError() {
  if (!state.lastError) return;
  state.lastError = null;
  $('#page-error').hidden = true;
}

$('#pe-ask').onclick = () => {
  const e = state.lastError;
  if (!e) return;
  window.sendToAgent?.(
    `The preview failed to load ${e.url || 'the page'} with "${e.err}". ` +
    'Work out why: check whether the dev server is running, what port it is actually on, ' +
    'and start it or point me at the right URL.',
  );
};

$('#pe-details').onclick = async () => {
  state.drawerTab = 'network';
  state.network = await window.tandem.browser.action('network');
  for (const b of $('#drawer-tabs').querySelectorAll('[data-tab]')) b.classList.toggle('active', b.dataset.tab === 'network');
  $('#drawer').classList.remove('collapsed');
  renderDrawer();
  updateBadges();
  syncBounds();
};

window.tandem.browser.onState((s) => {
  if (document.activeElement !== $('#url') && s.url && s.url !== 'about:blank') {
    const m = /^(https?:\/\/)(.*)$/.exec(s.url);
    $('#url-scheme').textContent = m ? (m[1] === 'https://' ? '' : 'http://') : '';
    $('#url').value = m ? m[2] : s.url;
  }
  $('#back').disabled = !s.canGoBack;
  $('#forward').disabled = !s.canGoForward;

  if (s.error) showPageError(s.error, s.failedUrl || s.url);
  else if (s.loading || s.url) clearPageError();

  const blank = !s.url || s.url === 'about:blank';
  if (blank !== !state.paneLive) showPane(!blank);
  $('#page-status').textContent = s.error ? `error: ${s.error}` : blank ? '' : (s.loading ? 'loading…' : (s.title || ''));
});

// A page that logs in a loop used to rebuild every drawer row per message, and
// did it while the drawer was collapsed and nobody could see it. Coalesce to one
// repaint per frame, and only when it is actually on screen.
let drawerQueued = false;
function queueDrawer() {
  if (drawerQueued || $('#drawer').classList.contains('collapsed')) return;
  drawerQueued = true;
  requestAnimationFrame(() => { drawerQueued = false; renderDrawer(); });
}

window.tandem.browser.onConsole((c) => {
  state.console.push(c);
  if (state.console.length > 500) state.console.shift();
  if (state.drawerTab === 'console') queueDrawer();
  updateBadges();
});

function updateBadges() {
  const errors = state.console.filter((c) => c.level === 'error').length;
  const badge = $('#console-badge');
  badge.textContent = errors || state.console.length || '';
  badge.className = 'badge' + (state.console.length ? ' show' : '') + (errors ? ' err' : '');
  const nb = $('#network-badge');
  nb.textContent = state.network.length || '';
  nb.className = 'badge' + (state.network.length ? ' show err' : '');
}

// --------------------------------------------------------------- url bar

$('#url').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { openInPane(($('#url-scheme').textContent + $('#url').value).trim()); $('#url').blur(); }
  if (e.key === 'Escape') { $('#url').blur(); }
});
$('#back').onclick = () => window.tandem.browser.action('back');
$('#forward').onclick = () => window.tandem.browser.action('forward');
$('#reload').onclick = () => window.tandem.browser.action('reload');
// Everything the pane can do beyond navigating lives in one menu. The bar kept
// nine icons in a row and none of them said what they were.
const SIZES = [
  { size: '', label: 'Fit the pane', icon: 'scan' },
  { size: '390x844', label: 'Phone', note: '390 × 844', icon: 'smartphone' },
  { size: '768x1024', label: 'Tablet', note: '768 × 1024', icon: 'tablet' },
  { size: '1280x800', label: 'Laptop', note: '1280 × 800', icon: 'laptop' },
  { size: '1920x1080', label: 'Desktop', note: '1920 × 1080', icon: 'monitor' },
];
let paneSize = '';

function setViewport(size) {
  paneSize = size;
  if (!size) return window.tandem.browser.action('setViewport', null);
  const [w, h] = size.split('x').map(Number);
  window.tandem.browser.action('setViewport', { width: w, height: h });
}

function paneMenuItems() {
  const items = [{ header: 'Viewport' }];
  for (const s of SIZES) {
    items.push({ label: s.label, note: s.note, ltr: true, icon: s.icon, on: paneSize === s.size, run: () => setViewport(s.size) });
  }
  items.push(
    { sep: true },
    { label: 'Point at an element', icon: 'crosshair', hint: '^⇧E', run: () => pickElement() },
    { label: 'Screenshot to disk', icon: 'camera', run: () => screenshot() },
    { label: 'DevTools', icon: 'code-xml', run: () => window.tandem.browser.action('devtools') },
    {
      label: state.previewFull ? 'Back to the chat' : 'Preview at full width',
      icon: state.previewFull ? 'minimize-2' : 'maximize-2',
      hint: '^⇧F',
      run: () => setPreviewFull(),
    },
    { sep: true },
    { label: 'Hide the preview', icon: 'x', hint: '^⇧B', danger: true, run: () => closePreview() },
  );
  return items;
}

let paneMenuOpen = false;
const paneTrigger = $('#pane-menu');
paneTrigger.onclick = (e) => {
  e.stopPropagation();
  if (paneMenuOpen) return closeMenu();
  showMenu(paneTrigger, paneMenuItems(), {
    id: 'pane',
    align: 'right',
    onClose: () => { paneMenuOpen = false; paneTrigger.classList.remove('on'); paneTrigger.setAttribute('aria-expanded', 'false'); },
  });
  paneMenuOpen = true;
  paneTrigger.classList.add('on');
  paneTrigger.setAttribute('aria-expanded', 'true');
};

async function screenshot() {
  const r = await window.tandem.browser.action('screenshot', { fullPage: true });
  toast('Screenshot saved', r.path, [{ label: 'ok', primary: true }]);
}

// ----------------------------------------------------------- element pick

async function pickElement() {
  if (!state.paneLive) return toast('Nothing to point at', 'Load a page in the preview first.', [{ label: 'ok', primary: true }]);
  paneTrigger.classList.add('armed');
  let hit = null;
  try { hit = await window.tandem.browser.action('pick'); } finally { paneTrigger.classList.remove('armed'); }
  if (!hit) return;

  // Grab the element itself so the agent can look at it, not just read about it.
  let shotPath = null;
  try {
    const shot = await window.tandem.browser.action('screenshot', { target: hit.ref, name: `pick-${Date.now()}` });
    shotPath = shot?.path || null;
  } catch {}

  window.addAttachment?.(hit, shotPath);
}

window.pickElement = pickElement;

// ---------------------------------------------------------------- drawer

$('#drawer-tabs').addEventListener('click', async (e) => {
  const t = e.target.dataset.tab;
  if (!t) return;
  state.drawerTab = t;
  for (const b of $('#drawer-tabs').querySelectorAll('[data-tab]')) b.classList.toggle('active', b.dataset.tab === t);
  $('#drawer').classList.remove('collapsed');
  if (t === 'network') state.network = await window.tandem.browser.action('network');
  renderDrawer();
  updateBadges();
  syncBounds();
});
$('#drawer-toggle').onclick = () => { $('#drawer').classList.toggle('collapsed'); requestAnimationFrame(syncBounds); };
$('#drawer-clear').onclick = () => { state.console = []; state.network = []; renderDrawer(); updateBadges(); };

function renderDrawer() {
  const body = $('#drawer-body');
  body.innerHTML = '';
  const rows = state.drawerTab === 'console' ? state.console : state.network;
  if (!rows.length) { body.appendChild(el('div', 'empty', `no ${state.drawerTab} entries`)); return; }
  for (const r of rows.slice(-300)) {
    const line = el('div', 'logline ' + (r.level || (r.kind === 'failed' ? 'error' : '')));
    line.appendChild(el('span', 'lvl', r.level || r.kind || ''));
    line.appendChild(el('span', 'msg', r.message ?? `${r.status || r.error || ''} ${r.method || ''} ${r.url || ''}`.trim()));
    body.appendChild(line);
  }
  body.scrollTop = body.scrollHeight;
}

// ---------------------------------------------------------------- toasts

export function toast(title, urlText, actions) {
  const node = el('div', 'toast');
  node.appendChild(el('div', 't-title', title));
  if (urlText) node.appendChild(el('div', 't-url', urlText));
  const row = el('div', 't-actions');
  for (const a of actions) {
    const b = el('button', a.primary ? 'primary' : null, a.label);
    b.onclick = () => { node.remove(); a.run?.(); };
    row.appendChild(b);
  }
  node.appendChild(row);
  $('#toasts').appendChild(node);
  setTimeout(() => node.remove(), 15000);
  return node;
}

function toastDetected(url) {
  toast('Local server detected', url, [
    { label: 'Open', primary: true, run: () => openInPane(url) },
    { label: 'Always', run: () => { state.autoOpen = true; openInPane(url); } },
    { label: 'Ignore' },
  ]);
}

// ------------------------------------------------------------- agent feed

window.tandem.agent.onActivity(({ tool, args }) => {
  const a = $('#activity');
  const detail = args?.url || args?.target || args?.ref || args?.selector || args?.key || args?.text || '';
  a.textContent = `${tool}${detail ? ' ' + String(detail).slice(0, 40) : ''}`;
  a.classList.add('live');
  clearTimeout(a._t);
  a._t = setTimeout(() => a.classList.remove('live'), 1800);
  // The agent loading a page is a request to be looked at.
  if (tool === 'navigate') openPreview();
});

// One pane, several agents that want it. The chip says who has it so a page
// changing under you is explained rather than mysterious, and clicking takes
// the pane back: the next agent to ask waits for you instead.
function showDriver(holder) {
  const b = $('#pane-driver');
  if (!b) return;
  if (!holder || holder.id === 'human' || String(holder.id).startsWith('main:')) {
    b.hidden = true;
    return;
  }
  b.hidden = false;
  b.textContent = `${holder.label} is driving`;
}

window.tandem.browser.onDriver?.(({ holder }) => showDriver(holder));
window.tandem.browser.driver?.().then(({ holder }) => showDriver(holder)).catch(() => {});
$('#pane-driver').onclick = () => { window.tandem.browser.seize?.(); showDriver(null); };

// ------------------------------------------------------------- commands

function toggleDrawer() {
  openPreview();
  $('#drawer').classList.toggle('collapsed');
  requestAnimationFrame(syncBounds);
}

async function copyMcpCommand() {
  await navigator.clipboard.writeText(state.mcpCommand);
  toast('Copied', state.mcpCommand, [{ label: 'ok', primary: true }]);
}

// One place the menu bar, the native menu and the keyboard all go through.
export function runCommand(name, arg) {
  switch (name) {
    case 'preview':
      if (arg === true) return openPreview();
      if (arg === false) return closePreview();
      return togglePreview();
    case 'previewFull':
      if (arg === true || arg === false) return setPreviewFull(arg);
      return setPreviewFull();
    case 'files':
      if (arg === true) return showRight('files');
      if (arg === false) return closeRight();
      return toggleFiles();
    case 'changes':
      if (arg === true) return showRight('changes');
      if (arg === false) return closeRight();
      return toggleChanges();
    case 'openFile':
      if (!arg) return undefined;
      showRight('files');
      return window.tandemFiles?.open(String(arg));
    case 'zoomIn': return stepZoom(1);
    case 'zoomOut': return stepZoom(-1);
    case 'zoomReset': return applyZoom(1);
    case 'terminal': return togglePanel();
    case 'newTerminal': return newTerminalTab();
    case 'runInTerminal': return newTerminalTab(arg);
    case 'rail': return toggleRail();
    case 'drawer': return toggleDrawer();
    case 'theme': return toggleTheme();
    // Both live in the React half, which registers them on window.tandemChat.
    case 'settings': return window.tandemChat?.settings?.(arg);
    case 'updates': return window.tandemChat?.settings?.('updates');
    case 'newChat': return $('#new-chat').click();
    case 'copyMcp': return copyMcpCommand();
    case 'about': return toast(
      'Tandem',
      state.mcpCommand ? `bridge ${state.bridgeUrl}` : '',
      [{ label: 'ok', primary: true }],
    );
    default: return undefined;
  }
}

window.tandem.onCommand(({ name, open }) => runCommand(name, open));

// ------------------------------------------------------------- splitters

function drag(gutter, axis, apply) {
  let on = false;
  $(gutter).addEventListener('mousedown', (e) => {
    on = true;
    e.preventDefault();
    document.body.classList.add('dragging', axis === 'x' ? 'col' : 'row');
  });
  window.addEventListener('mousemove', (e) => {
    if (!on) return;
    apply(e);
    resizeActive();
    syncBounds();
  });
  window.addEventListener('mouseup', () => {
    if (!on) return;
    on = false;
    document.body.classList.remove('dragging', 'col', 'row');
  });
}

drag('#rail-gutter', 'x', (e) => {
  $('#rail').style.width = Math.min(420, Math.max(180, e.clientX)) + 'px';
});
drag('#agent-gutter', 'x', (e) => {
  const min = 360;
  const max = window.innerWidth - $('#rail').getBoundingClientRect().width - 380;
  $('#right').style.width = Math.min(max, Math.max(min, window.innerWidth - e.clientX)) + 'px';
});
drag('#panel-gutter', 'y', (e) => {
  const max = window.innerHeight - 220;
  // The floor clears the tab row plus a couple of lines of shell under it.
  $('#panel').style.height = Math.min(max, Math.max(124, window.innerHeight - e.clientY - 24)) + 'px';
});

window.addEventListener('resize', () => { resizeActive(); syncBounds(); });
new ResizeObserver(() => syncBounds()).observe($('#paneslot'));

// ---------------------------------------------------------------- keys

// Ctrl+Shift+<key> and Ctrl+` only: everything else belongs to the shell.
function isAppChord(e) {
  const mod = e.ctrlKey || e.metaKey;
  const k = (e.key || '').toLowerCase();
  if (mod && e.shiftKey && ['b', 'd', 'g', 't', 'l', 'e', 'j', 's', 'k'].includes(k)) return true;
  if (mod && k === '`') return true;
  if (mod && !e.shiftKey && k.length === 1 && k >= '1' && k <= '9') return true;
  return false;
}

window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const shift = e.shiftKey;
  const k = (e.key || '').toLowerCase();
  if (mod && k === '`') { e.preventDefault(); togglePanel(); }
  else if (mod && shift && k === 'b') { e.preventDefault(); togglePreview(); }
  else if (mod && shift && k === 'd') { e.preventDefault(); toggleFiles(); }
  else if (mod && shift && k === 'g') { e.preventDefault(); toggleChanges(); }
  else if (mod && shift && k === 's') { e.preventDefault(); toggleRail(); }
  else if (mod && shift && k === 't') { e.preventDefault(); newTerminalTab(); }
  else if (mod && shift && k === 'k') { e.preventDefault(); document.querySelector('#agent-root textarea')?.focus(); }
  else if (mod && shift && k === 'l') { e.preventDefault(); openPreview(); $('#url').select(); $('#url').focus(); }
  else if (mod && shift && k === 'e') { e.preventDefault(); openPreview(); pickElement(); }
  else if (mod && shift && k === 'j') { e.preventDefault(); toggleDrawer(); }
  else if (mod && e.key >= '1' && e.key <= '9' && state.panelOpen) {
    const t = state.tabs[Number(e.key) - 1];
    if (t) { e.preventDefault(); activate(t); }
  }
});

// ---------------------------------------------------------------- boot

(async () => {
  const info = await window.tandem.bridgeInfo();
  state.mcpCommand = `claude mcp add tandem -- node ${info.mcp}`;
  state.bridgeUrl = info.url;
  $('#bridge-status').textContent = `bridge ${info.url.replace('http://127.0.0.1', 'loopback')}`;
  $('#bridge-dot').className = 'dot';
  $('#copy-mcp').onclick = copyMcpCommand;
  applyZoom(zoom);
  showPane(false);
  renderStrip();
  syncBounds();
  renderDrawer();
  icons();
})();
