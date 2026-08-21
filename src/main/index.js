'use strict';
const { app, BrowserWindow, ipcMain, shell, dialog, webContents } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const { BrowserPane, normalizeUrl } = require('./browser');
const { Terminal } = require('./terminal');
const { Bridge } = require('./bridge');
const { runTool } = require('./tools');
const { AgentSession, SHOT_NOTE } = require('./agent');
const { Driver, claudeBinary } = require('./driver');
const { Catalog } = require('./catalog');
const shellEnv = require('./shell-path');
const { listSessions, readSession } = require('./history');
const { applyMenu } = require('./menu');
const git = require('./git');
const projects = require('./projects');
const bridgeState = require('../../cli/state');

const fs = require('fs');

const ROOT = path.join(__dirname, '..', '..');
const HOME_URL = 'about:blank';
const isDev = process.argv.includes('--dev');

let win = null;
let pane = null;
let agent = null;
let bridge = null;
let driver = null;
let catalog = null;
let chosenModel = null;   // survives the agent it was picked for
let driverReady = null;
let lastBounds = null; // the renderer measures before the pane exists
const terms = new Map();

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function showPreview(open) {
  send('app:command', { name: 'preview', open });
  if (open === true && win && !win.isFocused()) win.show();
  return { ok: true, preview: open === undefined ? 'toggled' : open ? 'open' : 'closed' };
}

const toolContext = () => ({ getPane: () => pane, showPreview });

// The agent SDK and the MCP server both spawn `node`. A packaged app cannot
// assume the user has one, so leave a shim at the end of PATH that runs this
// binary as node.
function nodeShimDir() {
  const dir = path.join(app.getPath('userData'), 'bin');
  fs.mkdirSync(dir, { recursive: true });
  const shim = path.join(dir, 'node');
  const body = `#!/usr/bin/env sh\nELECTRON_RUN_AS_NODE=1 exec ${JSON.stringify(process.execPath)} "$@"\n`;
  try {
    if (!fs.existsSync(shim) || fs.readFileSync(shim, 'utf8') !== body) {
      fs.writeFileSync(shim, body, { mode: 0o755 });
    }
  } catch {}
  return dir;
}

const os = require('os');

// The folder everything in this window is rooted at: the agent, the shells, the
// chat history and the bridge file the CLI looks up. See projects.js for how it
// is picked at startup.
let project = projects.startProject();
const agentCwd = () => project.dir;

const projectInfo = () => ({
  dir: project.dir,
  name: path.basename(project.dir) || project.dir,
  branch: git.branch(project.dir),
  chosen: project.chosen,
  home: os.homedir(),
  recents: projects.recents().filter((r) => r.path !== project.dir),
});

function refreshMenu() {
  applyMenu({
    recents: projectInfo().recents,
    actions: {
      command: (name) => send('app:command', { name }),
      openFolder: (opts) => openFolder(opts),
      openRecent: (dir) => setProject(dir),
      clearRecents: () => { projects.clearRecents(); refreshMenu(); send('project:changed', projectInfo()); },
    },
  });
}

// Switching folders in place. The agent, the shells and the chat history all
// belong to the old folder, so they go with it; the window, the preview pane and
// the bridge port stay.
function setProject(dir) {
  const target = path.resolve(dir);
  if (!projects.isDir(target)) return { error: `${target} is not a folder` };
  if (target === project.dir && project.chosen) return projectInfo();

  agent?.stop();
  agent = null;
  for (const t of terms.values()) t.kill();
  terms.clear();

  project = { dir: target, chosen: true };
  projects.remember(target);
  catalog.invalidate();
  bridge?.setCwd(target);
  if (win && !win.isDestroyed()) win.setTitle(`${path.basename(target)} · pba`);
  refreshMenu();
  send('project:changed', projectInfo());
  send('agent:catalog', catalog.current(target));
  return projectInfo();
}

async function pickFolder(newWindow) {
  const res = await dialog.showOpenDialog(win, {
    title: newWindow ? 'Open folder in a new window' : 'Open folder',
    buttonLabel: 'Open',
    defaultPath: project.chosen ? path.dirname(project.dir) : os.homedir(),
    properties: ['openDirectory', 'createDirectory'],
  });
  return res.canceled ? null : res.filePaths[0];
}

