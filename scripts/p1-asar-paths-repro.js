'use strict';
// Harness for P1: asar paths handed to system node and shells.
// Proves path rewriting, unpack list, and call-site wiring without a full package.
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const os = require('os');

const ROOT = process.env.TANDEM_ROOT || path.join(__dirname, '..');
const failures = [];
const pass = (name) => console.log(`PASS ${name}`);
const fail = (name, detail) => {
  console.log(`FAIL ${name}: ${detail}`);
  failures.push(name);
};

function loadExternalPath() {
  const mod = path.join(ROOT, 'src', 'main', 'packaged-path.js');
  if (!fs.existsSync(mod)) {
    fail('packaged-path-module', 'src/main/packaged-path.js missing');
    return null;
  }
  pass('packaged-path-module');
  return require(mod);
}

function checkRewrite(api) {
  if (!api || typeof api.externalPath !== 'function') {
    fail('externalPath-export', 'externalPath not exported');
    return;
  }
  pass('externalPath-export');

  const cases = [
    [
      '/opt/tandem/resources/app.asar/mcp/server.js',
      '/opt/tandem/resources/app.asar.unpacked/mcp/server.js',
    ],
    [
      '/opt/tandem/resources/app.asar/bin',
      '/opt/tandem/resources/app.asar.unpacked/bin',
    ],
    [
      'C:\\Users\\x\\AppData\\Local\\Programs\\tandem\\resources\\app.asar\\mcp\\server.js',
      'C:\\Users\\x\\AppData\\Local\\Programs\\tandem\\resources\\app.asar.unpacked\\mcp\\server.js',
    ],
    ['/home/dev/umar_code/mcp/server.js', '/home/dev/umar_code/mcp/server.js'],
    [
      '/opt/tandem/resources/app.asar.unpacked/mcp/server.js',
      '/opt/tandem/resources/app.asar.unpacked/mcp/server.js',
    ],
  ];
  for (const [input, want] of cases) {
    const got = api.externalPath(input);
    if (got === want) pass(`rewrite-${path.basename(input) || 'rootish'}-${input.includes('unpacked') ? 'idempotent' : input.includes('app.asar') ? 'asar' : 'plain'}`);
    else fail(`rewrite-${input}`, `got ${got}, want ${want}`);
  }

  if (typeof api.mcpServerPath === 'function') {
    const got = api.mcpServerPath('/opt/tandem/resources/app.asar');
    const want = '/opt/tandem/resources/app.asar.unpacked/mcp/server.js';
    if (got === want) pass('mcpServerPath');
    else fail('mcpServerPath', `got ${got}`);
  } else {
    fail('mcpServerPath', 'not exported');
  }

  if (typeof api.binDir === 'function') {
    const got = api.binDir('/opt/tandem/resources/app.asar');
    const want = '/opt/tandem/resources/app.asar.unpacked/bin';
    if (got === want) pass('binDir');
    else fail('binDir', `got ${got}`);
  } else {
    fail('binDir', 'not exported');
  }
}

function checkAsarUnpack() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const unpack = pkg.build?.asarUnpack || [];
  const need = [
    'mcp/**',
    'cli/**',
    'bin/**',
    'node_modules/zod/**',
    'node_modules/@modelcontextprotocol/sdk/**',
  ];
  for (const pattern of need) {
    if (unpack.includes(pattern)) pass(`asarUnpack-${pattern}`);
    else fail(`asarUnpack-${pattern}`, `missing from asarUnpack: ${JSON.stringify(unpack)}`);
  }
}

