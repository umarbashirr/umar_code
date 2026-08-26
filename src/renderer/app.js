import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { layout, onRelayout, registerActions, setLayout } from './ui/shell/layout-store.js';
import { toast } from './ui/shell/toast.jsx';
import { bridge, copyMcpCommand, loadBridge } from './ui/shell/bridge.js';
import { navigate, pickElement, toggleDrawer } from './ui/shell/browser-store.js';
import { DEFAULT_SCHEME, isScheme } from './ui/lib/themes.js';

export const $ = (sel) => document.querySelector(sel);

/* React renders the shell, and several of its components import from this file,
   which means this module is evaluated before there is any shell to query.
   Anything that reaches for a node registers here and runs from boot(), once
   React has committed. */
const wiring = [];
const wire = (fn) => wiring.push(fn);

const state = {
  tabs: [],
  active: null,
};

// Which panels are up is React's to render, so it lives in the layout store and
// these are a read-only view of it. Anything in here that wants a panel open
// calls setLayout; assigning to one of these throws, which is the point.
for (const key of ['railOpen', 'rightOpen', 'rightView', 'previewFull', 'panelOpen']) {
  Object.defineProperty(state, key, { get: () => layout[key], enumerable: true });
}

// A drag or a panel appearing changes how many CSS pixels the terminal and the
// preview have to work with. Neither notices on its own.
onRelayout(() => { resizeActive(); syncBounds(); });

// What the stores cannot do for themselves without importing this file back.
registerActions({ openPreview: () => openPreview(), toast });

// ------------------------------------------------------------- preferences

// The settings file, read synchronously through the preload bridge so the first
// paint is already the right theme at the right size. Main owns the file; this
// is a copy that is replaced whenever it changes, from here or from the
// settings page.
let prefs = {
  appearance: { theme: 'system', scheme: DEFAULT_SCHEME, zoom: 1 },
  terminal: { fontSize: 13, fontFamily: 'ui-monospace, monospace' },
  chat: { fontSize: 13, fontFamily: '' },
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

// Two attributes, one paint. data-theme is light or dark; data-scheme is which
// palette that light or dark is made of. Everything else in the app reads the
// custom properties those two select, so this function is the whole of theming.
function applyTheme() {
  const root = document.documentElement;
  root.dataset.theme = resolvedTheme();
  root.dataset.scheme = isScheme(prefs.appearance.scheme) ? prefs.appearance.scheme : DEFAULT_SCHEME;
  // xterm paints on a canvas and reads no stylesheet, so it has to be told.
  for (const t of state.tabs) t.term.options.theme = termTheme();
}

// The terminal's colours come from the same stylesheet as everything else, off
// the --term-* properties the scheme sets. Reading them back rather than
// keeping a copy here is what stops the panel's own chrome, which is styled
// from those properties, from drifting away from the canvas underneath it.
function termTheme() {
  const style = getComputedStyle(document.documentElement);
  const at = (name, fallback) => style.getPropertyValue(`--term-${name}`).trim() || fallback;
  return {
    background: at('bg', '#0b0d12'),
    foreground: at('fg', '#d7dce6'),
    cursor: at('cursor', '#6ea8fe'),
    selectionBackground: at('selection', '#2a3550'),
    black: at('black', '#171b26'),
    red: at('red', '#ef6a6a'),
    green: at('green', '#58d18a'),
    yellow: at('yellow', '#e5b567'),
    blue: at('blue', '#6ea8fe'),
    magenta: at('magenta', '#b58cf6'),
    cyan: at('cyan', '#5fd0d0'),
    white: at('white', '#d7dce6'),
  };
}

// The chat pane's own type. The size is a scale rather than a font-size: see
// the #agent-root rule in styles.css for why. 13 is what the transcript has
// always been drawn at, so it is the size everything else is measured from.
const CHAT_BASE = 13;
export const CHAT_SIZES = [11, 12, 13, 14, 15, 16, 18, 20];

function applyChat() {
  const root = document.documentElement;
  const size = prefs.chat?.fontSize || CHAT_BASE;
  root.style.setProperty('--chat-scale', String(size / CHAT_BASE));
  root.style.setProperty('--chat-font', prefs.chat?.fontFamily || 'inherit');
}

applyTheme();
applyChat();

// Following the system means following it while the window is open, not only at
// launch. Desktops that switch at sunset do it without telling the app twice.
try {
  matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => { if (prefs.appearance.theme === 'system') applyTheme(); });
} catch {}

