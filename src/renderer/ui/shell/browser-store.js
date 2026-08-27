/* Everything a preview knows about the page it is showing: the address, whether
   it loaded, what it logged, and what the network did.

   The pane itself is a native view the window paints over this document, so
   none of it is readable from here. Main sends it across and this is where it
   lands.

   A folder can have several previews open at once, one per preview tab in its
   strip, so this is a record per tab. Tab ids are minted once for the life of
   the window and never reused, which is what makes them safe to key on: a
   record can never be handed the page of some tab that came before it. Main
   keys its native views off the same ids, so the two halves agree without
   either one keeping a table of the other's names.

   `browserState` is the preview the chrome speaks for, which is whichever one
   the focused folder is reading. The rest are parked and still running, and
   what they say still lands here: a build error a tab logged while you were
   reading another one is in its console when you click over to it. */
'use strict';
import { layout, setLayout, subscribe as subscribeLayout } from './layout-store.js';
import { activateTab, activeTab, openTab, previewTabs, setTabTitle, subscribeTabs } from './tabs-store.js';
import { toast } from './toast.jsx';

const blank = () => ({
  // The address bar is split so that http:// can be shown as a warning and
  // https:// left off entirely.
  scheme: '',
  url: '',
  canGoBack: false,
  canGoForward: false,
  // A page is "live" once something other than about:blank is loaded.
  live: false,
  status: '',
  error: null,
  console: [],
  network: [],
  drawerOpen: false,
  drawerTab: 'console',
  viewport: '',
  picking: false,
});

const byTab = new Map(); // tab id -> record
const ownerOf = new Map(); // tab id -> the folder whose strip that tab is in

// Whether a local server the terminal printed opens without asking. That is an
// answer about the folder rather than about one of its previews, so it is not
// in the records: saying "always" once and having a second preview tab ask you
// again would read as the setting not taking.
const autoOpen = new Set();

// The preview each folder was last reading. Flipping to the diff and hitting
// the drawer key should go back to the preview you were on, not to the first
// one in the strip.
const lastPreview = new Map();

let focusedDir = '';
let shown = null; // the tab main has in the box
let current = null; // the tab browserState points at
let drawn = ''; // what the chrome was last told about those two

// A window with nothing previewed anywhere still has a status bar. Nothing ever
// writes to this one.
const idle = blank();

export let browserState = idle;

function recordOf(tab) {
  let s = byTab.get(tab);
  if (!s) { s = blank(); byTab.set(tab, s); }
  return s;
}

/* Reading a tab that may not have said anything yet, which is every tab for the
   first second of its life. The blank is shared and never written to, so a
   frame drawing a tab with no record draws an empty page rather than the page
   of whatever tab is current. */
export const previewOf = (tab) => (tab && byTab.get(tab)) || idle;

const listeners = new Set();
let version = 0;

export const getBrowserVersion = () => version;

export function subscribeBrowser(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// A page that logs in a loop used to repaint the drawer per message, and did it
// while the drawer was closed and nobody could see it. Coalesce to one repaint
// per frame.
let queued = false;
function changed({ soon = false } = {}) {
  version += 1;
  if (!soon) {
    for (const fn of listeners) fn();
    return;
  }
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    for (const fn of listeners) fn();
  });
}

export const consoleErrors = (tab = current) => previewOf(tab).console.filter((c) => c.level === 'error').length;

// ------------------------------------------------------- which one is where

/* The preview in the box. There is one box and one native view allowed in it,
   so this is the focused folder's active tab and only when that tab is a
   preview at all. Everything else main parks offscreen, where it goes on
   loading. */
export function onScreen() {
  if (!layout.rightOpen) return null;
  const tab = activeTab(focusedDir);
  return tab?.kind === 'browser' ? tab.id : null;
}

/* The preview the address bar, the drawer key and the status bar speak for. It
   outlives what is in the box: reading a folder's diff does not make its
   preview stop being the page that folder is on. */
function currentOf(dir) {
  const tab = activeTab(dir);
  if (tab?.kind === 'browser') return tab.id;

  const open = previewTabs(dir);
  const last = lastPreview.get(dir);
  if (last && open.includes(last)) return last;
  return open[0] || null;
}

