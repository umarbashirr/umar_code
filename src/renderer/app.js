import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import {
  createIcons,
  AppWindow, ArrowLeft, ArrowRight, Camera, ChevronUp, CodeXml, Copy, Crosshair,
  Folder, FolderOpen, Globe, Hexagon, Maximize2, MessageSquare, MessageSquareDot,
  Minimize2, Minus, Moon, PanelBottom, PanelLeft, Plus, RotateCw, Search, Square,
  SquarePen, SquareTerminal, Sun, X,
} from 'lucide';

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
  AppWindow, ArrowLeft, ArrowRight, Camera, ChevronUp, CodeXml, Copy, Crosshair,
  Folder, FolderOpen, Globe, Hexagon, Maximize2, MessageSquare, MessageSquareDot,
  Minimize2, Minus, Moon, PanelBottom, PanelLeft, Plus, RotateCw, Search, Square,
  SquarePen, SquareTerminal, Sun, X,
};

export const icons = () => { try { createIcons({ icons: USED }); } catch {} };
export const iconMark = (name) => { const n = el('i'); n.dataset.lucide = name; return n; };

const state = {
  tabs: [],
  active: null,
  autoOpen: false,
  previewOpen: false,
  previewFull: false,
  panelOpen: false,
  paneLive: false,
  drawerTab: 'console',
  console: [],
  network: [],
  lastError: null,
};

// ------------------------------------------------------------------ theme

const THEME_KEY = 'pba.theme';

// xterm allocates the cell buffer per line as output arrives, so scrollback is
// a real ceiling on memory, not a reservation: 20000 lines at 120 columns is
// tens of megabytes for one tab that has printed a lot. This is enough to scroll
// back through a build log and cheap enough to open several tabs.
const SCROLLBACK = 5000;

function applyTheme(name) {
  document.documentElement.dataset.theme = name;
  const btn = $('#theme-toggle');
  btn.replaceChildren(iconMark(name === 'dark' ? 'moon' : 'sun'));
  btn.title = name === 'dark' ? 'Switch to light' : 'Switch to dark';
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

let theme = 'light';
try { theme = localStorage.getItem(THEME_KEY) || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); } catch {}
applyTheme(theme);

function toggleTheme() {
  theme = theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem(THEME_KEY, theme); } catch {}
  applyTheme(theme);
}

$('#theme-toggle').onclick = toggleTheme;

// --------------------------------------------------------------- terminals

function newTerminalTab(command) {
  openPanel();
  const host = el('div', 'term-host');
  $('#terms').appendChild(host);

  const term = new Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, "Cascadia Code", monospace',
    fontSize: 13,
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

  window.pba.term.create({ cols: term.cols, rows: term.rows }).then(({ id, shell }) => {
    tab.id = id;
    if (shell) tab.title = shell;
    term.onData((d) => window.pba.term.input(id, d));
    term.onResize(({ cols, rows }) => window.pba.term.resize(id, cols, rows));
    activate(tab);
    term.write(
      '\x1b[38;5;103m  pba  \x1b[0m\x1b[90mYour shell. \x1b[0m\x1b[36mpba go 3000\x1b[90m opens a page in the preview, ' +
      'from here or from the agent.\x1b[0m\r\n',
    );
    // Sent as keystrokes rather than run for you: the line is visible, and an
    // interactive flow like `claude mcp login` needs a real terminal anyway.
    if (command) window.pba.term.input(id, command + '\n');
    setTimeout(() => resizeActive(), 30);
  });

  renderStrip();
  return tab;
}