function checkCallSites() {
  const indexSrc = fs.readFileSync(path.join(ROOT, 'src/main/index.js'), 'utf8');
  const bridgeUi = fs.readFileSync(path.join(ROOT, 'src/renderer/ui/shell/bridge.js'), 'utf8');

  if (/require\(['"]\.\/packaged-path['"]\)/.test(indexSrc) || /packaged-path/.test(indexSrc)) {
    pass('index-imports-packaged-path');
  } else {
    fail('index-imports-packaged-path', 'index.js does not use packaged-path');
  }

  // bridge:info and term env must not hand bare path.join(ROOT, 'mcp', ...) without rewrite.
  const bareMcp = /path\.join\(\s*ROOT\s*,\s*['"]mcp['"]\s*,\s*['"]server\.js['"]\s*\)/;
  const bareBin = /path\.join\(\s*ROOT\s*,\s*['"]bin['"]\s*\)/;
  if (bareMcp.test(indexSrc)) fail('index-bare-mcp-join', 'still joins ROOT/mcp/server.js without externalPath');
  else pass('index-no-bare-mcp-join');
  if (bareBin.test(indexSrc)) fail('index-bare-bin-join', 'still joins ROOT/bin without externalPath');
  else pass('index-no-bare-bin-join');

  if (/mcpServerPath|externalPath/.test(indexSrc) && /bridge:info/.test(indexSrc)) {
    pass('bridge-info-uses-rewrite');
  } else {
    fail('bridge-info-uses-rewrite', 'bridge:info does not use mcpServerPath/externalPath');
  }

  // Copied MCP add command must not hard-code bare `node` without the shim path from info.
  if (/info\.node|info\.npm|TANDEM_NODE/.test(bridgeUi) || /\$\{info\.(node|mcpNode|nodeBin)\}/.test(bridgeUi)) {
    pass('ui-mcp-command-uses-info-node');
  } else if (/claude mcp add tandem -- node \$\{info\.mcp\}/.test(bridgeUi)) {
    fail('ui-mcp-command-uses-info-node', 'still hard-codes system node before info.mcp');
  } else {
    fail('ui-mcp-command-uses-info-node', 'command construction unclear');
  }

  // Codex stays out of scope: do not require changes there.
  const codexSrc = fs.readFileSync(path.join(ROOT, 'src/main/codex.js'), 'utf8');
  if (/packaged-path/.test(codexSrc)) {
    fail('codex-out-of-scope', 'codex.js was modified; Codex is out of scope for this fix');
  } else {
    pass('codex-untouched');
  }
}

function checkRuntimeAsarSemantics() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-asar-'));
  const appDir = path.join(tmp, 'app');
  fs.mkdirSync(path.join(appDir, 'mcp'), { recursive: true });
  fs.writeFileSync(
    path.join(appDir, 'mcp', 'server.js'),
    "console.log('ENTRY_OK');\n",
  );

  let asarPackOk = false;
  const asarJs = path.join(ROOT, 'node_modules', '@electron', 'asar', 'bin', 'asar.js');
  const resources = path.join(tmp, 'resources');
  fs.mkdirSync(resources, { recursive: true });
  const asarPath = path.join(resources, 'app.asar');

  if (fs.existsSync(asarJs)) {
    const packed = spawnSync(process.execPath, [asarJs, 'pack', appDir, asarPath], { encoding: 'utf8' });
    asarPackOk = packed.status === 0 && fs.existsSync(asarPath);
  } else {
    // Opaque file stand-in when asar tooling is not installed yet.
    fs.writeFileSync(asarPath, 'not-a-directory');
    asarPackOk = true;
  }

  if (!asarPackOk) {
    fail('asar-fixture', 'could not create app.asar fixture');
    return;
  }
  pass('asar-fixture');

  const asarEntry = path.join(asarPath, 'mcp', 'server.js');
  const viaAsar = spawnSync(process.execPath, [asarEntry], { encoding: 'utf8' });
  if (viaAsar.status !== 0) pass('system-node-rejects-asar-path');
  else fail('system-node-rejects-asar-path', 'system node unexpectedly ran asar path');

  const unpacked = path.join(resources, 'app.asar.unpacked', 'mcp');
  fs.mkdirSync(unpacked, { recursive: true });
  fs.copyFileSync(path.join(appDir, 'mcp', 'server.js'), path.join(unpacked, 'server.js'));
  const viaUnpacked = spawnSync(process.execPath, [path.join(unpacked, 'server.js')], { encoding: 'utf8' });
  if (viaUnpacked.status === 0 && /ENTRY_OK/.test(viaUnpacked.stdout || '')) {
    pass('system-node-runs-unpacked-path');
  } else {
    fail('system-node-runs-unpacked-path', viaUnpacked.stderr || viaUnpacked.stdout || 'no output');
  }

  // PATH cannot treat app.asar/bin as a directory.
  const asarBin = path.join(asarPath, 'bin');
  let asarBinIsDir = false;
  try {
    asarBinIsDir = fs.statSync(asarBin).isDirectory();
  } catch {
    asarBinIsDir = false;
  }
  if (!asarBinIsDir) pass('asar-bin-not-a-real-dir');
  else fail('asar-bin-not-a-real-dir', 'app.asar/bin resolved as a directory for system fs');

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}

function main() {
  console.log('P1 asar-paths harness');
  const api = loadExternalPath();
  checkRewrite(api);
  checkAsarUnpack();
  checkCallSites();
  checkRuntimeAsarSemantics();

  if (failures.length) {
    console.log(`\n${failures.length} failure(s): ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('\nAll checks passed.');
}

main();
