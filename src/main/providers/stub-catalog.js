'use strict';

function emptyListing() {
  return { live: false, connectors: true, skills: [], agents: [], mcp: [] };
}

function createStubCatalog(message) {
  const why = message || 'this CLI has no skills catalog in Tandem yet';
  const listing = () => emptyListing();
  return {
    current: listing,
    invalidate() {},
    learn() {},
    async refresh() { return emptyListing(); },
    async setSkill() { return emptyListing(); },
    async setMcp() { return emptyListing(); },
    setConnectors() { return emptyListing(); },
    runtimeName(_dir, name) { return name; },
    sessionSettings() { return {}; },
    offAtRuntime() { return []; },
    addServer() { throw new Error(why); },
    removeServer() { throw new Error(why); },
    mcpLogin() { return { error: why }; },
  };
}

module.exports = { createStubCatalog, emptyListing };