// Every preview the window knows about, in the order they were opened. The view
// draws one frame each, including the folders nobody is looking at, so that a
// half-typed address survives a trip to another project.
export const previews = () => [...ownerOf].map(([tab, dir]) => ({ tab, dir }));

/* A tab that left the strip takes its native view with it, and a
   WebContentsView nobody disposes stays in the window with its debugger
   attached. Watching the strip rather than waiting to be told means the close
   button, a folder closing and anything else that drops a tab all arrive here
   by the same road. */
function reap() {
  const live = new Set(previewTabs(focusedDir));
  for (const [tab, dir] of ownerOf) {
    if (dir === focusedDir && !live.has(tab)) forget(tab);
  }
}

function forget(tab) {
  ownerOf.delete(tab);
  byTab.delete(tab);
  window.tandem.browser.closeTab(tab);
}

/* One place decides which preview is in the box and which one the chrome is
   drawing. Tab changes, focus moves and the column opening or shutting all come
   in here, so no caller has to remember to say. Running it when nothing moved
   costs a map walk and sends nothing. */
function syncPreview() {
  // A tab the user opened from the strip has never spoken, so this is where
  // most previews are first heard of.
  for (const tab of previewTabs(focusedDir)) ownerOf.set(tab, focusedDir);
  reap();

  const box = onScreen();
  if (box !== shown) {
    shown = box;
    window.tandem.browser.show(box);
  }
  if (box) lastPreview.set(focusedDir, box);

  const now = currentOf(focusedDir);
  if (now !== current) {
    current = now;
    browserState = now ? recordOf(now) : idle;
    // A network fetch still out for the preview we just left would otherwise
    // land in this one's drawer.
    fetchSeq += 1;
  }

  // The chrome reads all three of these, not only the record: which frame is on
  // screen and which frames exist at all are answered out of this file too.
  const mark = `${shown} ${current} ${[...ownerOf.keys()]}`;
  if (mark === drawn) return;
  drawn = mark;
  changed();
}

/* Bring a preview forward: its folder's strip goes to it and the column opens.
   A folder you are not looking at does not get to do this, so its errors and
   its loads wait for you rather than pulling the column off the folder in
   front. */
function reveal(tab) {
  if (!tab || ownerOf.get(tab) !== focusedDir) return;
  activateTab(focusedDir, tab);
  if (!layout.rightOpen) setLayout({ rightOpen: true });
  syncPreview();
}

// ------------------------------------------------------------- navigation

/* An address that named a folder rather than a tab: `tandem go 3000` typed in a
   shell, a dev server printing itself, the command palette. It goes to the
   preview that folder is reading and opens one if the folder has none. */
export function navigate(url, project) {
  return navigateTab(url, previewIn(project || focusedDir));
}

function previewIn(dir) {
  const held = currentOf(dir);
  if (held) return held;

  // Opening a tab opens the column, which is right when the address is for the
  // folder in front of you and wrong when it came from one behind it.
  const wasOpen = layout.rightOpen;
  const tab = openTab(dir, 'browser');
  if (!tab) return null;
  ownerOf.set(tab.id, dir);
  if (!wasOpen && dir !== focusedDir) setLayout({ rightOpen: false });
  syncPreview();
  return tab.id;
}

export async function navigateTab(url, tab) {
  if (!tab) return;
  const b = recordOf(tab);
  b.url = url;
  reveal(tab);
  if (b === browserState) changed();
  // The folder goes with it. A URL a shell printed in a folder nobody is
  // looking at reaches main before the strip has had a chance to name that tab,
  // and a page filed under the wrong folder would go when that one closed.
  await window.tandem.browser.action('navigate', url, tab, ownerOf.get(tab));
}

// Omitting the tab means the one on screen, which is the only one a button you
// can click belongs to.
export const go = (action, tab) => window.tandem.browser.action(action, undefined, tab);

// ------------------------------------------------------------------ drawer

/* The single way in: the tab strip, Ctrl+Shift+J, the menu and Show Details on
   a failed load all land here. They each used to open the drawer their own way,
   and the three orderings disagreed about when the pane got remeasured. */
