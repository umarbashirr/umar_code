'use strict';
const { makeLocator } = require('./find-binary');
const { AcpDriver, probeVersion } = require('./acp-driver');
const { AcpSession } = require('./acp-session');
const history = require('./stub-history');
const { createStubCatalog } = require('./stub-catalog');

const locate = makeLocator(['grok']);

const CATALOG = [
  { value: 'grok-4.7', displayName: 'Grok 4.7' },
  { value: 'grok-4.7-build-fast', displayName: 'Grok 4.7 Fast' },
  { value: 'grok-4.6', displayName: 'Grok 4.6' },
  { value: 'grok-4.5', displayName: 'Grok 4.5' },
];

const spec = {
  id: 'grok',
  cli: 'grok',
  argv: ['agent', 'stdio'],
  login: 'grok login',
  missing: 'No Grok CLI on your PATH. Install it from x.ai/cli, run grok login, then restart Tandem.',
  catalog: CATALOG,
  binary: () => locate.current(),
  updatesProbe: (bin) => probeVersion(bin),
};

function create({ cacheDir, settings }) {
  locate.prefer(settings?.get?.('grok')?.binary);
  const driver = new AcpDriver({ spec, cacheDir });
  return {
    id: 'grok',
    label: 'Grok',
    cli: 'grok',
    modelKey: 'grokModel',
    settingsKey: 'grok',
    catalogKind: 'stub',
    hasHistory: false,
    driver,
    catalog: createStubCatalog('Grok chats have no skills catalog in Tandem yet'),
    history,
    spec,
    preferBinary: (p) => locate.prefer(p),
    binary: () => locate.current(),
    createSession: (opts) => new AcpSession({ spec, ...opts }),
    has: () => !!driver.current({ refresh: false }).installed,
    install: 'See https://x.ai/cli',
    login: 'grok login',
    update: 'See https://x.ai/cli',
    missing: spec.missing,
    npmPackage: null,
  };
}

module.exports = { create, grokBinary: () => locate.current(), preferBinary: (p) => locate.prefer(p), probeVersion, CATALOG };
