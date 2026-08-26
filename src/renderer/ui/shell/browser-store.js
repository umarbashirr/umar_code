/* Everything the preview pane knows about the page it is showing: the address,
   whether it loaded, what it logged, and what the network did.

   The pane itself is a native view the window paints over this document, so
   none of it is readable from here. Main sends it across and this is where it
   lands.

   A window holds several folders open and each one has its own pane, so this is
   one record per folder rather than one for the window. `browserState` is
   whichever folder has focus, because there is one address bar and one drawer
   to show a folder in. The rest of the panes are parked offscreen and still
   running, and what they say still lands here: an error project A logged while
   you were reading project B is in A's console when you go back to it. */
'use strict';
import { act } from './layout-store.js';

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
  // Whether a local server the terminal printed opens without asking.
  autoOpen: false,
});

// One record per folder, made the first time that folder's pane says something.
const byProject = new Map();

// The folder on screen, empty until project.info() answers. The first state
// event can beat that answer, so there is a record filed under the empty name
// for it to land in and the folder adopts it when it arrives.
let focusedDir = '';

/* Reassigned on every focus move rather than copied into, so the record a
   folder gathered while it was parked is the same object it gets back. Everyone
   reads this through the module binding, which follows, so StatusBar and
   BrowserView never learn that there is more than one. */
export let browserState = blank();
byProject.set(focusedDir, browserState);

function stateOf(dir) {
  const key = dir || focusedDir;
  let s = byProject.get(key);
  if (!s) { s = blank(); byProject.set(key, s); }
  return s;
}

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

export const consoleErrors = () => browserState.console.filter((c) => c.level === 'error').length;

// -------------------------------------------------------------------- focus

function focusOn(dir) {
  if (dir === focusedDir) return;
  focusedDir = dir;
  browserState = stateOf(dir);
  // A network fetch still out for the folder we just left would otherwise land
  // in this folder's drawer.
  fetchSeq += 1;
  changed();
}

// ------------------------------------------------------------- navigation

export async function navigate(url, project) {
  const b = stateOf(project);
  b.url = url;
  // Only the folder on screen has a pane worth revealing. The others load where
  // they stand and are done by the time you look.
  if (b === browserState) {
    act('openPreview');
    changed();
  }
  await window.tandem.browser.action('navigate', url, project || undefined);
}

export const go = (action) => window.tandem.browser.action(action);

// ------------------------------------------------------------------ drawer

/* The single way in: the tab strip, Ctrl+Shift+J, the menu and Show Details on
   a failed load all land here. They each used to open the drawer their own way,
   and the three orderings disagreed about when the pane got remeasured. */
let fetchSeq = 0;

export async function showDrawer(tab = browserState.drawerTab) {
  act('openPreview');
  browserState.drawerTab = tab;
  browserState.drawerOpen = true;
  // The rows still in the body belong to whatever was open last, and they would
  // sit there in plain sight while the fetch is out.
  if (tab === 'network') browserState.network = [];
  changed();

  // Stamped on every open, not only the ones that fetch, so clicking straight
  // over to the console retires a network fetch that is still out instead of
  // letting it land behind the tab that replaced it.
  const seq = ++fetchSeq;
  if (tab !== 'network') return;

  const rows = await window.tandem.browser.action('network').catch(() => []);
  if (seq !== fetchSeq || !browserState.drawerOpen) return;
  browserState.network = Array.isArray(rows) ? rows : [];
  changed();
}

export function hideDrawer() {
  if (!browserState.drawerOpen) return;
  browserState.drawerOpen = false;
  changed();
}

export const toggleDrawer = () => (browserState.drawerOpen ? hideDrawer() : showDrawer());

