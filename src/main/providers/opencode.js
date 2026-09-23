'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeLocator } = require('./find-binary');
const { AcpDriver, probeVersion } = require('./acp-driver');
const { AcpSession } = require('./acp-session');
const history = require('./stub-history');
const { AcpCatalog } = require('./acp-catalog');

const locate = makeLocator(['opencode']);

const CATALOG = [
  { value: 'opencode/big-pickle', displayName: 'OpenCode Zen/Big Pickle' },
];

// OpenCode allows every edit and command unless its config says ask, and a
// request it never sends is one Tandem's modes cannot answer.
const ASK = JSON.stringify({ permission: { edit: 'ask', bash: 'ask', webfetch: 'ask' } });

// OpenCode caches models.dev's catalog, prices included, and refreshes it
// itself. Free is a zero input and output price there; a model the file does
// not know is not called free.
const PRICES = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'opencode', 'models.json');
let prices = { mtime: 0, byId: new Map() };

function priceList() {
  let mtime;
  try { mtime = fs.statSync(PRICES).mtimeMs; } catch { return prices.byId; }
  if (mtime === prices.mtime) return prices.byId;
  const byId = new Map();
  try {
    for (const [provider, p] of Object.entries(JSON.parse(fs.readFileSync(PRICES, 'utf8')))) {
      for (const [model, m] of Object.entries(p?.models || {})) byId.set(`${provider}/${model}`, m?.cost);
    }
  } catch {}
  prices = { mtime, byId };
  return byId;
}

function annotate(models) {
  const byId = priceList();
  return models.map((m) => {
    const cost = byId.get(m.value);
    return { ...m, free: !!cost && !(cost.input > 0) && !(cost.output > 0) };
  });
}

const spec = {
  id: 'opencode',
  cli: 'opencode',
  argv: ['acp'],
  env: () => ({ OPENCODE_CONFIG_CONTENT: ASK }),
  login: 'opencode auth login',
  missing: 'No opencode on your PATH. Install it from opencode.ai, run opencode auth login, then restart Tandem.',
  catalog: CATALOG,
  binary: () => locate.current(),
  updatesProbe: (bin) => probeVersion(bin),
};

function create({ cacheDir, settings }) {
  locate.prefer(settings?.get?.('opencode')?.binary);
  const driver = new AcpDriver({ spec, cacheDir });
  return {
    id: 'opencode',
    label: 'OpenCode',
    cli: 'opencode',
    modelKey: 'opencodeModel',
    settingsKey: 'opencode',
    catalogKind: 'acp',
    hasHistory: false,
    driver,
    catalog: new AcpCatalog({ id: 'opencode', spec, cacheDir }),
    history,
    spec,
    preferBinary: (p) => locate.prefer(p),
    binary: () => locate.current(),
    createSession: (opts) => new AcpSession({ spec, ...opts }),
    annotate,
    has: () => !!driver.current({ refresh: false }).installed,
    install: 'npm install -g opencode-ai',
    login: 'opencode auth login',
    update: 'opencode upgrade',
    missing: spec.missing,
    npmPackage: null,
  };
}

module.exports = { annotate, create, opencodeBinary: () => locate.current(), preferBinary: (p) => locate.prefer(p), probeVersion, CATALOG };
