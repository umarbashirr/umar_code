'use strict';
const path = require('path');
const { makeLocator } = require('./find-binary');
const { AcpDriver, probeVersion } = require('./acp-driver');
const { AcpSession } = require('./acp-session');
const history = require('./stub-history');
const { AcpCatalog } = require('./acp-catalog');

function acceptCursor(realPath, name) {
  const stem = path.basename(name).replace(/\.(exe|cmd|bat)$/i, '');
  if (stem === 'cursor-agent') return true;
  const base = path.basename(realPath);
  if (/\.grok[/\\]/i.test(realPath) || /^grok-/i.test(base) || /[/\\]grok-[^/\\]+$/i.test(realPath)) return false;
  return true;
}

const locate = makeLocator(['cursor-agent', 'agent'], acceptCursor);

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
  missing: 'No Cursor CLI (cursor-agent) on your PATH. Install it from cursor.com/cli, run agent login, then restart Tandem. Another tool named agent (e.g. Grok) can steal the name.',
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
    catalogKind: 'acp',
    hasHistory: false,
    driver,
    catalog: new AcpCatalog({ id: 'cursor', spec, cacheDir }),
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
