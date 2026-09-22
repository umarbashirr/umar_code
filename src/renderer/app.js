import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { layout, onRelayout, registerActions, setLayout } from './ui/shell/layout-store.js';
import { toast } from './ui/shell/toast.jsx';
import { bridge, copyMcpCommand, loadBridge } from './ui/shell/bridge.js';
import { navigate, pickElement, toggleDrawer, guestWanted, previewOf, parseViewport, frameBox } from './ui/shell/browser-store.js';
import { isPaneCovered } from './ui/shell/pane-cover.js';
import {
  activateTab, activeKind, activeTab, carryInto, dropProject as dropTabs,
  openTab, projectDirs, setTabTitle, subscribeTabs, tabsOf,
} from './ui/shell/tabs-store.js';
import { DEFAULT_SCHEME, isScheme } from './ui/lib/themes.js';

export const $ = (sel) => document.querySelector(sel);

/* React renders the shell, and several of its components import from this file,
   which means this module is evaluated before there is any shell to query.
   Anything that reaches for a node registers here and runs from boot(), once
   React has committed. */
const wiring = [];
const wire = (fn) => wiring.push(fn);

const state = {
  // The folder the window is looking at. Its tabs are the ones in the column.
  focused: '',
};

// Up here rather than with the rest of the terminal code: the theme is applied
// while this module is still loading, and it repaints every shell there is.
const shells = new Map(); // terminal tab id -> { tabId, dir, id, term, fit, host }

// Which panels are up is React's to render, so it lives in the layout store and
// these are a read-only view of it. Anything in here that wants a panel open
// calls setLayout; assigning to one of these throws, which is the point.
for (const key of ['railOpen', 'rightOpen', 'previewFull']) {
  Object.defineProperty(state, key, { get: () => layout[key], enumerable: true });
}

// A drag or a panel appearing changes how many CSS pixels the terminal and the
// preview have to work with. Neither notices on its own.
onRelayout(() => { resizeActive(); syncPreview(); });

// What the stores cannot do for themselves without importing this file back.
registerActions({
  openPreview: () => openPreview(),
  toast,
  syncGuestVisibility,
  syncPreviewBounds: () => syncBounds(),
});

function syncGuestVisibility() {
  if (isPaneCovered()) return;
  window.tandem.browser.setVisible(guestWanted());
}

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
  for (const t of shells.values()) t.term.options.theme = termTheme();
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
  for (const t of shells.values()) {
    t.term.options.fontFamily = prefs.terminal.fontFamily;
    t.term.options.fontSize = prefs.terminal.fontSize;
  }
  requestAnimationFrame(resizeActive);
}

// --------------------------------------------------------------- terminals

/* A shell is a tab in the right column, filed under its folder the way a
   preview is. tabs-store says which terminal tabs there are and which one is on
   screen; this holds an xterm and a pty for each and keeps the two in step: a
   terminal tab with no shell gets one, and a shell whose tab has gone is
   killed. Switching folders tears nothing down, so a build started in one
   project is still going, and still scrolled where you left it, when you come
   back. */

// What to type into a shell once it is up. Sent as keystrokes rather than run
// for you: the line is visible, and an interactive flow like `claude mcp login`
// needs a real terminal anyway.
const typeOnStart = new Map();

function spawnShell(dir, tabId) {
  const box = $('#terms');
  if (!box) return;
  const host = document.createElement('div');
  host.className = 'term-host';
  box.appendChild(host);

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

  const shell = { tabId, dir, id: null, term, fit, host };
  shells.set(tabId, shell);

  window.tandem.term.create({ cols: term.cols, rows: term.rows, project: dir }).then(({ id, shell: name }) => {
    // The tab can be closed, or its folder, while main is still spawning. The
    // pty is real by then, so it has to be killed rather than forgotten.
    if (shells.get(tabId) !== shell) return window.tandem.term.kill(id);
    shell.id = id;
    if (name) setTabTitle(dir, tabId, name);
    term.onData((d) => window.tandem.term.input(id, d));
    term.onResize(({ cols, rows }) => window.tandem.term.resize(id, cols, rows));
    const command = typeOnStart.get(tabId);
    typeOnStart.delete(tabId);
    if (command) window.tandem.term.input(id, command + '\n');
    setTimeout(resizeActive, 30);
  });
}