let fetchSeq = 0;

export async function showDrawer(which, tab = current) {
  if (!tab) return;
  const b = recordOf(tab);
  reveal(tab);
  b.drawerTab = which || b.drawerTab;
  b.drawerOpen = true;
  // The rows still in the body belong to whatever was open last, and they would
  // sit there in plain sight while the fetch is out.
  if (b.drawerTab === 'network') b.network = [];
  changed();

  // Stamped on every open, not only the ones that fetch, so clicking straight
  // over to the console retires a network fetch that is still out instead of
  // letting it land behind the tab that replaced it.
  const seq = ++fetchSeq;
  if (b.drawerTab !== 'network') return;

  const rows = await window.tandem.browser.action('network', undefined, tab).catch(() => []);
  if (seq !== fetchSeq || !b.drawerOpen) return;
  b.network = Array.isArray(rows) ? rows : [];
  changed();
}

export function hideDrawer(tab = current) {
  const b = previewOf(tab);
  if (!b.drawerOpen) return;
  b.drawerOpen = false;
  changed();
}

export const toggleDrawer = () => (browserState.drawerOpen ? hideDrawer() : showDrawer());

export function clearLogs(tab = current) {
  const b = previewOf(tab);
  b.console = [];
  b.network = [];
  changed();
}

// ---------------------------------------------------------------- viewport

export const VIEWPORTS = [
  { size: '', label: 'Fit the pane', icon: 'scan' },
  { size: '390x844', label: 'Phone', note: '390 × 844', icon: 'smartphone' },
  { size: '768x1024', label: 'Tablet', note: '768 × 1024', icon: 'tablet' },
  { size: '1280x800', label: 'Laptop', note: '1280 × 800', icon: 'laptop' },
  { size: '1920x1080', label: 'Desktop', note: '1920 × 1080', icon: 'monitor' },
];

// A viewport belongs to the preview it was chosen in: the phone frame you put
// the marketing page in is no reason to shrink the admin page beside it.
export function setViewport(size, tab = current) {
  if (!tab) return undefined;
  recordOf(tab).viewport = size;
  changed();
  if (!size) return window.tandem.browser.action('setViewport', null, tab);
  const [width, height] = size.split('x').map(Number);
  return window.tandem.browser.action('setViewport', { width, height }, tab);
}

// ------------------------------------------------------------------ tools

export async function screenshot(tab = current) {
  const r = await window.tandem.browser.action('screenshot', { fullPage: true }, tab);
  toast('Screenshot saved', r.path, [{ label: 'ok', primary: true }]);
}

export async function pickElement(tab = current) {
  const b = previewOf(tab);
  if (!b.live) {
    toast('Nothing to point at', 'Load a page in the preview first.', [{ label: 'ok', primary: true }]);
    return;
  }

  reveal(tab);
  b.picking = true;
  changed();

  let hit = null;
  try {
    hit = await window.tandem.browser.action('pick', undefined, tab);
  } finally {
    b.picking = false;
    changed();
  }
  if (!hit) return;

  // Grab the element itself so the agent can look at it, not just read about it.
  let shotPath = null;
  try {
    const shot = await window.tandem.browser.action('screenshot', { target: hit.ref, name: `pick-${Date.now()}` }, tab);
    shotPath = shot?.path || null;
  } catch { /* the description is worth sending without the picture */ }

  window.addAttachment?.(hit, shotPath);
}

window.pickElement = pickElement;

export function askAboutError(tab = current) {
  const e = previewOf(tab).error;
  if (!e) return;
  window.sendToAgent?.(
    `The preview failed to load ${e.url || 'the page'} with "${e.message}". `
    + 'Work out why: check whether the dev server is running, what port it is actually on, '
    + 'and start it or point me at the right URL.',
  );
}

// ------------------------------------------------------------------ wiring

/* Nothing below tells main to make a pane visible. `show` names the one preview
   that belongs in the box and main parks every other, so a page finishing its
   load in a tab you are not on can no longer lift the cover off the tab you
   are. */

