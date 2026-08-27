import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { layout, onRelayout, registerActions, setLayout } from './ui/shell/layout-store.js';
import { toast } from './ui/shell/toast.jsx';
import { bridge, copyMcpCommand, loadBridge } from './ui/shell/bridge.js';
import { navigate, pickElement, toggleDrawer } from './ui/shell/browser-store.js';
import {
  activateTab, activeKind, activeTab, carryInto, dropProject as dropTabs,
  openTab, previewTabs, projectDirs, subscribeTabs,
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
  // One set of shells per open folder, keyed by its path, and the folder the
  // panel is looking at. A shell belongs to the project it was opened in and
  // stays there, so the strip can show one folder's tabs while the others go on
  // working out of sight.
  projects: new Map(),
  focused: '',
};

// Which panels are up is React's to render, so it lives in the layout store and
// these are a read-only view of it. Anything in here that wants a panel open
// calls setLayout; assigning to one of these throws, which is the point.
for (const key of ['railOpen', 'rightOpen', 'previewFull', 'panelOpen']) {
  Object.defineProperty(state, key, { get: () => layout[key], enumerable: true });
}

// A drag or a panel appearing changes how many CSS pixels the terminal and the
// preview have to work with. Neither notices on its own.
onRelayout(() => { resizeActive(); syncPreview(); });

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
  for (const t of allTabs()) t.term.options.theme = termTheme();
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
  for (const t of allTabs()) {
    t.term.options.fontFamily = prefs.terminal.fontFamily;
    t.term.options.fontSize = prefs.terminal.fontSize;
  }
  requestAnimationFrame(resizeActive);
}

// --------------------------------------------------------------- terminals

/* Shells belong to the folder they were opened in. The window keeps a set of
   tabs per project, hands the strip whichever set is focused, and leaves the
   others running with their hosts hidden. Switching folders tears nothing down,
   so a build started in one project is still going, and still scrolled where
   you left it, when you come back. */

let shellUid = 0;

// The tabs for one folder, made the first time that folder needs them.
function shellsOf(dir) {
  let group = state.projects.get(dir);
  if (!group) {
    group = { dir, tabs: [], active: null };
    state.projects.set(dir, group);
  }
  return group;
}

// Null until the focused folder has opened a shell, which is most of the time
// for most folders, so every caller has to say what an empty panel means.
const focusedShells = () => state.projects.get(state.focused) || null;

function* allTabs() {
  for (const group of state.projects.values()) yield* group.tabs;
}

function tabById(id) {
  for (const tab of allTabs()) if (tab.id === id) return tab;
  return null;
}

// Whether a tab is still one of its folder's. Asked of the tab rather than of
// the group it was made in, because adoption moves a tab between groups and a
// shell that is still being spawned has to be found wherever it ended up.
const owns = (tab) => !!state.projects.get(tab.dir)?.tabs.includes(tab);