// The preview and every shell as one row of tabs in the toolbar. The panes
// themselves are elsewhere in the window, so this row is the only listing of
// what is open, and it is redrawn whenever one of them opens or closes.
function renderStrip() {
  const strip = $('#viewstrip');
  strip.innerHTML = '';

  const browser = el('button', 'vtab' + (state.previewOpen ? ' on' : ''));
  browser.appendChild(iconMark('globe'));
  browser.appendChild(el('span', null, 'Browser'));
  browser.title = 'Preview browser (Ctrl+Shift+B)';
  browser.onclick = () => togglePreview();
  strip.appendChild(browser);

  state.tabs.forEach((tab, i) => {
    const node = el('button', 'vtab' + (state.panelOpen && tab === state.active ? ' on' : ''));
    node.appendChild(iconMark('square-terminal'));
    node.appendChild(el('span', null, tab.title));
    const close = el('span', 'close');
    close.appendChild(iconMark('x'));
    close.onclick = (e) => { e.stopPropagation(); closeTab(tab); };
    node.appendChild(close);
    node.title = `${tab.title} (Ctrl+${i + 1})`;
    node.onclick = () => { openPanel(); activate(tab); };
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
  if (tab.id) window.pba.term.kill(tab.id);
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

window.pba.term.onData(({ id, data }) => {
  const tab = state.tabs.find((t) => t.id === id);
  tab?.term.write(data);
});

window.pba.term.onExit(({ id }) => {
  const tab = state.tabs.find((t) => t.id === id);
  if (tab) { tab.title = 'exited'; renderStrip(); tab.term.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n'); }
});

window.pba.term.onUrl(({ url }) => {
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

function syncBounds() {
  if (previewParked || !state.previewOpen) {
    // Park it just outside the window instead of hiding it. A hidden view stops
    // laying out, and the agent would get a 0x0 page while the pane is closed.
    window.pba.browser.setBounds({
      x: window.innerWidth + 40, y: 40,
      width: Math.round(window.innerWidth * 0.5),
      height: Math.max(240, window.innerHeight - 96),
    });
    return;
  }
  const r = $('#paneslot').getBoundingClientRect();
  window.pba.browser.setBounds({ x: r.x, y: r.y, width: r.width, height: r.height });
}

function openPreview(focusUrl = false) {
  if (!state.previewOpen) {
    state.previewOpen = true;
    $('#right').classList.remove('closed');
    $('#agent-gutter').classList.remove('closed');
    renderStrip();
    requestAnimationFrame(() => {
      syncBounds();
      resizeActive();
      window.pba.browser.setVisible(true);
      if (focusUrl && !state.paneLive) { $('#url').focus(); $('#url').select(); }
    });
    return;
  }
  if (focusUrl && !state.paneLive) { $('#url').focus(); $('#url').select(); }
}

function closePreview() {
  if (!state.previewOpen) return;
  // Both panes hidden at once is a blank window, so putting the preview away
  // gives the chat its half back first.
  setPreviewFull(false);
  state.previewOpen = false;
  $('#right').classList.add('closed');
  $('#agent-gutter').classList.add('closed');
  renderStrip();
  syncBounds();
  requestAnimationFrame(resizeActive);
}

const togglePreview = () => (state.previewOpen ? closePreview() : openPreview(true));

// The preview at full width: the chat collapses to nothing and the pane takes
// the whole content column. The rail is deliberately left alone, so a sidebar
// that was open stays open, and closing it hands the last of the window over
// to the page.
function setPreviewFull(on) {
  const next = on === undefined ? !state.previewFull : !!on;
  if (next === state.previewFull) return;
  state.previewFull = next;
  if (next) openPreview();
  $('#panes').classList.toggle('preview-full', next);
  const btn = $('#expand');
  btn.classList.toggle('armed', next);
  btn.title = next ? 'Back to the chat (Ctrl+Shift+F)' : 'Preview at full width (Ctrl+Shift+F)';
  btn.replaceChildren(iconMark(next ? 'minimize-2' : 'maximize-2'));
  icons();
  requestAnimationFrame(() => { resizeActive(); syncBounds(); });
}

$('#expand').onclick = () => setPreviewFull();

async function openInPane(url) {
  $('#url').value = url;
  openPreview();
  await window.pba.browser.action('navigate', url);
}

function showPane(live) {
  state.paneLive = live;
  $('#placeholder').classList.toggle('hidden', live || !!state.lastError);
  window.pba.browser.setVisible(true); // hiding is done by parking it offscreen
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
  state.network = await window.pba.browser.action('network');
  for (const b of $('#drawer-tabs').querySelectorAll('[data-tab]')) b.classList.toggle('active', b.dataset.tab === 'network');
  $('#drawer').classList.remove('collapsed');
  renderDrawer();
  updateBadges();
  syncBounds();
};

window.pba.browser.onState((s) => {
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

window.pba.browser.onConsole((c) => {
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
$('#back').onclick = () => window.pba.browser.action('back');
$('#forward').onclick = () => window.pba.browser.action('forward');
$('#reload').onclick = () => window.pba.browser.action('reload');
$('#devtools').onclick = () => window.pba.browser.action('devtools');
$('#shot').onclick = async () => {
  const r = await window.pba.browser.action('screenshot', { fullPage: true });
  toast('Screenshot saved', r.path, [{ label: 'ok', primary: true }]);
};
$('#viewport').onchange = (e) => {
  const v = e.target.value;
  if (!v) return window.pba.browser.action('setViewport', null);
  const [w, h] = v.split('x').map(Number);
  window.pba.browser.action('setViewport', { width: w, height: h });
};
$('#pick').onclick = () => pickElement();
$('#close-preview').onclick = () => closePreview();

// ----------------------------------------------------------- element pick

async function pickElement() {
  if (!state.paneLive) return toast('Nothing to point at', 'Load a page in the preview first.', [{ label: 'ok', primary: true }]);
  $('#pick').classList.add('armed');
  let hit = null;
  try { hit = await window.pba.browser.action('pick'); } finally { $('#pick').classList.remove('armed'); }
  if (!hit) return;

  // Grab the element itself so the agent can look at it, not just read about it.
  let shotPath = null;
  try {
    const shot = await window.pba.browser.action('screenshot', { target: hit.ref, name: `pick-${Date.now()}` });
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
  if (t === 'network') state.network = await window.pba.browser.action('network');
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

window.pba.agent.onActivity(({ tool, args }) => {
  const a = $('#activity');
  const detail = args?.url || args?.target || args?.ref || args?.selector || args?.key || args?.text || '';
  a.textContent = `${tool}${detail ? ' ' + String(detail).slice(0, 40) : ''}`;
  a.classList.add('live');
  clearTimeout(a._t);
  a._t = setTimeout(() => a.classList.remove('live'), 1800);
  // The agent loading a page is a request to be looked at.
  if (tool === 'navigate') openPreview();
});

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
    case 'terminal': return togglePanel();
    case 'newTerminal': return newTerminalTab();
    case 'runInTerminal': return newTerminalTab(arg);
    case 'rail': return toggleRail();
    case 'drawer': return toggleDrawer();
    case 'theme': return toggleTheme();
    case 'newChat': return $('#new-chat').click();
    case 'copyMcp': return copyMcpCommand();
    case 'about': return toast(
      'Preview Browser for Agent',
      state.mcpCommand ? `bridge ${state.bridgeUrl}` : '',
      [{ label: 'ok', primary: true }],
    );
    default: return undefined;
  }
}

window.pba.onCommand(({ name, open }) => runCommand(name, open));

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
  $('#panel').style.height = Math.min(max, Math.max(90, window.innerHeight - e.clientY - 24)) + 'px';
});

window.addEventListener('resize', () => { resizeActive(); syncBounds(); });
new ResizeObserver(() => syncBounds()).observe($('#paneslot'));

// ---------------------------------------------------------------- keys

// Ctrl+Shift+<key> and Ctrl+` only: everything else belongs to the shell.
function isAppChord(e) {
  const mod = e.ctrlKey || e.metaKey;
  const k = (e.key || '').toLowerCase();
  if (mod && e.shiftKey && ['b', 't', 'l', 'e', 'j', 's', 'k'].includes(k)) return true;
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
  const info = await window.pba.bridgeInfo();
  state.mcpCommand = `claude mcp add pba -- node ${info.mcp}`;
  state.bridgeUrl = info.url;
  $('#bridge-status').textContent = `bridge ${info.url.replace('http://127.0.0.1', 'loopback')}`;
  $('#bridge-dot').className = 'dot';
  $('#copy-mcp').onclick = copyMcpCommand;
  showPane(false);
  renderStrip();
  syncBounds();
  renderDrawer();
  icons();
})();
