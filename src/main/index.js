'use strict';
const { app, BrowserWindow, ipcMain, shell, dialog, webContents } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const { BrowserPane, normalizeUrl } = require('./browser');
const { Terminal } = require('./terminal');
const { Bridge } = require('./bridge');
const { runTool } = require('./tools');
const { AgentSession, SHOT_NOTE } = require('./agent');
const { Driver, claudeBinary, preferBinary, systemBinary } = require('./driver');
const { Catalog } = require('./catalog');
const { Settings } = require('./settings');
const { Updates } = require('./updates');
const shellEnv = require('./shell-env');
const { listSessions, readSession, readSubagent, listSubagents, deleteSession } = require('./history');
const { applyMenu } = require('./menu');
const git = require('./git');
const diff = require('./diff');
const editors = require('./editors');
const files = require('./files');
const attachments = require('./attachments');
const projects = require('./projects');
const { DEFAULT_MODE, isMode } = require('./modes');
const { PaneLease } = require('./pane-lease');
const bridgeState = require('../../cli/state');

const fs = require('fs');

const ROOT = path.join(__dirname, '..', '..');
const HOME_URL = 'about:blank';
const isDev = process.argv.includes('--dev');

let win = null;
// One preview per preview tab. The right column is a strip of tabs and a folder
// can have several previews open at once, so the tab is what a page belongs to;
// the folder it is filed under is only what decides whether it goes when that
// folder closes. Made on first use, because a WebContents is not a bill to run
// up on a tab nobody has opened.
const panes = new Map(); // tab id -> { pane, project }
// Which preview is in the box. The shell says, because it owns the strip and
// knows which tab is active in the folder on screen.
let shownTab = null;
let paneSeq = 0;
// One AgentSession per chat, keyed by whatever the panel calls that chat. A
// chat that is working keeps working while you read another one, which is the
// whole reason this is a map and not a single session.
const sessions = new Map();
let bridge = null;
let driver = null;
let catalog = null;
// Read before the window exists: the terminal font, the theme and which claude
// to run are all settled by the time anything paints.
const settings = new Settings();
let updates = null;
// Survives the agent it was picked for. `default` is not a model, and anyone
// running a build that offered it has it saved here; read it as nothing chosen
// so settleModel names a real one instead. See driver.js.
let chosenModel = settings.get('agent').model || null;
if (chosenModel === 'default') chosenModel = null;
let chosenMode = isMode(settings.get('agent').mode) ? settings.get('agent').mode : DEFAULT_MODE;
let driverReady = null;
let fileWatcher = null;
let lastBounds = null; // the renderer measures before the pane exists
// Whether the preview column is open at all, remembered because a pane made
// after the fact, or brought forward by a focus change, has to match it.
let paneVisible = false;
const terms = new Map();

// Which chat the panel is showing. `tandem ask` from a terminal has to land in
// the chat the human is looking at rather than opening one they cannot see.
let activeChat = { chat: 'main', session: null };

// One lease per preview, because a lease guards one page. Two agents pointed at
// the same tab take turns; two working in different tabs never had anything to
// argue about. See pane-lease.js for why looking is free and changing the page
// is not.
const leases = new Map(); // tab id -> PaneLease

function leaseFor(tab) {
  const key = tab || 'none';
  let l = leases.get(key);
  if (!l) {
    l = new PaneLease({
      onChange: (holder) => send('preview:driver', { holder, tab: key, project: panes.get(key)?.project || focused }),
    });
    leases.set(key, l);
  }
  return l;
}

// Nothing picked. Passing no --model does not mean "no opinion": the CLI runs
// whatever the account defaults to, which on most plans is Fable, and the picker
// meanwhile says "Pick a model". Two different answers to the same question.
// Land on the first model the driver lists, write it down, and hand it back so
// the label and the session agree from the first message on.
function settleModel() {
  if (chosenModel) return chosenModel;
  const first = driver?.current({ refresh: false }).models[0]?.value;
  if (!first) return null;
  chosenModel = first;
  settings.patch({ agent: { model: first } });
  return chosenModel;
}

const liveSessions = () => [...sessions.values()].filter((a) => !a.closed);
// Anything that asks the CLI a question rather than driving one chat: any live
// session can answer, and the cache answers when none is up.
const anySession = () => liveSessions()[0] || null;

function stopChat(chat) {
  const a = sessions.get(chat);
  if (!a) return false;
  a.stop();
  sessions.delete(chat);
  releaseChatEverywhere(chat);
  return true;
}

// A chat that has been parked keeps its folder. Only closing the project drops
// that, because the panel can hand a parked chat a message months later and it
// has to resume in the folder it was written in.
function forgetChat(chat) {
  stopChat(chat);
  chatProjects.delete(chat);
}

function stopAllChats() {
  for (const a of sessions.values()) a.stop();
  sessions.clear();
  chatProjects.clear();
  for (const l of leases.values()) l.stop();
  leases.clear();
}

