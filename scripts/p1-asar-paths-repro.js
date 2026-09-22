'use strict';
// Harness for P1: asar paths handed to system node and shells.
// Contract: bin/cli go through app.asar.unpacked for shells. MCP stays inside
// app.asar and is launched with the electron-as-node shim so packed deps resolve.
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

function loadApi() {
  const mod = path.join(ROOT, 'cli', 'packaged-path.js');
  if (!fs.existsSync(mod)) {
    fail('packaged-path-module', 'cli/packaged-path.js missing');
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
      '/opt/tandem/resources/app.asar/bin',
      '/opt/tandem/resources/app.asar.unpacked/bin',
    ],
    [
      'C:\\Users\\x\\AppData\\Local\\Programs\\tandem\\resources\\app.asar\\bin',
      'C:\\Users\\x\\AppData\\Local\\Programs\\tandem\\resources\\app.asar.unpacked\\bin',
    ],
    ['/home/dev/umar_code/bin', '/home/dev/umar_code/bin'],
    [
      '/opt/tandem/resources/app.asar.unpacked/bin',
      '/opt/tandem/resources/app.asar.unpacked/bin',
    ],
  ];
  for (const [input, want] of cases) {
    const got = api.externalPath(input);
    if (got === want) pass(`external-${input.includes('unpacked') ? 'idempotent' : input.includes('app.asar') ? 'asar' : 'plain'}`);
    else fail(`external-${input}`, `got ${got}, want ${want}`);
  }

  if (typeof api.mcpServerPath !== 'function') {
    fail('mcpServerPath', 'not exported');
  } else {
    const fromAsar = api.mcpServerPath('/opt/tandem/resources/app.asar');
    const wantAsar = '/opt/tandem/resources/app.asar/mcp/server.js';
    if (fromAsar === wantAsar) pass('mcpServerPath-stays-asar');
    else fail('mcpServerPath-stays-asar', `got ${fromAsar}`);

    const fromUnpacked = api.mcpServerPath('/opt/tandem/resources/app.asar.unpacked');
    if (fromUnpacked === wantAsar) pass('mcpServerPath-maps-unpacked-root');
    else fail('mcpServerPath-maps-unpacked-root', `got ${fromUnpacked}`);
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
  for (const pattern of ['cli/**', 'bin/**']) {
    if (unpack.includes(pattern)) pass(`asarUnpack-${pattern}`);
    else fail(`asarUnpack-${pattern}`, `missing from asarUnpack: ${JSON.stringify(unpack)}`);
  }
  if (unpack.includes('mcp/**')) {
    fail('asarUnpack-no-mcp', 'mcp/** must stay packed so electron-as-node can resolve deps');
  } else {
    pass('asarUnpack-no-mcp');
  }
}

