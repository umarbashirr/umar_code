'use strict';
// P1.5: catalog/MCP/skill ops must not fan out to every live session.
// They apply to Claude sessions rooted at the catalog folder only.
const path = require('path');
const fs = require('fs');

const ROOT = process.env.TANDEM_ROOT || path.join(__dirname, '..');
const failures = [];
const pass = (name) => console.log(`PASS ${name}`);
const fail = (name, detail) => {
  console.log(`FAIL ${name}: ${detail}`);
  failures.push(name);
};

function extract(src, name) {
  const re = new RegExp(`ipcMain\\.handle\\('${name}'[\\s\\S]*?\\n  \\}\\);`);
  const m = src.match(re);
  return m ? m[0] : '';
}

function checkIndexFilters() {
  const src = fs.readFileSync(path.join(ROOT, 'src/main/index.js'), 'utf8');

  if (!/catalogSessions\s*=/.test(src)) {
    fail('catalogSessions-helper', 'catalogSessions helper missing');
  } else {
    pass('catalogSessions-helper');
  }

  if (!/instanceof AgentSession/.test(src) || !/a\.cwd === dir/.test(src)) {
    fail('catalogSessions-filters', 'helper must keep AgentSession + matching cwd');
  } else {
    pass('catalogSessions-filters');
  }

  const handlers = [
    'catalog:connectors',
    'catalog:skill',
    'catalog:mcpToggle',
    'catalog:mcpAdd',
    'catalog:mcpRemove',
  ];
  for (const name of handlers) {
    const block = extract(src, name);
    if (!block) {
      fail(`${name}-present`, 'handler missing');
      continue;
    }
    if (/liveSessions\(\)\.map/.test(block)) {
      fail(`${name}-no-blind-fanout`, 'still fans liveSessions() without catalogSessions');
    } else if (/catalogSessions\(/.test(block)) {
      pass(`${name}-scoped`);
    } else {
      fail(`${name}-scoped`, 'no catalogSessions call in fan-out path');
    }
  }

  const reconnect = extract(src, 'catalog:mcpReconnect');
  if (!reconnect) {
    fail('catalog:mcpReconnect-present', 'handler missing');
  } else if (/anySession\(\)/.test(reconnect)) {
    fail('catalog:mcpReconnect-scoped', 'still uses anySession()');
  } else if (/catalogSessions\(/.test(reconnect)) {
    pass('catalog:mcpReconnect-scoped');
  } else {
    fail('catalog:mcpReconnect-scoped', 'does not prefer catalogSessions');
  }
}

function checkFilterBehavior() {
  // Mirror the helper rule without booting Electron.
  const AgentSession = function AgentSession(cwd) {
    this.cwd = cwd;
    this.closed = false;
  };
  const CodexSession = function CodexSession(cwd) {
    this.cwd = cwd;
    this.closed = false;
  };
  const sessions = [
    new AgentSession('/proj-a'),
    new AgentSession('/proj-b'),
    new CodexSession('/proj-a'),
    Object.assign(new AgentSession('/proj-a'), { closed: true }),
  ];
  const live = sessions.filter((a) => !a.closed);
  const catalogSessions = (dir) => live.filter((a) => a instanceof AgentSession && a.cwd === dir);
  const got = catalogSessions('/proj-a');
  if (got.length === 1 && got[0].cwd === '/proj-a') pass('filter-keeps-matching-claude');
  else fail('filter-keeps-matching-claude', `got ${got.length}`);
  if (catalogSessions('/proj-b').length === 1) pass('filter-other-project');
  else fail('filter-other-project', 'expected one AgentSession in /proj-b');
  if (catalogSessions('/missing').length === 0) pass('filter-empty');
  else fail('filter-empty', 'expected none');
}

checkIndexFilters();
checkFilterBehavior();

if (failures.length) {
  console.error(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.log('\nall checks passed');