window.tandem.browser.onState((s) => {
  // Every event names its tab. One that does not can only be about the preview
  // in the box, because an untagged path has no other view to reach.
  const tab = s.tab || shown;
  if (!tab) return;
  const b = recordOf(tab);
  if (s.project) ownerOf.set(tab, s.project);
  const drawing = b === browserState;

  // Retyping an address while the page is still loading should not have the old
  // one land back on top of it. Only the tab with the bar on screen can be
  // typed in, and it is the only one wearing the id.
  const editing = drawing && document.activeElement?.id === 'url';
  if (!editing && s.url && s.url !== 'about:blank') {
    const m = /^(https?:\/\/)(.*)$/.exec(s.url);
    b.scheme = m ? (m[1] === 'https://' ? '' : 'http://') : '';
    b.url = m ? m[2] : s.url;
  }

  b.canGoBack = !!s.canGoBack;
  b.canGoForward = !!s.canGoForward;

  if (s.error) {
    b.error = { message: s.error, url: s.failedUrl || s.url };
    if (drawing) reveal(tab);
  } else if (s.loading || s.url) {
    b.error = null;
  }

  const empty = !s.url || s.url === 'about:blank';
  b.live = !empty;

  b.status = s.error
    ? `error: ${s.error}`
    : empty ? '' : (s.loading ? 'loading…' : (s.title || ''));

  // The strip labels a preview with the page in it. A page that never gave
  // itself a title is better named by its address than by nothing.
  const owner = ownerOf.get(tab);
  if (owner) setTabTitle(owner, tab, empty ? '' : (s.title || b.url));

  // Nothing on screen moved for a tab that is not drawing, and its record is
  // read whole when you click back to it.
  if (drawing) changed();
});

window.tandem.browser.onConsole((c) => {
  const tab = c.tab || shown;
  if (!tab) return;
  const b = recordOf(tab);
  if (c.project) ownerOf.set(tab, c.project);
  b.console.push(c);
  if (b.console.length > 500) b.console.shift();
  if (b === browserState) changed({ soon: true });
});

/* An agent asked for a preview in a folder with no tab open for one. Main has
   already made the native view and minted the id, so the strip takes that id
   rather than one of its own and the two ends stay one thing. */
window.tandem.browser.onOpenTab(({ project, tab }) => {
  if (!project || !tab) return;
  ownerOf.set(tab, project);
  if (previewTabs(project).includes(tab)) activateTab(project, tab);
  else openTab(project, 'browser', tab);
  syncPreview();
});

window.tandem.term.onUrl(({ url, project }) => {
  if (autoOpen.has(project)) { navigate(url, project); return; }
  // A shell in a folder you are not looking at prints an address too, and it is
  // that folder's preview the address belongs in, so say whose it is.
  const name = (project || '').split('/').pop();
  const where = project === focusedDir || !name ? url : `${url} in ${name}`;
  toast('Local server detected', where, [
    { label: 'Open', primary: true, run: () => navigate(url, project) },
    { label: 'Always', run: () => { autoOpen.add(project); navigate(url, project); } },
    { label: 'Ignore' },
  ]);
});

/* Opens, closes, reorders and focus moves all arrive as this one event with the
   whole set, so the only way to tell what happened is to compare. */
function projectsChanged(info) {
  const dir = info?.focused || '';
  const open = new Set((info?.projects || []).map((p) => p.dir));

  // A closed folder took its previews with it. Nobody will ask what their
  // consoles said, so let the records go rather than hold a window's worth of
  // logs for a project that is gone, and dispose the native views behind them.
  for (const [tab, owner] of ownerOf) if (!open.has(owner)) forget(tab);
  for (const key of [...lastPreview.keys()]) if (!open.has(key)) lastPreview.delete(key);
  for (const key of [...autoOpen]) if (!open.has(key)) autoOpen.delete(key);

  focusedDir = dir;
  syncPreview();
}

window.tandem.project.onChanged(projectsChanged);
window.tandem.project.info().then(projectsChanged).catch(() => {});

/* The three things that move the box. The strip says which tab is active, the
   layout says whether the column is open at all, and focus says whose strip we
   are reading, which arrives above with the projects. */
subscribeTabs(syncPreview);
subscribeLayout(syncPreview);