function disposeShell(shell) {
  shells.delete(shell.tabId);
  typeOnStart.delete(shell.tabId);
  if (shell.id) window.tandem.term.kill(shell.id);
  shell.term.dispose();
  shell.host.remove();
}

// Every terminal tab in every folder, against every shell held. Run on each
// change to the tabs, which is also how a folder closing takes its shells.
function reconcileShells() {
  const wanted = new Set();
  for (const dir of projectDirs()) {
    for (const tab of tabsOf(dir)) {
      if (tab.kind !== 'terminal') continue;
      wanted.add(tab.id);
      if (!shells.has(tab.id)) spawnShell(dir, tab.id);
    }
  }
  for (const shell of [...shells.values()]) if (!wanted.has(shell.tabId)) disposeShell(shell);
}

// The shell on screen: the focused folder's active tab, when that tab is a
// terminal and the column is up. The rest keep their host with nothing drawn,
// because a hidden xterm goes on reading its shell.
const shownShell = () => (state.rightOpen ? shells.get(activeTab(state.focused)?.id) : null) || null;

// Answers whether a shell has just come on screen, which is a shell you are
// about to type into. What was painted last is the only record of that: the
// store has moved on by the time anyone asks.
let painted = null;

function paintShells() {
  const shown = shownShell();
  for (const shell of shells.values()) shell.host.classList.toggle('active', shell === shown);
  const arrived = !!shown && shown !== painted;
  painted = shown;
  return arrived;
}

function newTerminalTab(command) {
  const dir = state.focused;
  // Opening the tab is what spawns the shell: the store says a terminal is
  // wanted and reconcileShells answers it. The command is read once the pty is
  // up, which is always after this returns.
  const tab = openTab(dir, 'terminal');
  if (command) typeOnStart.set(tab.id, command);
  syncRight();
  requestAnimationFrame(() => { syncBounds(); resizeActive(); });
}

export const focusShell = () => shownShell()?.term.focus();

function resizeActive() {
  const shell = shownShell();
  if (!shell) return;
  try { shell.fit.fit(); } catch {}
}

const shellByPty = (id) => [...shells.values()].find((s) => s.id === id);

window.tandem.term.onData(({ id, data }) => {
  shellByPty(id)?.term.write(data);
});

window.tandem.term.onExit(({ id }) => {
  const shell = shellByPty(id);
  if (!shell) return;
  setTabTitle(shell.dir, shell.tabId, 'exited');
  shell.term.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n');
});

// --------------------------------------------------------- project focus

/* One window, several folders, one panel. Focus decides which folder's shells
   the strip lists and which terminal is on screen; it decides nothing else, and
   in particular it stops nothing. Moving focus is two class toggles and a
   redraw.

   project:changed also fires when a folder is opened, closed or reordered, so
   the focused dir is compared against the last one seen and the panel is left
   alone when it has not moved. Folders that have gone away are dropped first,
   because main has killed their shells and their tabs would otherwise sit in
   the map for the life of the window. */

/* `leaving` is what the column was reading in the folder being left. It is a
   parameter because the folder can be leaving by closing, in which case its
   tabs are gone by the time this runs and the caller is the only one that still
   knows. */
function focusProject(dir, leaving = activeKind(state.focused)) {
  if (dir === state.focused) return;
  state.focused = dir;
  /* The column swaps to this folder's strip, and a folder that has never had
     one takes the kind you were reading. Coming to a project to look at what an
     agent did there and landing on an empty column with three buttons in it is
     a step nobody wants to take twice. carryInto does nothing when the column
     is shut, so a folder you never open it on keeps costing nothing. */
  if (dir) carryInto(dir, leaving);
  syncRight();
  requestAnimationFrame(() => {
    resizeActive();
    // This shell may have been hidden for a while and printing the whole time,
    // and fit() only repaints when the grid changed size, so the repaint is
    // asked for outright. Read again rather than closed over: focus can move
    // twice inside one frame.
    const shell = shownShell();
    if (shell) shell.term.refresh(0, shell.term.rows - 1);
  });
}