// Everything rooted at one folder, stopped. The other projects in this window
// carry on, which is the difference between closing a project and the old
// switch that took the whole window with it.
function stopProject(dir) {
  for (const [chat, cwd] of chatProjects) if (cwd === dir) forgetChat(chat);
  for (const [id, t] of terms) {
    if (t.project !== dir) continue;
    t.kill();
    terms.delete(id);
  }
  fileWatcher?.drop(dir);
  catalog.invalidate(dir);
  for (const [tab, rec] of [...panes]) if (rec.project === dir) dropPane(tab);
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// `project` is whose preview this is about. Opening it brings that folder
// forward: an agent in one project putting its dev server on screen while the
// window is looking at another would otherwise show the wrong page under the
// right heading.
function showPreview(show, project) {
  if (project && open.has(project) && project !== focused) focusProject(project);
  send('app:command', { name: 'preview', open: show });
  if (show === true && win && !win.isFocused()) win.show();
  return { ok: true, preview: show === undefined ? 'toggled' : show ? 'open' : 'closed' };
}

// The preview one tab is showing, made on first use. Everything that can reach
// a page goes through here, so a tool call from a chat in one folder can never
// land on another folder's tab.
function paneOf(tab, { create = true, project = focused } = {}) {
  const held = panes.get(tab);
  if (held) return held.pane;
  if (!create || !tab || !win || win.isDestroyed()) return null;

  const made = new BrowserPane(win, HOME_URL);
  made.on('state', (st) => send('browser:state', { ...st, tab, project }));
  made.on('console', (c) => send('browser:console', { ...c, tab, project }));
  panes.set(tab, { pane: made, project });
  // Born parked. It comes on screen only when the shell says it is the tab in
  // the box, and the shell has already said where the box is.
  if (tab === shownTab) {
    if (lastBounds) made.setBounds(lastBounds);
    made.setVisible(paneVisible);
  } else {
    made.setVisible(false);
  }
  return made;
}

/* The preview an agent working in a folder should drive. The one in the box if
   it belongs to that folder, otherwise that folder's first, otherwise a new
   one. In that last case the shell is told to draw a tab for it, because a page
   nobody can click to is a page nobody can take back off the agent. */
function previewOf(dir) {
  const key = dir && open.has(dir) ? dir : focused;
  if (shownTab && panes.get(shownTab)?.project === key) return { tab: shownTab, pane: paneOf(shownTab) };
  for (const [tab, rec] of panes) if (rec.project === key) return { tab, pane: rec.pane };

  const tab = `mn${++paneSeq}`;
  const pane = paneOf(tab, { project: key });
  send('preview:tab', { project: key, tab });
  return { tab, pane };
}

// One preview in the box, the rest parked. Parked is not stopped: they go on
// loading, go on logging, and keep their place in history.
function applyShown() {
  for (const [tab, rec] of panes) {
    if (tab === shownTab) {
      if (lastBounds) rec.pane.setBounds(lastBounds);
      rec.pane.setVisible(paneVisible);
    } else {
      rec.pane.setVisible(false);
    }
  }
}

function owner(project, tab) {
  if (project && open.has(project)) {
    const rec = tab && panes.get(tab);
    if (rec) rec.project = project;
    return project;
  }
  return (tab && panes.get(tab)?.project) || focused;
}

function dropPane(tab) {
  panes.get(tab)?.pane.dispose();
  panes.delete(tab);
  leases.get(tab)?.stop();
  leases.delete(tab);
  if (shownTab === tab) shownTab = null;
}

// A hold belongs to a chat or a task rather than to a page, and one chat can
// have driven more than one preview, so letting go is asked of all of them.
const releaseChatEverywhere = (chat) => { for (const l of leases.values()) l.releaseChat(chat); };
const releaseTaskEverywhere = (id) => { for (const l of leases.values()) l.release(id); };

const toolContext = (dir) => ({ getPane: () => previewOf(dir).pane, showPreview: (show) => showPreview(show, dir) });

// The agent SDK and the MCP server both spawn `node`. A packaged app cannot
// assume the user has one, so leave a shim at the end of PATH that runs this
// binary as node.
function nodeShimDir() {
  const dir = path.join(app.getPath('userData'), 'bin');
  fs.mkdirSync(dir, { recursive: true });

  // A shebang is not a thing on Windows. What a shell there looks for is
  // node.cmd, which PATHEXT makes answer to plain `node`.
  const win = process.platform === 'win32';
  const shim = path.join(dir, win ? 'node.cmd' : 'node');
  const body = win
    ? `@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" %*\r\nexit /b %errorlevel%\r\n`
    : `#!/usr/bin/env sh\nELECTRON_RUN_AS_NODE=1 exec ${JSON.stringify(process.execPath)} "$@"\n`;
  try {
    if (!fs.existsSync(shim) || fs.readFileSync(shim, 'utf8') !== body) {
      fs.writeFileSync(shim, body, { mode: 0o755 });
    }
  } catch {}
  return dir;
}

const os = require('os');

// The folders this window has open. A project is a folder plus everything
// rooted at it: its chats, its shells, its file tree, and the catalog of skills
// and servers it can reach. Several are open at once and all of them keep
// working, because the point of holding two projects is leaving a turn running
// in one while you read the other.
//
// `focused` is a smaller claim than it looks. There is one preview pane and one
// terminal panel in the window, so exactly one project can be showing its files,
// its changes and its shells. That is all focus decides. Agents ignore it.
const open = new Map(); // dir -> { dir, chosen }
let focused = null;

const seed = projects.startProjects({ reopen: settings.get('startup').reopenProject });
for (const dir of seed.open) open.set(dir, { dir, chosen: true });
// Nothing to reopen and nothing named: the window comes up on the empty state
// rather than rooted at somebody's home directory, and that folder is still the
// one open so the panes have something to read.
if (!open.size) open.set(seed.focus, { dir: seed.focus, chosen: seed.chosen });
focused = open.has(seed.focus) ? seed.focus : openDirs()[0];

// The project the right-hand column is looking at. Files, changes, the terminal
// and the catalog page all mean "the one on screen" when they ask for a folder.
const focusedCwd = () => focused;

// Which project a chat belongs to. The panel names a chat by its own key and
// says which folder it opened it in; a chat mid-turn in a project nobody is
// looking at still has to run against that project's files.
const chatProjects = new Map(); // chat key -> dir
const cwdOfChat = (chat) => (chat && chatProjects.get(chat)) || focused;

const openDirs = () => [...open.keys()];

const oneProject = (dir) => ({
  dir,
  name: path.basename(dir) || dir,
  branch: git.branch(dir),
  chosen: open.get(dir)?.chosen ?? true,
});

const projectInfo = () => ({
  projects: openDirs().map(oneProject),
  focused,
  home: os.homedir(),
  recents: projects.recents().filter((r) => !open.has(r.path)),
  // The single-folder shape the panel still reads in places that only ever
  // meant the one on screen.
  ...oneProject(focused),
});

function refreshMenu() {
  applyMenu({
    recents: projectInfo().recents,
    actions: {
      command: (name) => send('app:command', { name }),
      openFolder: (opts) => openFolder(opts),
      openRecent: (dir) => addProject(dir),
      clearRecents: () => { projects.clearRecents(); announce(); },
    },
  });
}

// Point the agent at the claude the settings page picked. Chats already running
// keep the binary they started with; a new one gets this. The driver cache is
// re-probed because the model list is filtered by the CLI's version, and the
// two binaries are rarely the same version.
async function applyClaudeBinary() {
  const wanted = settings.get('claude').binary === 'path' ? systemBinary() : null;
  preferBinary(wanted);
  if (!driver) return null;
  const d = await driver.refresh().catch(() => null);
  if (d) send('agent:driver', d);
  return d;
}

// Adding a folder to the window. Nothing that was already open is disturbed:
// the chats in the other projects keep their turns, their shells stay up, and
// the preview pane and the bridge port belong to the window rather than to any
// one folder.
function addProject(dir) {
  const target = path.resolve(dir);
  if (!projects.isDir(target)) return { error: `${target} is not a folder` };
  if (open.has(target)) return focusProject(target);

  open.set(target, { dir: target, chosen: true });
  projects.remember(target);
  const strip = projects.openProject(target);
  for (const dir of openDirs()) {
    if (strip.includes(dir)) continue;
    stopProject(dir);
    open.delete(dir);
    bridge?.removeProject?.(dir);
  }
  bridge?.addProject?.(target);
  announce();
  return focusProject(target);
}

// Which project the right-hand column is showing. Cheap on purpose: no process
// starts or stops here, because the folder you are looking at and the folders
// that are working are two different questions now.
function focusProject(dir) {
  const target = path.resolve(dir);
  if (!open.has(target)) return { error: `${target} is not open` };
  focused = target;
  projects.remember(target);
  // The shell names the new tab a beat later. Until then the box is empty
  // rather than still showing the folder you just left.
  if (panes.get(shownTab)?.project !== target) shownTab = null;
  applyShown();
  if (win && !win.isDestroyed()) win.setTitle(`${path.basename(target)} · Tandem`);
  announce();
  send('agent:catalog', catalog.current(target));
  return projectInfo();
}

// Closing one. Its chats stop, its shells die and its watches go, and the rest
// of the window does not notice. The last project cannot be closed: a window
// with no folder in it has nothing to draw and nowhere to put the next message.
function closeProject(dir) {
  const target = path.resolve(dir);
  if (!open.has(target)) return projectInfo();
  if (open.size === 1) return { error: 'that is the only folder open in this window' };

  stopProject(target);
  open.delete(target);
  projects.closeProject(target);
  bridge?.removeProject?.(target);
  if (focused === target) return focusProject(openDirs()[0]);
  announce();
  return projectInfo();
}

// One place that tells the menu, the title and the panel that the set of open
// folders or the focused one has moved.
function announce() {
  refreshMenu();
  send('project:changed', projectInfo());
}

async function pickFolder(newWindow) {
  const res = await dialog.showOpenDialog(win, {
    title: newWindow ? 'Open folder in a new window' : 'Open folder',
    buttonLabel: 'Open',
    defaultPath: open.get(focused)?.chosen ? path.dirname(focused) : os.homedir(),
    properties: ['openDirectory', 'createDirectory'],
  });
  return res.canceled ? null : res.filePaths[0];
}

async function openFolder({ dir, newWindow } = {}) {
  const target = dir || await pickFolder(newWindow);
  if (!target) return { canceled: true };
  return newWindow ? openInNewWindow(target) : addProject(target);
}

// Same rule the CLI uses: a folder that already has a window gets that window
// raised rather than a second one opened on it.
async function openInNewWindow(dir) {
  const target = path.resolve(dir);
  if (!projects.isDir(target)) return { error: `${target} is not a folder` };

  const open = bridgeState.forDir(target);
  if (open) {
    try {
      const res = await fetch(`${open.url}/focus`, { method: 'POST', headers: { 'x-tandem-token': open.token } });
      if (res.ok) return { ok: true, focused: true, dir: target };
    } catch { /* dead or wedged: start a new one */ }
  }

  const viaAppImage = process.env.APPIMAGE && fs.existsSync(process.env.APPIMAGE);
  const bin = viaAppImage ? process.env.APPIMAGE : process.execPath;
  const args = !viaAppImage && process.defaultApp ? [app.getAppPath()] : [];
  // An install that never had root cannot set up the sandbox helper, so this
  // window was started with --no-sandbox. The next one has to be told too, or
  // it aborts on launch instead of opening.
  if (!viaAppImage && process.argv.includes('--no-sandbox')) args.push('--no-sandbox');

  const env = { ...process.env, TANDEM_CWD: target };
  delete env.TANDEM_BRIDGE_URL;
  delete env.TANDEM_TOKEN;
  delete env.TANDEM_MCP_SERVER;
  delete env.ELECTRON_RUN_AS_NODE;

  try {
    spawn(bin, args, { cwd: target, env, detached: true, stdio: 'ignore' }).unref();
  } catch (e) {
    return { error: `could not start a second window: ${e.message}` };
  }
  projects.remember(target);
  refreshMenu();
  return { ok: true, dir: target };
}

// The model needs screenshots as base64; the panel does not. Forwarding them
// left a megabyte per shot pinned in React state for the life of the chat, on
// top of the decoded bitmap. Send the path instead and let the renderer load it
// off disk, where Chromium can evict it.
const MAX_TOOL_TEXT = 20000;

function lighten(msg) {
  const content = msg?.message?.content;
  if (!Array.isArray(content)) return msg;

  let touched = false;
  const mapped = content.map((block) => {
    if (block?.type !== 'tool_result' || !Array.isArray(block.content)) return block;

    const note = block.content.find((b) => b?.type === 'text' && SHOT_NOTE.test(String(b.text || '')));
    const shotPath = note ? SHOT_NOTE.exec(String(note.text))[3] : null;

    let hit = false;
    const inner = block.content.map((b) => {
      if (b?.type === 'image') {
        hit = true;
        // No path means no way to show it later, so say that rather than
        // silently dropping the block.
        return shotPath ? { type: 'image', path: shotPath } : { type: 'text', text: '[screenshot]' };
      }
      if (typeof b?.text === 'string' && b.text.length > MAX_TOOL_TEXT) {
        hit = true;
        return { ...b, text: b.text.slice(0, MAX_TOOL_TEXT) + '\n… truncated' };
      }
      return b;
    });

    if (!hit) return block;
    touched = true;
    return { ...block, content: inner };
  });

  return touched ? { ...msg, message: { ...msg.message, content: mapped } } : msg;
}

// `chat` is the panel's name for one conversation and outlives the session
// under it: a chat the panel parked is resumed on the next message, under the
// same key. Every event carries the key back so the panel knows which chat it
// belongs to.
async function ensureAgent({ chat = 'main', resume, project } = {}) {
  const live = sessions.get(chat);
  if (live && !live.closed) return live;

  // Where this chat runs, settled once and remembered. Not the focused project:
  // a chat keeps its folder when you go and read another one, which is the
  // whole reason two projects can be open.
  const cwd = project && open.has(project) ? project : cwdOfChat(chat);
  chatProjects.set(chat, cwd);

  const agent = new AgentSession({
    resume: resume || null,
    model: settleModel(),
    mode: chosenMode,
    cwd,
    settings: catalog.sessionSettings(cwd),
    mcpOff: catalog.offAtRuntime(cwd),
    invoke: async (tool, args, actor) => {
      // Two chats each have a main thread, so the chat key is part of who this
      // is. Without it the two would look like the same driver and neither
      // would ever wait for the other.
      const who = actor?.id && actor.id !== 'main'
        ? { ...actor, chat }
        : { id: `main:${chat}`, label: 'the main thread', chat };
      // Whoever is driving keeps driving until they stop. A second agent that
      // wants to change the page waits here rather than pulling the rug out
      // from under the first one's refs.
      const l = leaseFor(previewOf(cwd).tab);
      const busy = await l.acquire(tool, who);
      if (busy) throw new Error(busy);
      try {
        if (tool === 'navigate') showPreview(true, cwd);
        send('agent:activity', { tool, args, t: Date.now(), actor: who, project: cwd });
        return await runTool(tool, args, toolContext(cwd));
      } finally {
        l.done(tool, who);
      }
    },
  });
  sessions.set(chat, agent);

  agent.on('message', (m) => {
    // A subagent that finishes has stopped touching the page, whether or not
    // the turn around it has, so hand the pane on at that point rather than
    // making the next agent wait out the idle timer.
    if (m?.type === 'system' && m.subtype === 'task_notification') releaseTaskEverywhere(m.task_id);
    if (m?.type === 'result') releaseChatEverywhere(chat);
    send('agent:message', { chat, msg: lighten(m) });
  });
  agent.on('ready', (r) => {
    send('agent:ready', { ...r, chat });
    // A running session knows the account's real entitlements; the catalogue in
    // driver.js can only infer them from a version number.
    agent.models().then((m) => driver.learn(m)).catch(() => {});
    // Same trade for skills and servers: the disk scan cannot see the built-in
    // commands or whether a server actually came up, but a session can.
    learnCatalog();
  });
  agent.on('permission', (p) => send('agent:permission', { ...p, chat }));
  agent.on('mode', (m) => send('agent:mode', { ...m, chat }));
  agent.on('error', (e) => send('agent:error', { error: e, chat }));
  agent.on('closed', () => send('agent:closed', { chat }));
  agent.on('stderr', (d) => send('agent:stderr', { data: String(d).slice(0, 2000), chat }));
  await agent.start();
  return agent;
}

// Ask the running session what it ended up with, fold it into the cached
// listing, and push the result at the panel.
async function learnCatalog() {
  const dir = focusedCwd();
  const agent = anySession();
  if (!agent) return catalog.current(dir);
  const [commands, mcp] = await Promise.all([agent.commands(), agent.mcpStatus()]);
  catalog.learn(dir, { commands, mcp });
  const next = catalog.current(dir);
  send('agent:catalog', next);
  return next;
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 980,
    backgroundColor: '#0b0d12',
    title: `${path.basename(focusedCwd())} · Tandem`,
    // The window draws its own title bar: the menu, the folder, the view tabs
    // and the three window buttons all live in one strip at the top.
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // The renderer is a Vite build: the chat pane is React, the shell is not.
  await win.loadFile(path.join(ROOT, 'build', 'renderer', 'index.html'));
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });

  // The probe usually lands before the window does, and that push has nowhere
  // to go. Repeat it once there is something to receive it.
  driverReady?.then((d) => { if (d) send('agent:driver', { ...d, current: settleModel() }); });

  for (const ev of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
    win.on(ev, () => send('win:state', windowState()));
  }


  win.on('closed', () => {
    for (const t of terms.values()) t.kill();
    terms.clear();
    fileWatcher?.clear();
    for (const rec of panes.values()) rec.pane.dispose();
    panes.clear();
    win = null;
  });
}

