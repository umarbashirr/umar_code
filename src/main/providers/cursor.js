'use strict';
const { makeLocator } = require('./find-binary');
const { AcpDriver, probeVersion } = require('./acp-driver');
const { AcpSession } = require('./acp-session');
const history = require('./stub-history');
const { createStubCatalog } = require('./stub-catalog');

const locate = makeLocator(['agent', 'cursor-agent']);

const CATALOG = [
  { value: 'auto', displayName: 'Auto' },
  { value: 'composer-2', displayName: 'Composer' },
  { value: 'gpt-5.4', displayName: 'GPT-5.4' },
  { value: 'claude-opus-4.6', displayName: 'Claude Opus 4.6' },
  { value: 'claude-sonnet-4.6', displayName: 'Claude Sonnet 4.6' },
  { value: 'grok-4', displayName: 'Grok 4' },
];

const spec = {
  id: 'cursor',
  cli: 'agent',
  argv: ['acp'],
  login: 'agent login',
  missing: 'No Cursor CLI (agent) on your PATH. Install it from cursor.com/cli, run agent login, then restart Tandem.',
  catalog: CATALOG,
  binary: () => locate.current(),
  updatesProbe: (bin) => probeVersion(bin),
};

function create({ cacheDir, settings }) {
  locate.prefer(settings?.get?.('cursor')?.binary);
  const driver = new AcpDriver({ spec, cacheDir });
  return {
    id: 'cursor',
    label: 'Cursor',
    cli: 'agent',
    modelKey: 'cursorModel',
    settingsKey: 'cursor',
    catalogKind: 'stub',
    hasHistory: false,
    driver,
    catalog: createStubCatalog('Cursor chats have no skills catalog in Tandem yet'),
    history,
    spec,
    preferBinary: (p) => locate.prefer(p),
    binary: () => locate.current(),
    createSession: (opts) => new AcpSession({ spec, ...opts }),
    has: () => !!driver.current({ refresh: false }).installed,
    install: 'curl https://cursor.com/install -fsS | bash',
    login: 'agent login',
    update: 'agent update',
    missing: spec.missing,
    npmPackage: null,
  };
}

module.exports = { create, cursorBinary: () => locate.current(), preferBinary: (p) => locate.prefer(p), probeVersion, CATALOG };
