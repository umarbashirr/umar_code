'use strict';
const { contextBridge, ipcRenderer, webFrame, webUtils } = require('electron');

const on = (channel) => (cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
};

contextBridge.exposeInMainWorld('tandem', {
  bridgeInfo: () => ipcRenderer.invoke('bridge:info'),

  win: {
    action: (action) => ipcRenderer.send('win:action', { action }),
    // Scales the whole app shell: toolbar, rail, chat, files and the terminal
    // text. The preview pane is a separate web contents and keeps its own zoom.
    zoom: (factor) => { webFrame.setZoomFactor(factor); return webFrame.getZoomFactor(); },
    state: () => ipcRenderer.invoke('win:state'),
    onState: on('win:state'),
  },

  project: {
    info: () => ipcRenderer.invoke('project:info'),
    // No dir means "ask with the system folder picker".
    open: (opts) => ipcRenderer.invoke('project:open', opts || {}),
    forget: (dir) => ipcRenderer.invoke('project:forget', { dir }),
    // Which of the open folders the right-hand column is showing. Cheap: no
    // chat stops and no shell dies, because the folder being looked at and the
    // folders doing work are different questions.
    focus: (dir) => ipcRenderer.invoke('project:focus', { dir }),
    close: (dir) => ipcRenderer.invoke('project:close', { dir }),
    reorder: (dirs) => ipcRenderer.invoke('project:reorder', { dirs }),
    onChanged: on('project:changed'),
  },

  term: {
    create: (opts) => ipcRenderer.invoke('term:create', opts),
    input: (id, data) => ipcRenderer.send('term:input', { id, data }),
    resize: (id, cols, rows) => ipcRenderer.send('term:resize', { id, cols, rows }),
    kill: (id) => ipcRenderer.send('term:kill', { id }),
    onData: on('term:data'),
    onExit: on('term:exit'),
    onUrl: on('term:url'),
  },

  browser: {
    setBounds: (b) => ipcRenderer.send('browser:bounds', b),
    setVisible: (v) => ipcRenderer.send('browser:visible', v),
    // A preview belongs to a tab in the right column, and a folder can have
    // several. No tab named means the one in the box.
    // `project` is only a hint about who the tab belongs to, for the case where
    // main is making the page before the shell has said which strip it is in.
    action: (action, arg, tab, project) => ipcRenderer.invoke('browser:action', { action, arg, tab, project }),
    // Which preview belongs in the box. The shell owns the strip, so the shell
    // is what says; null means the column is shut or is showing something that
    // is not a preview.
    show: (tab, project) => ipcRenderer.send('browser:show', { tab, project }),
    closeTab: (tab) => ipcRenderer.send('browser:closeTab', { tab }),
    onState: on('browser:state'),
    onConsole: on('browser:console'),
    // An agent asked for a preview in a folder with no tab open for one, so
    // main made the page and minted the id. The shell draws the tab.
    onOpenTab: on('preview:tab'),
    // Which agent is driving that preview, and taking it back off them.
    driver: (tab) => ipcRenderer.invoke('preview:driver', { tab }),
    seize: (tab) => ipcRenderer.invoke('preview:seize', { tab }),
    onDriver: on('preview:driver'),
  },

  // The project folder as a tree. Reads only: nothing here writes to disk.
  files: {
    list: (path, project) => ipcRenderer.invoke('files:list', { path, project }),
    read: (path, project) => ipcRenderer.invoke('files:read', { path, project }),
    search: (query, project) => ipcRenderer.invoke('files:search', { query, project }),
    // The full set of folders the tree currently has expanded, sent whenever it
    // changes so main can reconcile its watches in one go.
    watch: (dirs, project) => ipcRenderer.send('files:watch', { dirs, project }),
    reveal: (path) => ipcRenderer.invoke('files:reveal', { path }),
    openExternal: (path) => ipcRenderer.invoke('files:openExternal', { path }),
    absolute: (path) => ipcRenderer.invoke('files:absolute', { path }),
    onChanged: on('files:changed'),
  },

  // The editors this machine has, and opening the project folder in one.
  editors: {
    list: (fresh) => ipcRenderer.invoke('editors:list', { fresh: !!fresh }),
    open: (id) => ipcRenderer.invoke('editors:open', { id }),
  },

  // What has changed in the working tree and not been committed. The list is
  // one call, each file's patch is another, because a repo mid-refactor holds
  // more diff than is worth sending at once.
  changes: {
    list: (project) => ipcRenderer.invoke('changes:list', { project }),
    // context: 'full' for the whole file with the changes in place, 'hunks' for
    // the few lines around each one.
    patch: (path, context, project) => ipcRenderer.invoke('changes:patch', { path, context, project }),
  },

  // Everything that drives one conversation takes the panel's key for it, so
  // several can run at once and each event finds its way back.
  agent: {
    onActivity: on('agent:activity'),
    send: (chat, session, text, images, project) => ipcRenderer.invoke('agent:send', { chat, session, text, images, project }),
    interrupt: (chat) => ipcRenderer.invoke('agent:interrupt', { chat }),
    // One subagent, by the id task_started gave it.
    stopTask: (chat, id) => ipcRenderer.invoke('agent:stopTask', { chat, id }),
    background: (chat, toolUseId) => ipcRenderer.invoke('agent:background', { chat, toolUseId }),
    subagent: (session, agentId, project) => ipcRenderer.invoke('agent:subagent', { session, agentId, project }),
    mode: (chat, mode) => ipcRenderer.invoke('agent:mode', { chat, mode }),
    models: () => ipcRenderer.invoke('agent:models'),
    setModel: (model) => ipcRenderer.invoke('agent:setModel', { model }),
    forgetModel: (model) => ipcRenderer.invoke('agent:forgetModel', { model }),
    reset: (chat) => ipcRenderer.invoke('agent:reset', { chat }),
    usage: (chat) => ipcRenderer.invoke('agent:usage', { chat }),
    active: (chat, session) => ipcRenderer.send('agent:active', { chat, session }),
    history: () => ipcRenderer.invoke('agent:history'),
    transcript: (id, project) => ipcRenderer.invoke('agent:transcript', { id, project }),
    resume: (chat, id, project) => ipcRenderer.invoke('agent:resume', { chat, id, project }),
    deleteSession: (id, project) => ipcRenderer.invoke('agent:deleteSession', { id, project }),
    // Marking a chat done. Nothing is deleted: the rail folds it away and the
    // transcript stays exactly where it was.
    complete: (id, done) => ipcRenderer.invoke('agent:complete', { id, done }),
    info: (chat) => ipcRenderer.invoke('agent:info', { chat }),
    decide: (chat, id, decision, input) => ipcRenderer.send('agent:decide', { chat, id, decision, input }),
    onMessage: on('agent:message'),
    onReady: on('agent:ready'),
    onPermission: on('agent:permission'),
    onMode: on('agent:mode'),
    onError: on('agent:error'),
    onClosed: on('agent:closed'),
    onEcho: on('agent:echo'),
    onDecided: on('agent:decided'),
    onStderr: on('agent:stderr'),
    onDriver: on('agent:driver'),
  },

  // Files the human hands to the chat. Pictures come back with their bytes so
  // the model can look at them; everything else comes back as a path.
  attach: {
    pick: () => ipcRenderer.invoke('attach:pick'),
    add: (paths) => ipcRenderer.invoke('attach:add', { paths }),
    paste: (dataUrl, name) => ipcRenderer.invoke('attach:paste', { dataUrl, name }),
    // Chromium stopped putting a path on dropped File objects, and this is the
    // sanctioned way back to one.
    pathFor: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
  },

  // Skills and MCP servers, read off disk so the lists draw without a session.
  catalog: {
    info: () => ipcRenderer.invoke('catalog:info'),
    refresh: () => ipcRenderer.invoke('catalog:refresh'),
    skill: (name, enabled) => ipcRenderer.invoke('catalog:skill', { name, enabled }),
    connectors: (enabled) => ipcRenderer.invoke('catalog:connectors', { enabled }),
    mcpToggle: (name, enabled) => ipcRenderer.invoke('catalog:mcpToggle', { name, enabled }),
    mcpReconnect: (name) => ipcRenderer.invoke('catalog:mcpReconnect', { name }),
    mcpLogin: (name) => ipcRenderer.invoke('catalog:mcpLogin', { name }),
    mcpAdd: (server) => ipcRenderer.invoke('catalog:mcpAdd', server),
    mcpRemove: (name, scope) => ipcRenderer.invoke('catalog:mcpRemove', { name, scope }),
    onChanged: on('agent:catalog'),
  },

  // The one blocking read in the app: the shell needs the theme and the
  // terminal font before its first paint, and an async round trip would show a
  // frame of the wrong one. Everything else here is async.
  settings: {
    snapshot: () => ipcRenderer.sendSync('settings:sync'),
    get: () => ipcRenderer.invoke('settings:get'),
    set: (partial) => ipcRenderer.invoke('settings:set', partial),
    reset: () => ipcRenderer.invoke('settings:reset'),
    paths: () => ipcRenderer.invoke('settings:paths'),
    reveal: () => ipcRenderer.invoke('settings:reveal'),
    onChanged: on('settings:changed'),
  },

  // Whether a newer Tandem or a newer Claude CLI exists, and fetching the one
  // that matches how this copy was installed.
  updates: {
    info: () => ipcRenderer.invoke('updates:info'),
    check: () => ipcRenderer.invoke('updates:check'),
    download: () => ipcRenderer.invoke('updates:download'),
    install: (path) => ipcRenderer.invoke('updates:install', { path }),
    openPage: () => ipcRenderer.invoke('updates:openPage'),
    onProgress: on('updates:progress'),
    onChanged: on('updates:changed'),
  },

  onCommand: on('app:command'),
});
