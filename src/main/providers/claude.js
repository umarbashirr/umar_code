'use strict';
const { AgentSession } = require('../agent');
const { Driver, claudeBinary, preferBinary } = require('../driver');
const { Catalog } = require('../catalog');
const history = require('../history');

function create({ cacheDir, settings }) {
  const driver = new Driver({ cacheDir });
  const catalog = new Catalog({ cacheDir });
  preferBinary(settings?.get?.('claude')?.binary);
  return {
    id: 'claude',
    label: 'Claude',
    cli: 'claude',
    modelKey: 'model',
    settingsKey: 'claude',
    catalogKind: 'claude',
    hasHistory: true,
    driver,
    catalog,
    history,
    preferBinary,
    binary: claudeBinary,
    createSession: (opts) => new AgentSession({
      cwd: opts.cwd,
      invoke: opts.invoke,
      resume: opts.resume,
      model: opts.model,
      mode: opts.mode,
      effort: opts.effort,
      settings: opts.settings,
      mcpOff: opts.mcpOff,
      shared: opts.shared,
    }),
    has: () => true,
    install: 'npm install -g @anthropic-ai/claude-code',
    login: 'claude auth login',
    update: 'claude update',
    missing: 'No claude on your PATH. Install the Claude CLI and the models appear.',
    npmPackage: '@anthropic-ai/claude-code',
  };
}

module.exports = { create };