const windowState = () => ({
  maximized: !!win && !win.isDestroyed() && win.isMaximized(),
  fullScreen: !!win && !win.isDestroyed() && win.isFullScreen(),
});

function registerIpc() {
  ipcMain.handle('bridge:info', () => ({ url: bridge.url, token: bridge.token, mcp: path.join(ROOT, 'mcp', 'server.js'), root: ROOT }));

  // --- window frame ---
  ipcMain.handle('win:state', () => windowState());
  ipcMain.on('win:action', (_e, { action }) => {
    if (!win || win.isDestroyed()) return;
    if (action === 'minimize') return win.minimize();
    if (action === 'close') return win.close();
    if (action === 'maximize') return win.isMaximized() ? win.unmaximize() : win.maximize();
    if (action === 'fullScreen') return win.setFullScreen(!win.isFullScreen());
    // Clipboard and undo belong to whatever has focus, which may well be the
    // page in the preview rather than the app shell.
    const wc = webContents.getFocusedWebContents() || win.webContents;
    if (['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'].includes(action)) wc[action]();
  });

  // --- project folders ---
  ipcMain.handle('project:info', () => projectInfo());
  ipcMain.handle('project:open', (_e, opts) => openFolder(opts || {}));
  ipcMain.handle('project:focus', (_e, { dir } = {}) => focusProject(dir));
  ipcMain.handle('project:close', (_e, { dir } = {}) => closeProject(dir));
  ipcMain.handle('project:reorder', (_e, { dirs } = {}) => {
    const kept = projects.setOpenProjects(dirs.filter((d) => open.has(d)));
    const reordered = new Map(kept.map((d) => [d, open.get(d)]));
    for (const [dir, rec] of open) if (!reordered.has(dir)) reordered.set(dir, rec);
    open.clear();
    for (const [dir, rec] of reordered) open.set(dir, rec);
    announce();
    return projectInfo();
  });
  ipcMain.handle('project:forget', (_e, { dir }) => { projects.forget(dir); refreshMenu(); return projectInfo(); });

  // --- terminal ---
  ipcMain.handle('term:create', (_e, { cwd, cols, rows, shell: sh, project } = {}) => {
    const id = 't' + (terms.size + 1) + '-' + Date.now().toString(36);
    const extraPath = path.join(ROOT, 'bin');
    // A shell belongs to the project it was opened in, so closing that project
    // takes its shells with it and leaves the other projects' alone.
    const home = project && open.has(project) ? project : focusedCwd();
    const t = new Terminal({
      id, cwd: cwd || home, cols, rows, shell: sh,
      env: {
        ...bridge.env(),
        // What `tandem ask` typed in here reads to find its way back to the
        // right project's chat.
        TANDEM_CWD: home,
        TANDEM_MCP_SERVER: path.join(ROOT, 'mcp', 'server.js'),
        // `tandem` first, then whatever the user's shell has, then the node shim.
        PATH: shellEnv.merge([extraPath], [...shellEnv.cached().split(path.delimiter), nodeShimDir()]),
        TANDEM_NODE: process.env.TANDEM_NODE || 'node',
      },
    });
    t.on('data', (data) => send('term:data', { id, data }));
    t.on('exit', (code) => { send('term:exit', { id, code }); terms.delete(id); });
    t.on('url', (url) => send('term:url', { id, url, project: home }));
    t.project = home;
    terms.set(id, t);
    return { id, shell: path.basename(t.shell), project: home };
  });
  ipcMain.on('term:input', (_e, { id, data }) => terms.get(id)?.write(data));
  ipcMain.on('term:resize', (_e, { id, cols, rows }) => terms.get(id)?.resize(cols, rows));
  ipcMain.on('term:kill', (_e, { id }) => { terms.get(id)?.kill(); terms.delete(id); });

  // --- agent ---
  // `session` is what the chat was last known as. A chat parked while idle has
  // no session under it any more, so the first message back resumes that
  // transcript rather than opening a second one beside it.
  ipcMain.handle('agent:send', async (_e, { chat, session, text, images, project }) => {
    const a = await ensureAgent({ chat, resume: session, project });
    a.send(text, images);
    return { ok: true, sessionId: a.sessionId };
  });
  ipcMain.handle('agent:interrupt', async (_e, { chat } = {}) => {
    await sessions.get(chat)?.interrupt();
    releaseChatEverywhere(chat);
    return { ok: true };
  });
  // Stopping one agent, not the turn it belongs to. `id` is the task id, which
  // is what task_started and the permission callback both call the agent.
  ipcMain.handle('agent:stopTask', async (_e, { chat, id } = {}) => {
    releaseTaskEverywhere(id);
    return sessions.get(chat)?.stopTask(id) ?? { error: 'that chat is not running' };
  });
  // Hand a blocking agent to the background so the turn carries on without it.
  ipcMain.handle('agent:background', async (_e, { chat, toolUseId } = {}) =>
    sessions.get(chat)?.background(toolUseId) ?? { error: 'that chat is not running' });
  // The human taking the preview back off whichever agent is driving it.
  ipcMain.handle('preview:seize', (_e, { tab } = {}) => {
    leaseFor(tab || shownTab).seize();
    return { ok: true };
  });
  ipcMain.handle('preview:driver', (_e, { tab } = {}) => {
    const key = tab || shownTab;
    return { holder: leaseFor(key).current(), tab: key, project: panes.get(key)?.project || focused };
  });
  ipcMain.handle('agent:mode', async (_e, { chat, mode }) => {
    // The last mode picked is what the next new chat starts on, and it outlives
    // the window: settings owns the same value the composer is showing.
    if (isMode(mode)) { chosenMode = mode; settings.patch({ agent: { mode } }); }
    return { mode: await sessions.get(chat)?.setMode(mode) ?? chosenMode };
  });
  // Answered from the driver cache. Asking the SDK would mean starting a
  // session, and the picker is drawn before anyone has said anything.
  ipcMain.handle('agent:models', () => {
    const d = driver.current();
    const current = settleModel() || anySession()?.model || '';
    // A name pinned against a proxy is not always one this app can see. Keep it
    // on the list rather than move someone to a different model without saying so.
    const models = current && !d.models.some((m) => m.value === current)
      ? [...d.models, { value: current, displayName: current, custom: true }]
      : d.models;
    return {
      models,
      current,
      installed: d.installed,
      version: d.version,
      message: d.message,
      endpoint: d.endpoint,
    };
  });
  ipcMain.handle('agent:setModel', async (_e, { model }) => {
    chosenModel = model || null;
    settings.patch({ agent: { model: chosenModel || '' } });
    // A name no probe offered is remembered for this endpoint, so it is still
    // in the picker after a restart.
    const d = chosenModel ? driver.remember(chosenModel) : driver.current({ refresh: false });
    // Every chat follows the picker, and a cold one starts on the choice.
    await Promise.all(liveSessions().map((a) => a.setModel(model)));
    return { model: chosenModel, models: d.models };
  });
  ipcMain.handle('agent:forgetModel', (_e, { model }) => {
    const d = driver.forget(model);
    if (chosenModel === model) {
      chosenModel = d.models[0]?.value || null;
      settings.patch({ agent: { model: chosenModel || '' } });
    }
    return { model: chosenModel, models: d.models };
  });
  // The two reports the meter opens onto. Both come off the live session, and
  // both are asked for only when someone opens the panel: the running totals it
  // draws first come from the message stream and cost nothing.
  ipcMain.handle('agent:usage', async (_e, { chat } = {}) => {
    const a = sessions.get(chat);
    if (!a) return { context: null, plan: null };
    const [context, plan] = await Promise.all([a.contextUsage(), a.planUsage()]);
    return { context, plan };
  });
  // Closing one chat, not the window. Whatever else is running stays running.
  ipcMain.handle('agent:reset', (_e, { chat } = {}) => ({ ok: stopChat(chat) }));

  // --- settings ---
  // The shell wants the theme, the zoom and the terminal font before it paints
  // anything, and a round trip through invoke() would show one frame of the
  // wrong theme. This is the one blocking read in the app.
  ipcMain.on('settings:sync', (e) => { e.returnValue = settings.all(); });
  ipcMain.handle('settings:get', () => settings.all());
  // Where all of this actually lives, for the About panel and for anyone who
  // would rather edit the file than click.
  ipcMain.handle('settings:paths', () => ({
    settings: settings.file,
    userData: app.getPath('userData'),
    downloads: app.getPath('downloads'),
    claude: claudeBinary(),
  }));
  ipcMain.handle('settings:reveal', () => {
    shell.showItemInFolder(settings.file);
    return { ok: true };
  });
  ipcMain.handle('settings:set', async (_e, partial) => {
    const next = settings.patch(partial || {});
    // A change to how freely the agent may act, or to which model it runs,
    // belongs to the sessions already up rather than only to the next one.
    if (partial?.agent?.mode && isMode(partial.agent.mode)) {
      chosenMode = partial.agent.mode;
      await Promise.all(liveSessions().map((a) => a.setMode(chosenMode)));
      send('agent:mode', { mode: chosenMode });
    }
    if (partial?.agent?.model !== undefined) {
      chosenModel = partial.agent.model || null;
      await Promise.all(liveSessions().map((a) => a.setModel(chosenModel)));
    }
    if (partial?.claude?.binary !== undefined) await applyClaudeBinary();
    send('settings:changed', next);
    return next;
  });
  ipcMain.handle('settings:reset', async () => {
    const next = settings.reset();
    await applyClaudeBinary();
    send('settings:changed', next);
    return next;
  });

  // --- updates ---
  ipcMain.handle('updates:info', () => updates.current());
  ipcMain.handle('updates:check', () => updates.check());
  ipcMain.handle('updates:download', async () => {
    try {
      const res = await updates.download((p) => send('updates:progress', p));
      return res;
    } catch (e) {
      return { error: e.message };
    }
  });
  ipcMain.handle('updates:install', (_e, { path: file } = {}) => {
    if (!file) return { error: 'nothing downloaded yet' };
    return updates.install(file);
  });
  ipcMain.handle('updates:openPage', () => {
    const page = updates.snapshot().app?.page;
    if (page) shell.openExternal(page);
    return { ok: !!page };
  });

  // --- attachments ---
  ipcMain.handle('attach:pick', () => attachments.pick(win));
  ipcMain.handle('attach:add', (_e, { paths } = {}) => attachments.add(paths));
  ipcMain.handle('attach:paste', (_e, payload = {}) => attachments.fromDataUrl(payload));

  // --- skills and MCP servers ---
  // Read off disk, so the panel can draw the list before any session exists.
  ipcMain.handle('catalog:info', () => catalog.current(focusedCwd()));
  ipcMain.handle('catalog:refresh', async () => {
    catalog.invalidate(focusedCwd());
    return learnCatalog();
  });
  ipcMain.handle('catalog:connectors', async (_e, { enabled }) => {
    const next = catalog.setConnectors(focusedCwd(), enabled);
    // The setting is read when a session starts, so a running one is told
    // separately; either way the next chat starts the way the switch says.
    await Promise.all(liveSessions().map((a) => a.setConnectors(enabled, catalog.offAtRuntime(focusedCwd()))));
    return next;
  });
  ipcMain.handle('catalog:skill', async (_e, { name, enabled }) => {
    const next = catalog.setSkill(focusedCwd(), name, enabled);
    const overrides = catalog.sessionSettings(focusedCwd()).skillOverrides || {};
    await Promise.all(liveSessions().map((a) => a.setSkillOverrides(overrides)));
    return next;
  });
  ipcMain.handle('catalog:mcpToggle', async (_e, { name, enabled }) => {
    const runtime = catalog.runtimeName(focusedCwd(), name);
    const next = catalog.setMcp(focusedCwd(), name, enabled);
    const done = await Promise.all(liveSessions().map((a) => a.toggleMcp(runtime, enabled)));
    return { ...next, error: done.find((r) => r?.error)?.error || null };
  });
  // An HTTP or SSE server behind OAuth cannot be authenticated from inside a
  // session: the SDK has no control request for it. The CLI does, so hand back
  // the command and let it run in one of the app's own shells, where the user
  // can see the browser prompt and answer it. The token it writes is the same
  // one the next chat reads.
  ipcMain.handle('catalog:mcpLogin', (_e, { name }) => {
    const server = catalog.current(focusedCwd()).mcp.find((s) => s.name === name);
    if (!server) return { error: `${name} is not a server this folder knows about` };
    if (server.type === 'stdio') return { error: `${name} runs as a local process, so there is nothing to sign in to` };
    const quote = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
    return { command: `${quote(claudeBinary() || 'claude')} mcp login ${quote(server.runtime)}` };
  });

  ipcMain.handle('catalog:mcpReconnect', async (_e, { name }) => {
    const agent = anySession();
    const res = agent
      ? await agent.reconnectMcp(catalog.runtimeName(focusedCwd(), name))
      : { error: 'no chat is running yet' };
    const next = await learnCatalog();
    return { ...next, error: res.error || null };
  });
  ipcMain.handle('catalog:mcpAdd', async (_e, { name, scope, config }) => {
    try {
      catalog.addServer(focusedCwd(), { name, scope, config });
    } catch (e) {
      return { error: e.message };
    }
    const done = await Promise.all(liveSessions().map((a) => a.addMcpServer(name, config)));
    const res = done.find((r) => r?.error) || {};
    const next = catalog.current(focusedCwd());
    return { ...next, error: res.error || null };
  });
  ipcMain.handle('catalog:mcpRemove', async (_e, { name, scope }) => {
    const runtime = catalog.runtimeName(focusedCwd(), name);
    try {
      catalog.removeServer(focusedCwd(), name, scope);
    } catch (e) {
      return { error: e.message };
    }
    await Promise.all(liveSessions().map((a) => a.removeMcpServer(runtime)));
    return catalog.current(focusedCwd());
  });

  // --- agent history ---
  // Every open project, because the rail is one list of folders now rather than
  // one folder's list. Each transcript is read once and its title cached, so the
  // cost of a refresh is a readdir and a stat per project.
  ipcMain.handle('agent:history', () => ({
    projects: openDirs().map((dir) => ({
      dir,
      name: path.basename(dir) || dir,
      sessions: listSessions(dir),
    })),
    running: liveSessions().map((a) => a.sessionId).filter(Boolean),
  }));
  ipcMain.handle('agent:transcript', async (_e, { id, project }) => {
    const dir = project && open.has(project) ? project : focusedCwd();
    const t = await readSession(dir, id);
    // Which agents ran, so a replayed chat draws their rows straight away. The
    // transcripts behind them are only read if someone opens one.
    return { ...t, subagents: listSubagents(dir, id) };
  });
  ipcMain.handle('agent:subagent', (_e, { session, agentId, project }) =>
    readSubagent(project && open.has(project) ? project : focusedCwd(), session, agentId));
  // Deleting a chat. A session still running would write its transcript
  // straight back after the unlink, so the process behind it goes first.
  ipcMain.handle('agent:deleteSession', (_e, { id, project } = {}) => {
    for (const [chat, a] of sessions) if (a.sessionId === id) stopChat(chat);
    try {
      return { ok: deleteSession(project && open.has(project) ? project : focusedCwd(), id) };
    } catch (e) {
      return { error: e.message };
    }
  });
  ipcMain.on('agent:active', (_e, { chat, session } = {}) => {
    activeChat = { chat: chat || 'main', session: session || null };
  });
  ipcMain.handle('agent:resume', async (_e, { chat, id, project }) => {
    const a = await ensureAgent({ chat, resume: id, project });
    return { ok: true, sessionId: a.sessionId || id };
  });
  ipcMain.on('agent:decide', (_e, { chat, id, decision, input }) =>
    sessions.get(chat)?.decide(id, decision, input));
  ipcMain.handle('agent:info', (_e, { chat } = {}) => {
    const a = sessions.get(chat);
    const cwd = cwdOfChat(chat);
    return {
      cwd,
      chosen: open.get(cwd)?.chosen ?? true,
      running: !!(a && !a.closed),
      sessionId: a?.sessionId || null,
      mode: a?.mode || chosenMode,
    };
  });

  // --- project files ---
  // The tree reads on demand: one folder per call, and a watch on each folder
  // that is open so the agent writing a file redraws the row rather than
  // leaving a stale one until someone hits refresh.
  // `project` on these is the tree the pane is drawing. It is normally the
  // focused one, and it is sent rather than assumed because a reply that raced
  // a project switch would otherwise fill one project's tree with another's
  // folders.
  const treeCwd = (dir) => (dir && open.has(dir) ? dir : focusedCwd());
  ipcMain.handle('files:list', (_e, { path: rel, project } = {}) => files.list(treeCwd(project), rel || ''));
  ipcMain.handle('files:read', (_e, { path: rel, project } = {}) => files.read(treeCwd(project), rel || ''));
  ipcMain.handle('files:search', (_e, { query, project } = {}) => files.search(treeCwd(project), query));
  ipcMain.on('files:watch', (_e, { dirs, project } = {}) => {
    // Which tree the change landed in. Every project has a src/, so the folder
    // on its own no longer says whose it is.
    if (!fileWatcher) fileWatcher = new files.Watcher((dir, root) => send('files:changed', { dir, root }));
    fileWatcher.sync(treeCwd(project), dirs);
  });
  ipcMain.handle('files:reveal', (_e, { path: rel } = {}) => {
    const abs = files.within(focusedCwd(), rel);
    if (!abs) return { error: 'that path is outside the project folder' };
    shell.showItemInFolder(abs);
    return { ok: true };
  });
  ipcMain.handle('files:openExternal', async (_e, { path: rel } = {}) => {
    const abs = files.within(focusedCwd(), rel);
    if (!abs) return { error: 'that path is outside the project folder' };
    const err = await shell.openPath(abs);
    return err ? { error: err } : { ok: true };
  });
  ipcMain.handle('files:absolute', (_e, { path: rel } = {}) => {
    const abs = files.within(focusedCwd(), rel);
    return abs ? { path: abs } : { error: 'that path is outside the project folder' };
  });

  // --- uncommitted changes ---
  // The list is cheap enough to ask for on a timer while the pane is showing;
  // the patch for one file is only fetched when that file is opened.
  ipcMain.handle('changes:list', (_e, { project } = {}) => diff.status(treeCwd(project)));
  ipcMain.handle('changes:patch', (_e, { path: rel, context, project } = {}) =>
    diff.patch(treeCwd(project), rel, { context }));

  // --- editors ---
  // What is installed, and handing the project folder to one of them.
  ipcMain.handle('editors:list', (_e, { fresh } = {}) => editors.detect({ fresh: !!fresh }));
  ipcMain.handle('editors:open', (_e, { id } = {}) => editors.open(id, focusedCwd()));

  // --- browser panes ---
  // The box belongs to the window and holds one preview at a time. Which one is
  // the shell's to say: it owns the tab strip and knows which tab is active in
  // the folder on screen.
  ipcMain.on('browser:bounds', (_e, b) => { lastBounds = b; paneOf(shownTab, { create: false })?.setBounds(b); });
  ipcMain.on('browser:visible', (_e, v) => {
    paneVisible = !!v;
    paneOf(shownTab, { create: false })?.setVisible(paneVisible);
  });
  ipcMain.on('browser:show', (_e, { tab, project } = {}) => {
    shownTab = tab || null;
    // A tab the shell knows about and main has never made a page for: opening
    // the column on a fresh preview tab is the ordinary way here.
    if (shownTab) paneOf(shownTab, { project: owner(project) });
    applyShown();
  });
  ipcMain.on('browser:closeTab', (_e, { tab } = {}) => { if (tab) dropPane(tab); });
  ipcMain.handle('browser:action', async (_e, { action, arg, tab, project }) => {
    // No tab named means the one in the box, and failing that the focused
    // folder's, which is what a bare `tandem go` from a shell means.
    const pane = tab
      ? paneOf(tab, { project: owner(project, tab) })
      : (paneOf(shownTab, { create: false }) || previewOf(focused).pane);
    if (!pane) return { error: 'no pane' };
    switch (action) {
      case 'navigate': return pane.navigate(arg);
      case 'back': return pane.back();
      case 'forward': return pane.forward();
      case 'reload': return pane.reload();
      case 'devtools': return pane.toggleDevTools();
      case 'state': return pane.state();
      case 'console': return pane.consoleLog({ limit: 200 });
      case 'network': return pane.networkLog({ limit: 100 });
      case 'screenshot': return pane.screenshot(arg || {});
      case 'still': return pane.still();
      case 'setViewport': return arg ? pane.setViewport(arg.width, arg.height) : pane.clearViewport();
      case 'openExternal': return shell.openExternal(pane.state().url);
      case 'pick': return pane.pick();
      // Where the pane actually sits. capturePage() photographs the window's
      // own web contents and leaves the pane out of the picture entirely, so
      // this is the only way to tell a parked pane from a visible one.
      case 'bounds': return pane.view.getBounds();
      case 'normalize': return normalizeUrl(arg);
      default: return { error: 'unknown action ' + action };
    }
  });
}

