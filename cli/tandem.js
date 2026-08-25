#!/usr/bin/env node
'use strict';
// Command-line front end to the preview pane. Meant to be run from inside the
// app's own terminal, where TANDEM_BRIDGE_URL and TANDEM_TOKEN are already set.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const state = require('./state');

function connection() {
  if (process.env.TANDEM_BRIDGE_URL && process.env.TANDEM_TOKEN) {
    return { url: process.env.TANDEM_BRIDGE_URL, token: process.env.TANDEM_TOKEN };
  }
  const found = state.find(process.cwd());
  if (found) return found;
  die('no window open for this folder. Run `tandem .` to open one.');
}

// ------------------------------------------------------------ opening a project

const expand = (p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const looksLikePath = (a) =>
  a === '.' || a === '..' || a.startsWith('/') || a.startsWith('./') || a.startsWith('../') || a.startsWith('~');

// Find the app binary. Installed, packaged, AppImage, or a source checkout.
function findApp() {
  const named = process.env.TANDEM_APP;
  if (named && fs.existsSync(named)) return { bin: named, args: [] };

  if (process.env.APPIMAGE && fs.existsSync(process.env.APPIMAGE)) return { bin: process.env.APPIMAGE, args: [] };

  // /usr/bin/tandem runs the app's own binary as node, so execPath is the app.
  const exe = process.execPath;
  if (process.env.ELECTRON_RUN_AS_NODE && path.basename(exe) !== 'node' && fs.existsSync(exe)) {
    return { bin: exe, args: [] };
  }

  // Packaged beside us: <app>/resources/app.asar.unpacked/cli/tandem.js
  const beside = path.join(__dirname, '..', '..', '..', '..', 'tandem');
  if (fs.existsSync(beside)) return { bin: beside, args: [] };

  for (const p of [
    '/opt/tandem/tandem',
    '/usr/bin/tandem',
  ]) if (fs.existsSync(p)) return { bin: p, args: [] };

  // Source checkout: go through the launcher so the sandbox check still runs.
  const repo = path.join(__dirname, '..');
  const launcher = path.join(repo, 'scripts', 'launch.js');
  if (fs.existsSync(path.join(repo, 'node_modules', 'electron')) && fs.existsSync(launcher)) {
    return { bin: 'node', args: [launcher] };
  }
  return null;
}

// A copy installed without root has a chrome-sandbox that is not setuid, and
// Electron aborts rather than quietly running unsandboxed. The launcher script
// makes the same check for a source checkout; this is it for an installed one.
function sandboxArgs(bin) {
  try {
    const st = fs.statSync(path.join(path.dirname(bin), 'chrome-sandbox'));
    if (st.uid === 0 && (st.mode & 0o4000) !== 0) return [];
  } catch {
    return [];
  }
  return ['--no-sandbox'];
}

async function openProject(target) {
  const dir = path.resolve(expand(target || '.'));
  if (!isDir(dir)) die(`${dir} is not a directory`);

  // Already open? Raise it, the way `cursor .` does.
  const open = state.forDir(dir);
  if (open) {
    try {
      const res = await fetch(`${open.url}/focus`, { method: 'POST', headers: { 'x-tandem-token': open.token } });
      if (res.ok) { process.stdout.write(`focused the window already open on ${dir}\n`); return; }
    } catch { /* dead or wedged: fall through and start a new one */ }
  }

  const app = findApp();
  if (!app) die('cannot find the app. Install the .deb or AppImage, or set TANDEM_APP to its binary.');

  const env = { ...process.env, TANDEM_CWD: dir };
  // A new window gets its own bridge and must not start life as node.
  delete env.TANDEM_BRIDGE_URL;
  delete env.TANDEM_TOKEN;
  delete env.TANDEM_MCP_SERVER;
  delete env.ELECTRON_RUN_AS_NODE;

  const args = [...app.args, ...sandboxArgs(app.bin)];
  const child = spawn(app.bin, args, { cwd: dir, env, detached: true, stdio: 'ignore' });
  child.on('error', (e) => die(`could not start ${app.bin}: ${e.message}`));
  child.unref();
  process.stdout.write(`opening ${dir}\n`);
}

function die(msg) {
  process.stderr.write(`tandem: ${msg}\n`);
  process.exit(1);
}

async function call(tool, args) {
  const { url, token } = connection();
  let res;
  try {
    res = await fetch(`${url}/tool/${tool}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tandem-token': token },
      body: JSON.stringify(args || {}),
    });
  } catch (e) {
    die(`cannot reach the preview pane at ${url} (${e.message})`);
  }
  const body = await res.json().catch(() => ({ error: 'bad response' }));
  if (!res.ok || body.error) die(body.error || `request failed (${res.status})`);
  return body.result;
}

// tandem click e12 --button right  ->  { target: 'e12', button: 'right' }
function parse(argv, positional) {
  const args = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=');
      const key = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (inline !== undefined) args[key] = coerce(inline);
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) args[key] = coerce(argv[++i]);
      else args[key] = true;
    } else rest.push(a);
  }
  positional.forEach((name, i) => { if (rest[i] !== undefined) args[name] = coerce(rest[i]); });
  if (rest.length > positional.length) args._extra = rest.slice(positional.length);
  return args;
}

const coerce = (v) => (v === 'true' ? true : v === 'false' ? false : /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v);

const COMMANDS = {
  go: { tool: 'navigate', pos: ['url'], help: 'tandem go localhost:3000' },
  navigate: { tool: 'navigate', pos: ['url'], help: 'tandem navigate https://example.com' },
  back: { tool: 'back', pos: [], help: 'tandem back' },
  forward: { tool: 'forward', pos: [], help: 'tandem forward' },
  reload: { tool: 'reload', pos: [], help: 'tandem reload' },
  snapshot: { tool: 'snapshot', pos: [], help: 'tandem snapshot  (page outline with [ref=eN] handles)' },
  text: { tool: 'text', pos: [], help: 'tandem text' },
  html: { tool: 'html', pos: [], help: 'tandem html' },
  click: { tool: 'click', pos: ['target'], help: 'tandem click e12   |   tandem click "button.save"' },
  hover: { tool: 'hover', pos: ['target'], help: 'tandem hover e4' },
  fill: { tool: 'fill', pos: ['target', 'value'], help: 'tandem fill e3 "user@example.com"' },
  select: { tool: 'select', pos: ['target', 'value'], help: 'tandem select e7 "Large"' },
  type: { tool: 'type', pos: ['text'], help: 'tandem type "hello" --target e3' },
  press: { tool: 'press', pos: ['key'], help: 'tandem press Enter   |   tandem press ctrl+a' },
  scroll: { tool: 'scroll', pos: ['dy'], help: 'tandem scroll 600' },
  highlight: { tool: 'highlight', pos: ['target'], help: 'tandem highlight e9' },
  eval: { tool: 'evaluate', pos: ['code'], help: 'tandem eval "document.title"' },
  wait: { tool: 'waitFor', pos: ['selector'], help: 'tandem wait ".chart" | tandem wait --ms 500 | tandem wait --network-idle' },
  shot: { tool: 'screenshot', pos: ['name'], help: 'tandem shot --full   |   tandem shot --target e2' },
  screenshot: { tool: 'screenshot', pos: ['name'], help: 'tandem screenshot --full' },
  viewport: { tool: 'setViewport', pos: ['width', 'height'], help: 'tandem viewport 390 844' },
  console: { tool: 'console', pos: [], help: 'tandem console --level error --limit 20' },
  network: { tool: 'network', pos: [], help: 'tandem network' },
  state: { tool: 'state', pos: [], help: 'tandem state' },
  devtools: { tool: 'devtools', pos: [], help: 'tandem devtools' },
  preview: { tool: 'preview', pos: ['open'], help: 'tandem preview open | close | toggle' },
};

// Register the MCP server with whatever agent is running in this terminal.
function setup(rest) {
  const server = process.env.TANDEM_MCP_SERVER || path.join(__dirname, '..', 'mcp', 'server.js');
  const target = rest[0] || 'print';
  const entry = { command: 'node', args: [server] };

  if (target === 'print') {
    process.stdout.write(
      'Add the preview browser to your agent:\n\n' +
      `  claude mcp add tandem -- node ${server}\n\n` +
      'or write it into this project:\n\n' +
      '  tandem setup project      # creates or updates ./.mcp.json\n\n' +
      'No MCP? The CLI works on its own: tandem go 3000 && tandem snapshot\n',
    );
    return;
  }

  if (target === 'project') {
    const file = path.resolve('.mcp.json');
    let json = {};
    try { json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    json.mcpServers = { ...(json.mcpServers || {}), tandem: entry };
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
    process.stdout.write(`wrote ${file}\n`);
    return;
  }

  die(`unknown setup target ${target}. Use: tandem setup [print|project]`);
}

function usage() {
  const lines = [
    'Open a project, and drive its preview pane from the terminal.',
    '',
    'open:',
    '  tandem .            open this folder in a new window',
    '  tandem ~/code/app   open that folder',
    '',
    'commands:',
  ];
  for (const [name, c] of Object.entries(COMMANDS)) lines.push(`  ${name.padEnd(11)} ${c.help}`);
  lines.push(`  ${'setup'.padEnd(11)} tandem setup project   (register the MCP server in ./.mcp.json)`);
  lines.push('', 'Typical loop: tandem go 3000 && tandem snapshot, then act on the [ref=eN] handles.');
  lines.push('Add --json to any command for raw JSON.');
  return lines.join('\n');
}

(async () => {
  const argv = process.argv.slice(2);
  // Let --json sit anywhere, including before the command.
  const wantJsonGlobal = argv.includes('--json');
  const [cmd, ...rest] = argv.filter((a) => a !== '--json');
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(usage() + '\n');
    return;
  }
  if (cmd === 'setup') return setup(rest);
  if (cmd === 'open') return openProject(rest[0]);
  // `tandem .` and `tandem ~/code/app`, the way `cursor .` works.
  if (!COMMANDS[cmd] && (looksLikePath(cmd) || isDir(cmd))) return openProject(cmd);

  const spec = COMMANDS[cmd];
  if (!spec) die(`unknown command ${cmd}. Try: tandem help`);

  const args = parse(rest, spec.pos);
  const wantJson = wantJsonGlobal || args.json === true;
  delete args.json;
  if (spec.tool === 'screenshot' && args.full) { args.fullPage = true; delete args.full; }
  if (spec.tool === 'preview') {
    const word = String(args.open ?? 'toggle');
    args.open = word === 'open' ? true : word === 'close' ? false : undefined;
  }
  if (spec.tool === 'waitFor' && args.selector === undefined && !args.ms && !args.networkIdle) args.networkIdle = true;
  // `tandem viewport` with no size means "stop emulating".
  const tool = spec.tool === 'setViewport' && !args.width ? 'clearViewport' : spec.tool;

  const result = await call(tool, args);

  if (wantJson) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else if (typeof result === 'string') process.stdout.write(result + '\n');
  else if (Array.isArray(result)) {
    if (!result.length) process.stdout.write('(empty)\n');
    else for (const r of result) {
      process.stdout.write(typeof r === 'string' ? r + '\n' : `${r.level || r.kind || ''} ${r.message || `${r.status || r.error || ''} ${r.url || ''}`}`.trim() + '\n');
    }
  } else if (result && typeof result === 'object') {
    const compact = Object.entries(result).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join('  ');
    process.stdout.write(compact + '\n');
  } else process.stdout.write(String(result) + '\n');
})().catch((e) => die(e.message));