async function openFolder({ dir, newWindow } = {}) {
  const target = dir || await pickFolder(newWindow);
  if (!target) return { canceled: true };
  return newWindow ? openInNewWindow(target) : setProject(target);
}

// Same rule the CLI uses: a folder that already has a window gets that window
// raised rather than a second one opened on it.
async function openInNewWindow(dir) {
  const target = path.resolve(dir);
  if (!projects.isDir(target)) return { error: `${target} is not a folder` };

  const open = bridgeState.forDir(target);
  if (open) {
    try {
      const res = await fetch(`${open.url}/focus`, { method: 'POST', headers: { 'x-pba-token': open.token } });
      if (res.ok) return { ok: true, focused: true, dir: target };
    } catch { /* dead or wedged: start a new one */ }
  }

  const viaAppImage = process.env.APPIMAGE && fs.existsSync(process.env.APPIMAGE);
  const bin = viaAppImage ? process.env.APPIMAGE : process.execPath;
  const args = !viaAppImage && process.defaultApp ? [app.getAppPath()] : [];

  const env = { ...process.env, PBA_CWD: target };
  delete env.PBA_BRIDGE_URL;
  delete env.PBA_TOKEN;
  delete env.PBA_MCP_SERVER;
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

async function ensureAgent({ resume } = {}) {
  // A resume has to replace whatever is running: the session id is fixed when
  // the query starts and cannot be changed afterwards.
  if (resume && agent) { agent.stop(); agent = null; }
  if (agent && !agent.closed) return agent;
  agent = new AgentSession({
    resume: resume || null,
    model: chosenModel,
    cwd: agentCwd(),
    settings: catalog.sessionSettings(agentCwd()),
    mcpOff: catalog.offAtRuntime(agentCwd()),
    invoke: async (tool, args) => {
      if (tool === 'navigate') showPreview(true);
      send('agent:activity', { tool, args, t: Date.now() });
      return runTool(tool, args, toolContext());
    },
  });
  agent.on('message', (m) => send('agent:message', lighten(m)));
  agent.on('ready', (r) => {
    send('agent:ready', r);
    // A running session knows the account's real entitlements; the catalogue in
    // driver.js can only infer them from a version number.
    agent.models().then((m) => driver.learn(m)).catch(() => {});
    // Same trade for skills and servers: the disk scan cannot see the built-in
    // commands or whether a server actually came up, but a session can.
    learnCatalog();
  });
  agent.on('permission', (p) => send('agent:permission', p));
  agent.on('error', (e) => send('agent:error', { error: e }));
  agent.on('closed', () => send('agent:closed', {}));
  agent.on('stderr', (d) => send('agent:stderr', { data: String(d).slice(0, 2000) }));
  await agent.start();
  return agent;
}

// Ask the running session what it ended up with, fold it into the cached
// listing, and push the result at the panel.
async function learnCatalog() {
  const dir = agentCwd();
  if (!agent || agent.closed) return catalog.current(dir);
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
    title: `${path.basename(agentCwd())} · pba`,
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
  driverReady?.then((d) => { if (d) send('agent:driver', d); });

  for (const ev of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
    win.on(ev, () => send('win:state', windowState()));
  }

  pane = new BrowserPane(win, HOME_URL);
  if (lastBounds) pane.setBounds(lastBounds);
  pane.on('state', (s) => send('browser:state', s));
  pane.on('console', (c) => send('browser:console', c));

  win.on('closed', () => {
    for (const t of terms.values()) t.kill();
    terms.clear();
    win = null;
    pane = null;
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

  // --- project folder ---
  ipcMain.handle('project:info', () => projectInfo());
  ipcMain.handle('project:open', (_e, opts) => openFolder(opts || {}));
  ipcMain.handle('project:forget', (_e, { dir }) => { projects.forget(dir); refreshMenu(); return projectInfo(); });

  // --- terminal ---
  ipcMain.handle('term:create', (_e, { cwd, cols, rows, shell: sh } = {}) => {
    const id = 't' + (terms.size + 1) + '-' + Date.now().toString(36);
    const extraPath = path.join(ROOT, 'bin');
    const t = new Terminal({
      id, cwd: cwd || agentCwd(), cols, rows, shell: sh,
      env: {
        ...bridge.env(),
        PBA_CWD: agentCwd(),
        PBA_MCP_SERVER: path.join(ROOT, 'mcp', 'server.js'),
        // `pba` first, then whatever the user's shell has, then the node shim.
        PATH: shellEnv.merge([extraPath], [...shellEnv.cached().split(path.delimiter), nodeShimDir()]),
        PBA_NODE: process.env.PBA_NODE || 'node',
      },
    });
    t.on('data', (data) => send('term:data', { id, data }));
    t.on('exit', (code) => { send('term:exit', { id, code }); terms.delete(id); });
    t.on('url', (url) => send('term:url', { id, url }));
    terms.set(id, t);
    return { id, shell: path.basename(t.shell) };
  });
  ipcMain.on('term:input', (_e, { id, data }) => terms.get(id)?.write(data));
  ipcMain.on('term:resize', (_e, { id, cols, rows }) => terms.get(id)?.resize(cols, rows));
  ipcMain.on('term:kill', (_e, { id }) => { terms.get(id)?.kill(); terms.delete(id); });

  // --- agent ---
  ipcMain.handle('agent:send', async (_e, { text }) => {
    const a = await ensureAgent();
    a.send(text);
    return { ok: true, sessionId: a.sessionId };
  });
  ipcMain.handle('agent:interrupt', async () => { await agent?.interrupt(); return { ok: true }; });
  ipcMain.handle('agent:mode', async (_e, { mode }) => ({ mode: await agent?.setPermissionMode(mode) ?? mode }));
  // Answered from the driver cache. Asking the SDK would mean starting a
  // session, and the picker is drawn before anyone has said anything.
  ipcMain.handle('agent:models', () => {
    const d = driver.current();
    return {
      models: d.models,
      current: chosenModel || agent?.model || d.models[0]?.value || '',
      installed: d.installed,
      version: d.version,
      message: d.message,
    };
  });
  ipcMain.handle('agent:setModel', async (_e, { model }) => {
    chosenModel = model || null;
    // Only a live session needs telling; a cold one is started on the choice.
    if (agent && !agent.closed) return { model: await agent.setModel(model) };
    return { model: chosenModel };
  });
  ipcMain.handle('agent:reset', () => { agent?.stop(); agent = null; return { ok: true }; });

  // --- skills and MCP servers ---
  // Read off disk, so the panel can draw the list before any session exists.
  ipcMain.handle('catalog:info', () => catalog.current(agentCwd()));
  ipcMain.handle('catalog:refresh', async () => {
    catalog.invalidate(agentCwd());
    return learnCatalog();
  });
  ipcMain.handle('catalog:connectors', async (_e, { enabled }) => {
    const next = catalog.setConnectors(agentCwd(), enabled);
    // The setting is read when a session starts, so a running one is told
    // separately; either way the next chat starts the way the switch says.
    if (agent && !agent.closed) {
      await agent.setConnectors(enabled, catalog.offAtRuntime(agentCwd()));
    }
    return next;
  });
  ipcMain.handle('catalog:skill', async (_e, { name, enabled }) => {
    const next = catalog.setSkill(agentCwd(), name, enabled);
    if (agent && !agent.closed) {
      await agent.setSkillOverrides(catalog.sessionSettings(agentCwd()).skillOverrides || {});
    }
    return next;
  });
  ipcMain.handle('catalog:mcpToggle', async (_e, { name, enabled }) => {
    const runtime = catalog.runtimeName(agentCwd(), name);
    const next = catalog.setMcp(agentCwd(), name, enabled);
    const res = agent && !agent.closed ? await agent.toggleMcp(runtime, enabled) : {};
    return { ...next, error: res.error || null };
  });
  // An HTTP or SSE server behind OAuth cannot be authenticated from inside a
  // session: the SDK has no control request for it. The CLI does, so hand back
  // the command and let it run in one of the app's own shells, where the user
  // can see the browser prompt and answer it. The token it writes is the same
  // one the next chat reads.
  ipcMain.handle('catalog:mcpLogin', (_e, { name }) => {
    const server = catalog.current(agentCwd()).mcp.find((s) => s.name === name);
    if (!server) return { error: `${name} is not a server this folder knows about` };
    if (server.type === 'stdio') return { error: `${name} runs as a local process, so there is nothing to sign in to` };
    const quote = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
    return { command: `${quote(claudeBinary() || 'claude')} mcp login ${quote(server.runtime)}` };
  });

  ipcMain.handle('catalog:mcpReconnect', async (_e, { name }) => {
    const res = agent && !agent.closed
      ? await agent.reconnectMcp(catalog.runtimeName(agentCwd(), name))
      : { error: 'no chat is running yet' };
    const next = await learnCatalog();
    return { ...next, error: res.error || null };
  });
  ipcMain.handle('catalog:mcpAdd', async (_e, { name, scope, config }) => {
    try {
      catalog.addServer(agentCwd(), { name, scope, config });
    } catch (e) {
      return { error: e.message };
    }
    const res = agent && !agent.closed ? await agent.addMcpServer(name, config) : {};
    const next = catalog.current(agentCwd());
    return { ...next, error: res.error || null };
  });
  ipcMain.handle('catalog:mcpRemove', async (_e, { name, scope }) => {
    const runtime = catalog.runtimeName(agentCwd(), name);
    try {
      catalog.removeServer(agentCwd(), name, scope);
    } catch (e) {
      return { error: e.message };
    }
    if (agent && !agent.closed) await agent.removeMcpServer(runtime);
    return catalog.current(agentCwd());
  });

  // --- agent history ---
  ipcMain.handle('agent:history', () => ({
    sessions: listSessions(agentCwd()),
    current: agent?.sessionId || null,
  }));
  ipcMain.handle('agent:transcript', (_e, { id }) => readSession(agentCwd(), id));
  ipcMain.handle('agent:resume', async (_e, { id }) => {
    const a = await ensureAgent({ resume: id });
    return { ok: true, sessionId: a.sessionId || id };
  });
  ipcMain.on('agent:decide', (_e, { id, decision }) => agent?.decide(id, decision));
  ipcMain.handle('agent:info', () => ({
    cwd: agentCwd(),
    chosen: project.chosen,
    running: !!(agent && !agent.closed),
    sessionId: agent?.sessionId || null,
    mode: agent?.permissionMode || 'default',
  }));

  // --- browser pane ---
  ipcMain.on('browser:bounds', (_e, b) => { lastBounds = b; pane?.setBounds(b); });
  ipcMain.on('browser:visible', (_e, v) => pane?.setVisible(!!v));
  ipcMain.handle('browser:action', async (_e, { action, arg }) => {
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
  // One `$SHELL -lic 'echo $PATH'`, so the agent and its MCP servers see the
  // directories the user's own shell sees.
  shellEnv.shellPath().catch(() => {});
  driver = new Driver({ cacheDir: app.getPath('userData') });
  catalog = new Catalog({ cacheDir: app.getPath('userData') });
  driverReady = driver.refresh().then((d) => { send('agent:driver', d); return d; }).catch(() => null);
  if (project.chosen) projects.remember(project.dir);
  bridge = new Bridge({
    cwd: agentCwd(),
    getPane: () => pane,
    focusWindow: () => {
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    },
    onActivity: (tool, args) => send('agent:activity', { tool, args, t: Date.now() }),
    showPreview,
    // Development aid: answer the oldest pending permission prompt.
    decide: (decision) => {
      const id = agent && [...agent.pending.keys()][0];
      if (!id) return { error: 'nothing pending' };
      agent.decide(id, decision);
      send('agent:decided', { id, decision });
      return { ok: true, id, decision };
    },
    ask: async (text) => {
      const a = await ensureAgent();
      send('agent:echo', { text });
      a.send(text);
      return { ok: true, sessionId: a.sessionId };
    },
    captureWindow: async () => {
      if (!win) return { error: 'no window' };
      const img = await win.webContents.capturePage();
      const file = path.join(require('os').tmpdir(), 'pba-shots', `window-${Date.now()}.png`);
      require('fs').mkdirSync(path.dirname(file), { recursive: true });
      require('fs').writeFileSync(file, img.toPNG());
      return { path: file, ...img.getSize() };
    },
  });
  await bridge.start();
  registerIpc();
  await createWindow();
  console.log(`[pba] bridge listening on ${bridge.url}`);

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { agent?.stop(); bridge?.stop(); });