window.tandem.project.onChanged((info) => {
  if (!info) return;
  const open = new Set((info.projects || []).map((p) => p.dir));
  // Read before the drop below, because the folder closing can be the one whose
  // diff is on screen, and the folder focus lands on should show its own.
  const leaving = activeKind(state.focused);
  const known = new Set(projectDirs());
  for (const dir of known) {
    // The empty dir is not a folder that can close, it is the startup gap, and
    // the first real focus adopts whatever is filed under it.
    if (!dir || open.has(dir)) continue;
    // The tabs go with the folder, and its shells with them. Letting go of the native views behind them is
    // the reconciler's, which sees these leave the same way it sees a tab closed
    // by hand.
    dropTabs(dir);
    for (const kind of HELD) lastSeen.delete(`${kind}:${dir}`);
  }
  focusProject(info.focused || '', leaving);
});

(async () => {
  try { focusProject((await window.tandem.project.info())?.focused || ''); } catch {}
})();

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

/* The preview that belongs in the box: the focused folder's active tab, when
   that tab is a preview and the column is on screen. Null the rest of the time,
   since the tree and the diff draw HTML in that same slot, and the previews the
   other folders are holding stay where they are. */
function previewInBox() {
  if (!state.rightOpen) return null;
  const tab = activeTab(state.focused);
  return tab?.kind === 'browser' ? tab.id : null;
}

/* Main paints one preview into the box and has to be told which, since a folder
   can have several. Said again only when the answer changes: naming the same
   tab twice pulls the view out of the window and puts it back for nothing. */
let named = null;

function syncPreview() {
  const id = previewInBox();
  if (id !== named) {
    named = id;
    window.tandem.browser.show(id);
  }
  syncBounds();
  syncGuestVisibility();
}

function syncBounds() {
  // The tree and the diff sit where the pane would be, so a tab that is not a
  // preview parks the pane the same way a modal does.
  if (previewParked || !previewInBox()) {
    // Park it just outside the window instead of hiding it. A hidden view stops
    // laying out, and the agent would get a 0x0 page while the pane is closed.
    window.tandem.browser.setBounds(inWindowPixels({
      x: window.innerWidth + 40, y: 40,
      width: window.innerWidth * 0.5,
      height: Math.max(240, window.innerHeight - 96),
    }));
    return;
  }
  const slot = $('#paneslot');
  if (!slot) return;
  const r = slot.getBoundingClientRect();
  let box = { x: r.x, y: r.y, width: r.width, height: r.height };

  // A fixed viewport is the page's layout size. Stretching that page to fill
  // the slot is what made phone mode look unresponsive: the CSS thought it was
  // 390px wide while the pixels were 900. The guest goes in the device frame
  // instead, and main scales the page to whatever size the frame came out.
  const tab = previewInBox();
  const page = previewOf(tab);
  const dims = page.live && !page.error ? parseViewport(page.viewport) : null;
  if (dims && r.width > 0 && r.height > 0) {
    const f = frameBox(r, dims, page.hold);
    box = { x: r.x + f.x, y: r.y + f.y, width: f.width, height: f.height };
  }

  window.tandem.browser.setBounds(inWindowPixels(box));
}

// --------------------------------------------------------- right column

/* The column holds a strip of tabs, each one a preview, the file tree or the
   diff, and the tabs belong to a folder the way the shells do. rightOpen says
   whether the strip is on screen and nothing more. The tabs go on existing
   while it is shut, which is what lets a button put the column away and bring
   the same page back. */

/* The preview or the shell a folder comes back to. It can have several of
   each, and neither the toolbar button nor an agent says which one it means,
   so it is the last one that was on screen. The store knows what is active now
   rather than what was active last, so that is remembered here. */
const HELD = ['browser', 'terminal'];
const lastSeen = new Map(); // `${kind}:${dir}` -> tab id

function heldTab(dir, kind) {
  const open = tabsOf(dir).filter((t) => t.kind === kind).map((t) => t.id);
  if (!open.length) return null;
  const last = lastSeen.get(`${kind}:${dir}`);
  return open.includes(last) ? last : open[open.length - 1];
}