function checkCallSites() {
  const indexSrc = fs.readFileSync(path.join(ROOT, 'src/main/index.js'), 'utf8');
  const bridgeUi = fs.readFileSync(path.join(ROOT, 'src/renderer/ui/shell/bridge.js'), 'utf8');
  const cliSrc = fs.readFileSync(path.join(ROOT, 'cli/tandem.js'), 'utf8');

  if (/packaged-path/.test(indexSrc)) pass('index-imports-packaged-path');
  else fail('index-imports-packaged-path', 'index.js does not use packaged-path');

  const bareMcp = /path\.join\(\s*ROOT\s*,\s*['"]mcp['"]\s*,\s*['"]server\.js['"]\s*\)/;
  const bareBin = /path\.join\(\s*ROOT\s*,\s*['"]bin['"]\s*\)/;
  if (bareMcp.test(indexSrc)) fail('index-bare-mcp-join', 'still joins ROOT/mcp/server.js without mcpServerPath');
  else pass('index-no-bare-mcp-join');
  if (bareBin.test(indexSrc)) fail('index-bare-bin-join', 'still joins ROOT/bin without binDir');
  else pass('index-no-bare-bin-join');

  if (/mcpServerPath/.test(indexSrc) && /bridge:info/.test(indexSrc) && /node:\s*path\.join\(nodeShimDir/.test(indexSrc)) {
    pass('bridge-info-mcp-and-shim');
  } else {
    fail('bridge-info-mcp-and-shim', 'bridge:info must return mcpServerPath and shim node');
  }

  if (/TANDEM_NODE:.*nodeShimDir/.test(indexSrc.replace(/\n/g, ' '))) pass('pty-tandem-node-shim');
  else fail('pty-tandem-node-shim', 'term:create must default TANDEM_NODE to the shim');

  if (/info\.node/.test(bridgeUi)) pass('ui-mcp-command-uses-info-node');
  else fail('ui-mcp-command-uses-info-node', 'still hard-codes system node');

  if (/packaged-path/.test(cliSrc) && /mcpServerPath/.test(cliSrc)) pass('cli-uses-mcpServerPath');
  else fail('cli-uses-mcpServerPath', 'cli/tandem.js setup must use mcpServerPath');

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
  fs.mkdirSync(path.join(appDir, 'node_modules'), { recursive: true });
  fs.writeFileSync(
    path.join(appDir, 'mcp', 'server.js'),
    "console.log('ENTRY_OK'); const z = require('zod'); console.log('ZOD', typeof z.z);\n",
  );

  const zodSrc = path.join(ROOT, 'node_modules', 'zod');
  if (fs.existsSync(zodSrc)) {
    fs.cpSync(zodSrc, path.join(appDir, 'node_modules', 'zod'), { recursive: true });
  }

  const asarJs = path.join(ROOT, 'node_modules', '@electron', 'asar', 'bin', 'asar.js');
  const resources = path.join(tmp, 'resources');
  fs.mkdirSync(resources, { recursive: true });
  const archive = path.join(resources, 'app.asar');

  if (!fs.existsSync(asarJs)) {
    fail('asar-fixture', '@electron/asar missing');
    return;
  }
  const packed = spawnSync(process.execPath, [asarJs, 'pack', appDir, archive], { encoding: 'utf8' });
  if (packed.status !== 0 || !fs.existsSync(archive)) {
    fail('asar-fixture', packed.stderr || packed.stdout || 'pack failed');
    return;
  }
  pass('asar-fixture');

  const asarEntry = path.join(archive, 'mcp', 'server.js');
  const viaSystem = spawnSync(process.execPath, [asarEntry], { encoding: 'utf8' });
  if (viaSystem.status !== 0) pass('system-node-rejects-asar-path');
  else fail('system-node-rejects-asar-path', 'system node unexpectedly ran asar path');

  let electronBin = null;
  try {
    electronBin = require(path.join(ROOT, 'node_modules', 'electron'));
  } catch {}
  if (electronBin && fs.existsSync(electronBin)) {
    const viaShim = spawnSync(electronBin, [asarEntry], {
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    if (viaShim.status === 0 && /ENTRY_OK/.test(viaShim.stdout || '') && /ZOD object/.test(viaShim.stdout || '')) {
      pass('electron-as-node-runs-asar-mcp');
    } else {
      fail('electron-as-node-runs-asar-mcp', viaShim.stderr || viaShim.stdout || `status ${viaShim.status}`);
    }

    const unpacked = path.join(resources, 'app.asar.unpacked', 'mcp');
    fs.mkdirSync(unpacked, { recursive: true });
    fs.writeFileSync(
      path.join(unpacked, 'server.js'),
      "console.log('UNPACKED'); const z = require('zod'); console.log('ZOD', typeof z.z);\n",
    );
    const viaUnpackedShim = spawnSync(electronBin, [path.join(unpacked, 'server.js')], {
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    if (viaUnpackedShim.status !== 0) pass('unpacked-entry-misses-packed-deps');
    else fail('unpacked-entry-misses-packed-deps', 'unpacked entry unexpectedly resolved packed zod');
  } else {
    fail('electron-as-node-runs-asar-mcp', 'electron binary not installed');
    fail('unpacked-entry-misses-packed-deps', 'electron binary not installed');
  }

  const asarBin = path.join(archive, 'bin');
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
  const api = loadApi();
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
