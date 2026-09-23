'use strict';

const PROVIDER_IDS = ['claude', 'cursor', 'grok', 'opencode', 'codex'];
const isProviderId = (id) => PROVIDER_IDS.includes(id);

function createRegistry({ cacheDir, settings }) {
  const ctx = { cacheDir, settings };
  const rows = [
    require('./claude').create(ctx),
    require('./cursor').create(ctx),
    require('./grok').create(ctx),
    require('./opencode').create(ctx),
    require('./codex').create(ctx),
  ];
  for (const row of rows) {
    const bin = settings?.get?.(row.settingsKey)?.binary;
    if (bin) row.preferBinary(bin);
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  return {
    ids: rows.map((r) => r.id),
    all: () => rows,
    get: (id) => byId.get(id) || null,
    has: (id) => byId.has(id),
  };
}

module.exports = { createRegistry, isProviderId, PROVIDER_IDS };