/* Everything the column has to be told after a tab changes, focus moves or the
   column opens and shuts: which view is reading, which preview is in the box,
   and where the box is.

   The kind on screen is kept so the tree is told when it arrives and not on
   every bump the store makes. The diff is not told anything from here at all:
   ChangesView turns its own store on and off from whether it is the active tab,
   and a second caller would have it read the whole tree twice on every switch. */
let showing = null;

function syncRight() {
  const dir = state.focused;
  reconcileShells();
  const tab = state.rightOpen ? activeTab(dir) : null;
  if (HELD.includes(tab?.kind)) lastSeen.set(`${tab.kind}:${dir}`, tab.id);
  const kind = tab?.kind || null;
  if (kind !== showing) {
    showing = kind;
    if (kind === 'files') window.tandemFiles?.activate();
  }
  if (paintShells()) requestAnimationFrame(() => { resizeActive(); focusShell(); });
  syncPreview();
}

// A tab can be activated or closed from the strip, and main opens one of its
// own when an agent puts a page up, so the store is the thing to listen to
// rather than each of the callers.
subscribeTabs(syncRight);

/* Open the column on a tab of this kind and go to it. A folder has one tree and
   one diff, so those land back on the tab it already had. The preview is the
   odd one out: the button does not name one, so it returns to the last preview
   read in this folder and mints a new one only when there is none. */
function showRight(kind) {
  const dir = state.focused;
  const held = HELD.includes(kind) ? heldTab(dir, kind) : null;
  if (held) {
    setLayout({ rightOpen: true });
    activateTab(dir, held);
  } else if (!openTab(dir, kind)) return;
  syncRight();
  // The column has to lay out before #paneslot has a box worth handing over.
  requestAnimationFrame(() => { syncBounds(); resizeActive(); });
}

/* A preview the person asked for outright, from the plus on the strip. The
   toolbar button means "show me the preview" and goes back to the one you were
   reading; this means "another one", which is the whole reason a folder can
   hold several. Nothing else in the column can be opened twice, so nothing else
   needs this. */
function newPreview() {
  const dir = state.focused;
  if (!openTab(dir, 'browser')) return;
  syncRight();
  requestAnimationFrame(() => { syncBounds(); resizeActive(); });
}

/* Put the column away and leave the strip alone. A tab is a page you were
   reading or a tree you expanded four folders deep, and none of that should go
   because you wanted the chat wider for a minute. Closing a tab is the tab's
   own business, and the store shuts the column itself when the last one goes,
   so the two never have to be done together. */
function hideRight() {
  if (!state.rightOpen) return;
  // Both panes hidden at once is a blank window, so putting the column away
  // gives the chat its half back first.
  setPreviewFull(false);
  setLayout({ rightOpen: false });
  syncRight();
  requestAnimationFrame(resizeActive);
}

function openPreview(focusUrl = false) {
  showRight('browser');
  if (!focusUrl) return;
  // The address bar only mounts after React commits a visible browser toolbar.
  const focus = () => {
    const box = $('#url');
    if (!box) return false;
    box.focus();
    box.select();
    return true;
  };
  if (focus()) return;
  requestAnimationFrame(() => {
    if (focus()) return;
    setTimeout(focus, 50);
  });
}

// Asked to hide the preview while the tree or the diff is showing, there is no
// preview on screen to hide, so the column stays where it is.
function hidePreview() {
  if (activeKind(state.focused) === 'browser') hideRight();
}

/* Pressing a button whose tab is already the one showing puts the column away
   and leaves that tab in the strip, so the same page or the same diff is there
   on the next press. Pressed on any other tab it goes to that kind, which is
   the commoner thing to want and costs one press to undo. */
const toggleRight = (kind) => (state.rightOpen && activeKind(state.focused) === kind ? hideRight() : showRight(kind));
const togglePreview = () => (state.rightOpen && activeKind(state.focused) === 'browser' ? hideRight() : openPreview(true));
const toggleFiles = () => toggleRight('files');
const toggleChanges = () => toggleRight('changes');

