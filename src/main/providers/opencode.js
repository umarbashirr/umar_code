'use strict';
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

const spec = {
  id: 'opencode',
  cli: 'opencode',
  argv: ['acp'],
  env: () => ({ OPENCODE_CONFIG_CONTENT: ASK }),
  login: 'opencode auth login',
  missing: 'No opencode on your PATH. Install it with npm install -g opencode-ai, run opencode auth login, then restart Tandem.',
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
    has: () => !!driver.current({ refresh: false }).installed,
    install: 'npm install -g opencode-ai',
    login: 'opencode auth login',
    update: 'opencode upgrade',
    missing: spec.missing,
    npmPackage: 'opencode-ai',
  };
}

module.exports = { create, opencodeBinary: () => locate.current(), preferBinary: (p) => locate.prefer(p), probeVersion, CATALOG };