app.whenReady().then(async () => {
  refreshMenu();
  // Cheap: reads a cached JSON file, then runs `claude --version` in the
  // background if that file is stale. Nothing long-lived is started.
  // One `$SHELL -lic 'env'`, so the agent, its MCP servers and the model probe
  // see the directories and the credentials the user's own shell sees.
  // systemBinary() reads this, so the claude preference is applied after it
  // lands rather than against the launcher's stunted PATH.
  shellEnv.ready().then(() => applyClaudeBinary()).catch(() => {});
  driver = new Driver({ cacheDir: app.getPath('userData') });
  catalog = new Catalog({ cacheDir: app.getPath('userData') });
  updates = new Updates({ usingSystem: () => settings.get('claude').binary === 'path' });
  updates.on('changed', (snap) => send('updates:changed', snap));
  driverReady = driver.refresh()
    .then((d) => { send('agent:driver', { ...d, current: settleModel() }); return d; })
    .catch(() => null);
  if (open.get(focused)?.chosen) projects.remember(focused);
  projects.setOpenProjects(openDirs());
  bridge = new Bridge({
    cwds: openDirs(),
    // `tandem go 3000` typed in one project drives that project's preview.
    getPane: (cwd) => previewOf(cwd).pane,
    // A shell in project B asking to be raised means bring B forward, not just
    // the window it happens to share with A.
    focusWindow: (cwd) => {
      if (cwd && open.has(path.resolve(cwd))) focusProject(cwd);
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    },
    onActivity: (tool, args, cwd) => send('agent:activity', { tool, args, t: Date.now(), project: cwd || focused }),
    showPreview,
    command: (name, open) => { send('app:command', { name, open }); return { ok: true, name, open }; },
    // Development aid: answer the oldest pending permission prompt. Scoped to
    // the caller's project when it named one, so answering in project B does
    // not accidentally approve something project A is waiting on.
    decide: (decision, cwd) => {
      const mine = cwd && open.has(path.resolve(cwd)) ? path.resolve(cwd) : null;
      const agent = liveSessions().find((a) =>
        a.pending.size && (!mine || a.cwd === mine));
      const id = agent && [...agent.pending.keys()][0];
      if (!id) return { error: 'nothing pending' };
      agent.decide(id, decision);
      send('agent:decided', { id, decision });
      return { ok: true, id, decision };
    },
    // `tandem ask` typed in a shell. The terminal exports the project it was
    // opened in, so a question asked in project B lands in a B chat rather than
    // in whatever happens to be on screen.
    ask: async (text, cwd) => {
      const target = cwd && open.has(path.resolve(cwd)) ? path.resolve(cwd) : null;
      let { chat, session } = activeChat;
      if (target && cwdOfChat(chat) !== target) {
        // The most recent chat in that project, or a new one rooted there.
        chat = [...chatProjects].reverse().find(([, dir]) => dir === target)?.[0]
          || `ask:${path.basename(target)}`;
        session = sessions.get(chat)?.sessionId || null;
      }
      const a = await ensureAgent({ chat, resume: session, project: target || undefined });
      send('agent:echo', { text, chat, project: cwdOfChat(chat) });
      a.send(text);
      return { ok: true, sessionId: a.sessionId, chat };
    },
    captureWindow: async () => {
      if (!win) return { error: 'no window' };
      const img = await win.webContents.capturePage();
      const file = path.join(require('os').tmpdir(), 'tandem-shots', `window-${Date.now()}.png`);
      require('fs').mkdirSync(path.dirname(file), { recursive: true });
      require('fs').writeFileSync(file, img.toPNG());
      return { path: file, ...img.getSize() };
    },
  });
  await bridge.start();
  registerIpc();
  await createWindow();
  console.log(`[tandem] bridge listening on ${bridge.url}`);

  // One GitHub call and one npm call, after the window is up, and only if the
  // person left the launch check on. The answer is cached for six hours, so
  // opening several windows in an afternoon costs one round trip.
  if (settings.get('startup').checkUpdates) {
    updates.check()
      .then((snap) => send('updates:changed', snap))
      .catch(() => {});
  }

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { stopAllChats(); bridge?.stop(); });