// The right column at full width: the chat collapses to nothing and whichever
// tab is showing takes the whole content column. The rail is deliberately left
// alone, so a sidebar that was open stays open, and closing it hands the last of
// the window over to the page.
function setPreviewFull(on) {
  const next = on === undefined ? !state.previewFull : !!on;
  if (next === state.previewFull) return;
  setLayout({ previewFull: next });
  // Full width with nothing in the strip is a blank half window, so a folder
  // that has never opened the column gets a preview to fill it.
  if (next) showRight(activeKind(state.focused) || 'browser');
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
/* An agent navigating puts its page on screen. Main brings that agent's folder
   forward first, so by the time this lands the folder is usually the focused
   one and the column opens on the right page. The guard is for when it is not:
   a folder that has since been closed, or a navigate that raced a switch. A
   column yanked open on another folder's tab is worse than one that stayed
   shut, because it is the wrong page under the right heading. */
window.tandem.agent.onActivity(({ tool, project }) => {
  if (tool !== 'navigate') return;
  if (project && project !== state.focused) return;
  openPreview();
});

/* An agent asking for a preview in a folder that has none is answered by main,
   which mints the id and has a page loading on it before it says anything. The
   tab is opened under that same id, so the strip and the native view are the one
   thing. That is browser-store's job: it hears the same event, and it is the
   half that also files the tab under its folder. Answering it here too put two
   rows in the strip wearing one id, and closing either took the other's page. */

// ------------------------------------------------------------- commands

// One place the menu bar, the native menu and the keyboard all go through.
export function runCommand(name, arg) {
  switch (name) {
    case 'preview':
      if (arg === true) return openPreview();
      if (arg === false) return hidePreview();
      return togglePreview();
    case 'newPreview': return newPreview();
    // The palette lives in the React half and registers itself on the window,
    // the way the settings dialog does.
    case 'palette': return window.tandemPalette?.toggle();
    case 'previewFull':
      if (arg === true || arg === false) return setPreviewFull(arg);
      return setPreviewFull();
    case 'files':
      if (arg === true) return showRight('files');
      if (arg === false) return hideRight();
      return toggleFiles();
    case 'changes':
      if (arg === true) return showRight('changes');
      if (arg === false) return hideRight();
      return toggleChanges();
    case 'openFile':
      if (!arg) return undefined;
      showRight('files');
      return window.tandemFiles?.open(String(arg));
    case 'zoomIn': return stepZoom(1);
    case 'zoomOut': return stepZoom(-1);
    case 'zoomReset': return applyZoom(1);
    case 'terminal':
      if (arg === true) return showRight('terminal');
      if (arg === false) return hideRight();
      return toggleRight('terminal');
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
  if (mod && e.shiftKey && ['b', 'd', 'g', 't', 'l', 'e', 'j', 's', 'k', 'p'].includes(k)) return true;
  if (mod && k === '`') return true;
  if (mod && !e.shiftKey && k.length === 1 && k >= '1' && k <= '9') return true;
  return false;
}

window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const shift = e.shiftKey;
  const k = (e.key || '').toLowerCase();
  if (mod && k === '`') { e.preventDefault(); runCommand('terminal'); }
  else if (mod && shift && k === 'b') { e.preventDefault(); togglePreview(); }
  else if (mod && shift && k === 'd') { e.preventDefault(); toggleFiles(); }
  else if (mod && shift && k === 'g') { e.preventDefault(); toggleChanges(); }
  else if (mod && shift && k === 't') { e.preventDefault(); newTerminalTab(); }
  else if (mod && shift && k === 'k') { e.preventDefault(); document.querySelector('#agent-root [contenteditable="true"]')?.focus(); }
  else if (mod && shift && k === 'l') { e.preventDefault(); openPreview(true); }
  else if (mod && shift && k === 'e') { e.preventDefault(); pickElement(); }
  else if (mod && shift && k === 'j') { e.preventDefault(); toggleDrawer(); }
  else if (mod && e.key >= '1' && e.key <= '9' && shownShell()) {
    const t = tabsOf(state.focused).filter((tab) => tab.kind === 'terminal')[Number(e.key) - 1];
    if (t) { e.preventDefault(); activateTab(state.focused, t.id); }
  }
});

// ---------------------------------------------------------------- boot

export async function boot() {
  for (const fn of wiring) fn();
  drawZoom(prefs.appearance.zoom || 1);

  await loadBridge();
  applyZoom(zoom);
  syncRight();
}