// The toolbar button is two-state, so it pins whichever one is not showing.
// Getting back to following the system is the settings page's job.
export const toggleTheme = () => save({ appearance: { theme: resolvedTheme() === 'dark' ? 'light' : 'dark' } });

// 'system' is a preference; `resolved` is the colour it currently means.
export const themeState = () => ({ pref: prefs.appearance.theme, resolved: resolvedTheme() });

// Which palette is up. Guarded the same way applyTheme guards it: a
// settings.json naming a theme this build has never heard of reads as zinc
// rather than as nothing at all.
export const schemeState = () => (isScheme(prefs.appearance.scheme) ? prefs.appearance.scheme : DEFAULT_SCHEME);

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
  // Every measurement the layout makes is in CSS pixels, which just changed
  // size, so the terminal and the pane both need telling.
  requestAnimationFrame(() => { resizeActive(); syncBounds(); });
}

function applyZoom(next) {
  drawZoom(next);
  save({ appearance: { zoom } });
}

export const zoomLevel = () => zoom;
export const resetZoom = () => applyZoom(1);

export function stepZoom(dir) {
  const at = ZOOM_STEPS.indexOf(zoom);
  const next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, at + dir))];
  if (next !== zoom) applyZoom(next);
}


// One place the settings page and the toolbar both land, whichever made the
// change: main writes the file, then says so, and the shell redraws from that.
window.tandem.settings.onChanged((next) => {
  if (!next) return;
  const before = prefs;
  prefs = next;
  if (next.appearance.theme !== before.appearance.theme
    || next.appearance.scheme !== before.appearance.scheme) applyTheme();
  if (next.appearance.zoom !== zoom) drawZoom(next.appearance.zoom || 1);
  if (next.terminal.fontSize !== before.terminal.fontSize
    || next.terminal.fontFamily !== before.terminal.fontFamily) applyTerminalFont();
  if (next.chat?.fontSize !== before.chat?.fontSize
    || next.chat?.fontFamily !== before.chat?.fontFamily) applyChat();
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

let shellUid = 0;

function newTerminalTab(command) {
  openPanel();
  const host = document.createElement('div');
  host.className = 'term-host';
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
  term.loadAddon(new WebLinksAddon((_e, uri) => navigate(uri)));
  term.attachCustomKeyEventHandler((e) => !isAppChord(e));
  term.open(host);

  const tab = { id: null, uid: `shell-${++shellUid}`, term, fit, host, title: 'shell' };
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

// The shells, listed inside the panel they run in, the way a terminal names its
// own tabs. Nothing in the toolbar lists them, so the panel toggle next to it is
// how you get back to a shell you cannot see.
const shellListeners = new Set();
let shellVersion = 0;

export const getShellVersion = () => shellVersion;
export function subscribeShells(fn) {
  shellListeners.add(fn);
  return () => shellListeners.delete(fn);
}

// The shells, for the strip that lists them. xterm owns the host div under each
// one, so the panel renders the tabs and leaves #terms alone.
export const shells = () => state.tabs.map((tab, i) => ({
  uid: tab.uid,
  title: tab.title,
  index: i,
  active: tab === state.active,
}));

export const activateShell = (uid) => activate(state.tabs.find((t) => t.uid === uid));
export const closeShell = (uid) => closeTab(state.tabs.find((t) => t.uid === uid));
export const newShell = () => newTerminalTab();

function renderStrip() {
  shellVersion += 1;
  for (const fn of shellListeners) fn();
}

function activate(tab) {
  if (!tab) return;
  state.active = tab;
  for (const t of state.tabs) t.host.classList.toggle('active', t === tab);
  renderStrip();
  tab.term.focus();
  resizeActive();
}

function closeTab(tab) {
  if (!tab) return;
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

// ---------------------------------------------------------- terminal panel

function openPanel() {
  if (state.panelOpen) return;
  setLayout({ panelOpen: true });
  renderStrip();
  // The first open is what creates the shell: nothing is spawned until asked.
  if (!state.tabs.length) requestAnimationFrame(() => newTerminalTab());
  requestAnimationFrame(() => { resizeActive(); syncBounds(); });
}

function closePanel() {
  if (!state.panelOpen) return;
  setLayout({ panelOpen: false });
  renderStrip();
  requestAnimationFrame(syncBounds);
}

const togglePanel = () => {
  if (state.panelOpen) return closePanel();
  openPanel();
  requestAnimationFrame(() => state.active?.term.focus());
};

// -------------------------------------------------------------------- rail

const toggleRail = () => setLayout({ railOpen: !state.railOpen });

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
  setLayout({ rightOpen: true, rightView: view });
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
  setLayout({ rightOpen: false });
  window.tandemChanges?.deactivate();
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
  setLayout({ previewFull: next });
  if (next) showRight(state.rightView);
  requestAnimationFrame(() => { resizeActive(); syncBounds(); });
}

// The changes view is its own module and needs three things from the shell:
// the column, the tab strip it puts a count in, and the way to hand a file to
// the tree next door.
window.tandemStrip = () => setLayout({ changesCount: window.tandemChanges?.count() || 0 });
window.tandemOpenFile = (rel) => runCommand('openFile', rel);

// ---------------------------------------------------------------- toasts

export { toast } from './ui/shell/toast.jsx';

// ------------------------------------------------------------- agent feed

// The agent loading a page is a request to be looked at. What it did is drawn
// by the toolbar, which listens for the same thing.
window.tandem.agent.onActivity(({ tool }) => {
  if (tool === 'navigate') openPreview();
});

// ------------------------------------------------------------- commands

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
    case 'appearance': return window.tandemChat?.settings?.('appearance');
    case 'newChat': return window.tandemChat?.newChat();
    case 'copyMcp': return copyMcpCommand();
    case 'about': return toast(
      'Tandem',
      bridge.url ? `bridge ${bridge.url}` : '',
      [{ label: 'ok', primary: true }],
    );
    default: return undefined;
  }
}

window.tandem.onCommand(({ name, open }) => runCommand(name, open));

window.addEventListener('resize', () => { resizeActive(); syncBounds(); });
wire(() => new ResizeObserver(() => syncBounds()).observe($('#paneslot')));

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
  else if (mod && shift && k === 't') { e.preventDefault(); newTerminalTab(); }
  else if (mod && shift && k === 'k') { e.preventDefault(); document.querySelector('#agent-root textarea')?.focus(); }
  else if (mod && shift && k === 'l') { e.preventDefault(); openPreview(); $('#url')?.select(); $('#url')?.focus(); }
  else if (mod && shift && k === 'e') { e.preventDefault(); pickElement(); }
  else if (mod && shift && k === 'j') { e.preventDefault(); toggleDrawer(); }
  else if (mod && e.key >= '1' && e.key <= '9' && state.panelOpen) {
    const t = state.tabs[Number(e.key) - 1];
    if (t) { e.preventDefault(); activate(t); }
  }
});

// ---------------------------------------------------------------- boot

export async function boot() {
  for (const fn of wiring) fn();
  drawZoom(prefs.appearance.zoom || 1);

  await loadBridge();
  applyZoom(zoom);
  renderStrip();
  syncBounds();
}