export function clearLogs() {
  browserState.console = [];
  browserState.network = [];
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

export function setViewport(size) {
  browserState.viewport = size;
  changed();
  if (!size) return window.tandem.browser.action('setViewport', null);
  const [width, height] = size.split('x').map(Number);
  return window.tandem.browser.action('setViewport', { width, height });
}

// ------------------------------------------------------------------ tools

export async function screenshot() {
  const r = await window.tandem.browser.action('screenshot', { fullPage: true });
  act('toast', 'Screenshot saved', r.path, [{ label: 'ok', primary: true }]);
}

export async function pickElement() {
  if (!browserState.live) {
    act('toast', 'Nothing to point at', 'Load a page in the preview first.', [{ label: 'ok', primary: true }]);
    return;
  }

  act('openPreview');
  browserState.picking = true;
  changed();

  let hit = null;
  try {
    hit = await window.tandem.browser.action('pick');
  } finally {
    browserState.picking = false;
    changed();
  }
  if (!hit) return;

  // Grab the element itself so the agent can look at it, not just read about it.
  let shotPath = null;
  try {
    const shot = await window.tandem.browser.action('screenshot', { target: hit.ref, name: `pick-${Date.now()}` });
    shotPath = shot?.path || null;
  } catch { /* the description is worth sending without the picture */ }

  window.addAttachment?.(hit, shotPath);
}

window.pickElement = pickElement;

export function askAboutError() {
  const e = browserState.error;
  if (!e) return;
  window.sendToAgent?.(
    `The preview failed to load ${e.url || 'the page'} with "${e.message}". `
    + 'Work out why: check whether the dev server is running, what port it is actually on, '
    + 'and start it or point me at the right URL.',
  );
}

// ------------------------------------------------------------------ wiring

window.tandem.browser.onState((s) => {
  const b = stateOf(s.project);
  const showing = b === browserState;

  // Retyping an address while the page is still loading should not have the old
  // one land back on top of it. Only the folder on screen has a bar to type in.
  const editing = showing && document.activeElement?.id === 'url';
  if (!editing && s.url && s.url !== 'about:blank') {
    const m = /^(https?:\/\/)(.*)$/.exec(s.url);
    b.scheme = m ? (m[1] === 'https://' ? '' : 'http://') : '';
    b.url = m ? m[2] : s.url;
  }

  b.canGoBack = !!s.canGoBack;
  b.canGoForward = !!s.canGoForward;

  if (s.error) {
    b.error = { message: s.error, url: s.failedUrl || s.url };
    // A folder you are not looking at does not get to pull the preview open in
    // front of the one you are. Its error keeps until you go there.
    if (showing) act('openPreview');
  } else if (s.loading || s.url) {
    b.error = null;
  }

  const empty = !s.url || s.url === 'about:blank';
  b.live = !empty;
  // Hiding the pane is done by parking it offscreen, never by making it
  // invisible: a hidden view stops laying out and the agent gets a 0x0 page.
  // A parked folder loading a page is no reason to lift a cover off the folder
  // in front of it, so only the one on screen says this.
  if (showing) window.tandem.browser.setVisible(true);

  b.status = s.error
    ? `error: ${s.error}`
    : empty ? '' : (s.loading ? 'loading…' : (s.title || ''));

  // Nothing on screen moved for a folder that is not showing, and the record is
  // read whole when focus comes back to it.
  if (showing) changed();
});

window.tandem.browser.onConsole((c) => {
  const b = stateOf(c.project);
  b.console.push(c);
  if (b.console.length > 500) b.console.shift();
  if (b === browserState) changed({ soon: true });
});

window.tandem.term.onUrl(({ url, project }) => {
  const b = stateOf(project);
  if (b.autoOpen) { navigate(url, project); return; }
  // A shell in a folder you are not looking at prints an address too, and it is
  // that folder's pane the address belongs in, so say whose it is.
  const name = (project || '').split('/').pop();
  const where = b === browserState || !name ? url : `${url} in ${name}`;
  act('toast', 'Local server detected', where, [
    { label: 'Open', primary: true, run: () => navigate(url, project) },
    { label: 'Always', run: () => { b.autoOpen = true; navigate(url, project); } },
    { label: 'Ignore' },
  ]);
});

/* Opens, closes, reorders and focus moves all arrive as this one event with the
   whole set, so the only way to tell what happened is to compare. */
function projectsChanged(info) {
  const dir = info?.focused || '';
  const open = new Set((info?.projects || []).map((p) => p.dir));

  // An event that arrived before the first answer, carrying no folder of its
  // own, belongs to the folder that answer names: the pane was speaking for it
  // all along and there was no name to file it under. One that did carry a
  // folder is already filed, and keeps what it said.
  if (dir && !focusedDir && byProject.has('') && !byProject.has(dir)) {
    byProject.set(dir, byProject.get(''));
    byProject.delete('');
  }

  // A closed folder took its pane with it and nobody will ask what its console
  // said, so let it go rather than hold a window's worth of logs for a folder
  // that is gone.
  for (const key of [...byProject.keys()]) if (key !== dir && !open.has(key)) byProject.delete(key);

  if (dir) focusOn(dir);
}

window.tandem.project.onChanged(projectsChanged);
window.tandem.project.info().then(projectsChanged).catch(() => {});
