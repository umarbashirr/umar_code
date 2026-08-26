/* Everything the preview pane knows about the page it is showing: the address,
   whether it loaded, what it logged, and what the network did.

   The pane itself is a native view the window paints over this document, so
   none of it is readable from here. Main sends it across and this is where it
   lands. */
'use strict';
import { act } from './layout-store.js';

export const browserState = {
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
};

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

// ------------------------------------------------------------- navigation

export async function navigate(url) {
  browserState.url = url;
  act('openPreview');
  changed();
  await window.tandem.browser.action('navigate', url);
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
  // Retyping an address while the page is still loading should not have the
  // old one land back on top of it.
  const editing = document.activeElement?.id === 'url';
  if (!editing && s.url && s.url !== 'about:blank') {
    const m = /^(https?:\/\/)(.*)$/.exec(s.url);
    browserState.scheme = m ? (m[1] === 'https://' ? '' : 'http://') : '';
    browserState.url = m ? m[2] : s.url;
  }

  browserState.canGoBack = !!s.canGoBack;
  browserState.canGoForward = !!s.canGoForward;

  if (s.error) {
    browserState.error = { message: s.error, url: s.failedUrl || s.url };
    act('openPreview');
  } else if (s.loading || s.url) {
    browserState.error = null;
  }

  const blank = !s.url || s.url === 'about:blank';
  browserState.live = !blank;
  // Hiding the pane is done by parking it offscreen, never by making it
  // invisible: a hidden view stops laying out and the agent gets a 0x0 page.
  window.tandem.browser.setVisible(true);

  browserState.status = s.error
    ? `error: ${s.error}`
    : blank ? '' : (s.loading ? 'loading…' : (s.title || ''));

  changed();
});

window.tandem.browser.onConsole((c) => {
  browserState.console.push(c);
  if (browserState.console.length > 500) browserState.console.shift();
  changed({ soon: true });
});

window.tandem.term.onUrl(({ url }) => {
  if (browserState.autoOpen) { navigate(url); return; }
  act('toast', 'Local server detected', url, [
    { label: 'Open', primary: true, run: () => navigate(url) },
    { label: 'Always', run: () => { browserState.autoOpen = true; navigate(url); } },
    { label: 'Ignore' },
  ]);
});
