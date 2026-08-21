'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
};

contextBridge.exposeInMainWorld('pba', {
  bridgeInfo: () => ipcRenderer.invoke('bridge:info'),

  win: {
    action: (action) => ipcRenderer.send('win:action', { action }),
    state: () => ipcRenderer.invoke('win:state'),
    onState: on('win:state'),
  },

  project: {
    info: () => ipcRenderer.invoke('project:info'),
    // No dir means "ask with the system folder picker".
    open: (opts) => ipcRenderer.invoke('project:open', opts || {}),
    forget: (dir) => ipcRenderer.invoke('project:forget', { dir }),
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
    action: (action, arg) => ipcRenderer.invoke('browser:action', { action, arg }),
    onState: on('browser:state'),
    onConsole: on('browser:console'),
  },

  agent: {
    onActivity: on('agent:activity'),
    send: (text) => ipcRenderer.invoke('agent:send', { text }),
    interrupt: () => ipcRenderer.invoke('agent:interrupt'),
    mode: (mode) => ipcRenderer.invoke('agent:mode', { mode }),
    models: () => ipcRenderer.invoke('agent:models'),
    setModel: (model) => ipcRenderer.invoke('agent:setModel', { model }),
    reset: () => ipcRenderer.invoke('agent:reset'),
    history: () => ipcRenderer.invoke('agent:history'),
    transcript: (id) => ipcRenderer.invoke('agent:transcript', { id }),
    resume: (id) => ipcRenderer.invoke('agent:resume', { id }),
    info: () => ipcRenderer.invoke('agent:info'),
    decide: (id, decision) => ipcRenderer.send('agent:decide', { id, decision }),
    onMessage: on('agent:message'),
    onReady: on('agent:ready'),
    onPermission: on('agent:permission'),
    onError: on('agent:error'),
    onClosed: on('agent:closed'),
    onEcho: on('agent:echo'),
    onDecided: on('agent:decided'),
    onStderr: on('agent:stderr'),
    onDriver: on('agent:driver'),
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

  onCommand: on('app:command'),
});
