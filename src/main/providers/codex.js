'use strict';
const { CodexSession } = require('../codex');
const { CodexDriver, preferBinary, codexBinary } = require('../codex-driver');
const { CodexCatalog } = require('../codex-catalog');
const history = require('../codex-history');

function create({ cacheDir, settings }) {
  const driver = new CodexDriver({ cacheDir });
  const catalog = new CodexCatalog({ cacheDir });
  preferBinary(settings?.get?.('codex')?.binary);
  return {
    id: 'codex',
    label: 'ChatGPT',
    cli: 'codex',
    modelKey: 'codexModel',
    settingsKey: 'codex',
    catalogKind: 'codex',
    hasHistory: true,
    driver,
    catalog,
    history,
    preferBinary,
    binary: codexBinary,
    createSession: (opts) => new CodexSession({
      cwd: opts.cwd,
      resume: opts.resume,
      model: opts.model,
      mode: opts.mode,
      effort: opts.effort,
      bridgeEnv: opts.bridgeEnv,
    }),
    has: () => !!driver.current({ refresh: false }).installed,
    install: 'npm install -g @openai/codex',
    login: 'codex login',
    update: 'npm install -g @openai/codex',
    missing: 'No codex on your PATH. Install the Codex CLI, run codex login, then restart Tandem.',
    npmPackage: '@openai/codex',
  };
}

module.exports = { create };