function newTerminalTab(command) {
  const dir = state.focused;
  const group = shellsOf(dir);
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

  const tab = { id: null, uid: `shell-${++shellUid}`, dir, term, fit, host, title: 'shell' };
  group.tabs.push(tab);

  window.tandem.term.create({ cols: term.cols, rows: term.rows, project: dir }).then(({ id, shell }) => {
    // The folder can be closed, or the tab closed by hand, while main is still
    // spawning. The pty is real by then, so it has to be killed rather than
    // forgotten.
    if (!owns(tab)) return window.tandem.term.kill(id);
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

// The focused folder's shells, for the strip that lists them, and only those:
// another project's shell in this strip is a tab that drops you into the wrong
// prompt. xterm owns the host div under each one, so the panel renders the tabs
// and leaves #terms alone.
export const shells = () => {
  const group = focusedShells();
  if (!group) return [];
  return group.tabs.map((tab, i) => ({
    uid: tab.uid,
    title: tab.title,
    index: i,
    active: tab === group.active,
  }));
};

export const activateShell = (uid) => activate(focusedShells()?.tabs.find((t) => t.uid === uid));
export const closeShell = (uid) => closeTab(focusedShells()?.tabs.find((t) => t.uid === uid));
export const newShell = () => newTerminalTab();

function renderStrip() {
  shellVersion += 1;
  for (const fn of shellListeners) fn();
}

// One terminal on screen: the focused folder's active tab. The rest keep their
// host in the DOM with nothing drawn, because a hidden xterm goes on reading its
// shell, and that is what lets a folder be looked away from without losing the
// command it is in the middle of.
function paint() {
  const shown = focusedShells();
  for (const group of state.projects.values()) {
    for (const tab of group.tabs) tab.host.classList.toggle('active', group === shown && tab === group.active);
  }
}

function activate(tab) {
  if (!tab) return;
  const group = state.projects.get(tab.dir);
  if (!group) return;
  group.active = tab;
  // A shell that finished spawning in a folder nobody is looking at is now that
  // folder's active tab and nothing more. Drawing it would put it on screen over
  // the project you are actually in.
  if (group !== focusedShells()) return;
  paint();
  renderStrip();
  tab.term.focus();
  resizeActive();
}

function closeTab(tab) {
  if (!tab) return;
  if (tab.id) window.tandem.term.kill(tab.id);
  tab.term.dispose();
  tab.host.remove();
  const group = state.projects.get(tab.dir);
  if (!group) return;
  group.tabs = group.tabs.filter((t) => t !== tab);
  if (group.active === tab) group.active = group.tabs[group.tabs.length - 1] || null;
  renderStrip();
  if (group.active) activate(group.active);
  else if (group === focusedShells()) closePanel(); // last shell closed: put the panel away rather than respawning
}

// The folder is gone and main has already killed its shells, so this is xterm
// and its nodes being let go of. Emptying the list first is what stops a shell
// still being spawned for it from coming back to an owner that has left.
function dropProject(dir) {
  const group = state.projects.get(dir);
  if (!group) return;
  const tabs = group.tabs;
  group.tabs = [];
  group.active = null;
  state.projects.delete(dir);
  for (const tab of tabs) {
    tab.term.dispose();
    tab.host.remove();
  }
}

function resizeActive() {
  const tab = focusedShells()?.active;
  if (!tab) return;
  try { tab.fit.fit(); } catch {}
}

window.tandem.term.onData(({ id, data }) => {
  tabById(id)?.term.write(data);
});

window.tandem.term.onExit(({ id }) => {
  const tab = tabById(id);
  if (tab) { tab.title = 'exited'; renderStrip(); tab.term.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n'); }
});

// ---------------------------------------------------------- terminal panel

function openPanel() {
  if (state.panelOpen) return;
  setLayout({ panelOpen: true });
  renderStrip();
  // The first open is what creates the shell: nothing is spawned until asked.
  // The count is read on the frame it runs on rather than now, because the call
  // that opened the panel is often a new shell that has yet to be pushed.
  requestAnimationFrame(() => { if (!focusedShells()?.tabs.length) newTerminalTab(); });
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
  requestAnimationFrame(() => focusedShells()?.active?.term.focus());
};

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

/* A shell opened in the gap before this window is told which folder it is
   looking at is filed under no dir at all. It is not homeless: main has a
   folder open the whole time, including the fallback to home when nobody chose
   one, and it rooted that shell there. The dir the first project:changed names
   is that same folder, so these tabs are not strays to throw away, they are
   this folder's tabs with the label missing. */
function adoptStrays(dir) {
  const strays = state.projects.get('');
  if (!strays) return;
  state.projects.delete('');
  for (const tab of strays.tabs) tab.dir = dir;

  const group = state.projects.get(dir);
  if (!group) {
    // Nothing to merge into, so the group keeps its identity and changes its
    // name. That is the whole of adoption in the case that actually happens.
    strays.dir = dir;
    state.projects.set(dir, strays);
    return;
  }

  // A folder cannot have tabs before it has been focused, so this is the arm
  // that never runs. If it ever does, the strays are the older shells and the
  // strip reads left to right in the order they were opened, so they go first,
  // and the one that was on screen is one of theirs and stays on screen.
  group.tabs = [...strays.tabs, ...group.tabs];
  group.active = strays.active || group.active;
}

/* `leaving` is what the column was reading in the folder being left. It is a
   parameter because the folder can be leaving by closing, in which case its
   tabs are gone by the time this runs and the caller is the only one that still
   knows. */
function focusProject(dir, leaving = activeKind(state.focused)) {
  if (dir === state.focused) return;
  // The one move that is a renaming rather than a switch: nothing was showing
  // another folder, the folder just got its name.
  if (dir && !state.focused) adoptStrays(dir);
  state.focused = dir;
  paint();
  renderStrip();
  /* The column swaps to this folder's strip, and a folder that has never had
     one takes the kind you were reading. Coming to a project to look at what an
     agent did there and landing on an empty column with three buttons in it is
     a step nobody wants to take twice. carryInto does nothing when the column
     is shut, so a folder you never open it on keeps costing nothing. */
  if (dir) carryInto(dir, leaving);
  syncRight();
  const group = focusedShells();
  // A folder with no shell yet gets one, on the same reasoning as opening the
  // panel: a panel showing an empty strip is a black box with nothing to do.
  if (state.panelOpen && !group?.tabs.length) { newTerminalTab(); return; }
  requestAnimationFrame(() => {
    resizeActive();
    // This tab may have been hidden for a while with its shell printing the
    // whole time, and fit() only repaints when the grid changed size, so the
    // repaint is asked for outright. Read again rather than closed over: focus
    // can move twice inside one frame.
    const tab = focusedShells()?.active;
    if (tab) tab.term.refresh(0, tab.term.rows - 1);
  });
}

window.tandem.project.onChanged((info) => {
  if (!info) return;
  const open = new Set((info.projects || []).map((p) => p.dir));
  // Read before the drop below, because the folder closing can be the one whose
  // diff is on screen, and the folder focus lands on should show its own.
  const leaving = activeKind(state.focused);
  // Shells and tabs are held per folder and neither list is the other: a folder
  // can have a tree open and no shell, or a shell and nothing in the column.
  const known = new Set([...state.projects.keys(), ...projectDirs()]);
  for (const dir of known) {
    // The empty dir is not a folder that can close, it is the startup gap, and
    // the first real focus adopts whatever is filed under it.
    if (!dir || open.has(dir)) continue;
    dropProject(dir);
    // The tabs go with the folder. Letting go of the native views behind them is
    // the reconciler's, which sees these leave the same way it sees a tab closed
    // by hand.
    dropTabs(dir);
    lastPreview.delete(dir);
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
  const r = $('#paneslot').getBoundingClientRect();
  window.tandem.browser.setBounds(inWindowPixels({ x: r.x, y: r.y, width: r.width, height: r.height }));
}

// --------------------------------------------------------- right column

/* The column holds a strip of tabs, each one a preview, the file tree or the
   diff, and the tabs belong to a folder the way the shells do. rightOpen says
   whether the strip is on screen and nothing more. The tabs go on existing
   while it is shut, which is what lets a button put the column away and bring
   the same page back. */

/* The preview a folder comes back to. It can have several, and neither the
   toolbar button nor an agent says which one it means, so it is the last one
   that was on screen. The store knows what is active now rather than what was
   active last, so that is remembered here. */
const lastPreview = new Map();

function previewFor(dir) {
  const open = previewTabs(dir);
  if (!open.length) return null;
  const last = lastPreview.get(dir);
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
  const tab = state.rightOpen ? activeTab(dir) : null;
  if (tab?.kind === 'browser') lastPreview.set(dir, tab.id);
  const kind = tab?.kind || null;
  if (kind !== showing) {
    showing = kind;
    if (kind === 'files') window.tandemFiles?.activate();
  }
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
  const held = kind === 'browser' ? previewFor(dir) : null;
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
  if (focusUrl && !state.paneLive) requestAnimationFrame(() => { $('#url').focus(); $('#url').select(); });
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
   thing. Without this the agent's page is live with nothing to click. */
window.tandem.browser.onOpenTab(({ project, tab }) => {
  // The column is only brought up if this is the folder on screen. An agent
  // working somewhere you are not looking at gets its tab made and waiting.
  if (project && tab) openTab(project, 'browser', tab, { reveal: project === state.focused });
});

// ------------------------------------------------------------- commands

// One place the menu bar, the native menu and the keyboard all go through.
export function runCommand(name, arg) {
  switch (name) {
    case 'preview':
      if (arg === true) return openPreview();
      if (arg === false) return hidePreview();
      return togglePreview();
    case 'newPreview': return newPreview();
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
    const t = focusedShells()?.tabs[Number(e.key) - 1];
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
  syncRight();
}
