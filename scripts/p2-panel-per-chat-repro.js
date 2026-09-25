'use strict';
/* The right column belongs to a chat in a folder, not to the window. Opening
   Files in one chat and switching to another chat in the same folder has to
   leave that second chat's column shut, and coming back has to bring the first
   one back as it was.

   Drives the real app over the DevTools protocol, on a throwaway HOME so the
   installed Tandem's ~/.tandem and ~/.claude are never touched. Needs a built
   renderer: `npx vite build` first. */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};

function checkSource() {
  const shell = fs.readFileSync(path.join(ROOT, 'src/renderer/ui/shell/Shell.jsx'), 'utf8');
  check(
    'handles-stay-mounted',
    !/\{railOpen && <ResizableHandle/.test(shell) && !/\{!full && rightOpen && <ResizableHandle/.test(shell),
    'conditional ResizableHandle still present',
  );
  const app = fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8');
  check(
    'reconcile-rehomes-hosts',
    /box\.contains\(held\.host\)/.test(app) && /box\.appendChild\(held\.host\)/.test(app),
    'reconcileShells does not re-home detached hosts',
  );
}

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-panel-'));
  const home = path.join(base, 'home');
  const a = path.join(base, 'alpha');
  const b = path.join(base, 'beta');
  for (const d of [home, a, b]) fs.mkdirSync(d, { recursive: true });
  const write = (cwd, id, text) => {
    const dir = path.join(home, '.claude', 'projects', cwd.replace(/[/.]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    const at = new Date().toISOString();
    const lines = [
      { type: 'user', sessionId: id, cwd, timestamp: at, uuid: `${id}-u`, message: { role: 'user', content: text } },
      { type: 'assistant', sessionId: id, cwd, timestamp: at, uuid: `${id}-a`, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
    ];
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  };
  const chats = {
    one: { id: '11111111-1111-4111-8111-111111111111', project: a, title: 'chat one' },
    two: { id: '22222222-2222-4222-8222-222222222222', project: a, title: 'chat two' },
    three: { id: '33333333-3333-4333-8333-333333333333', project: b, title: 'chat three' },
  };
  for (const c of Object.values(chats)) write(c.project, c.id, c.title);
  fs.mkdirSync(path.join(home, '.tandem'), { recursive: true });
  fs.writeFileSync(path.join(home, '.tandem', 'open-projects.json'), JSON.stringify([a, b]));
  return { base, home, a, chats };
}

async function renderer() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error('renderer never came up');
}

function connect(url) {
  const ws = new WebSocket(url);
  let seq = 0;
  const waiting = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++seq;
    waiting.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (fn, ...args) => {
    const res = await send('Runtime.evaluate', {
      expression: `(${fn})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true,
    });
    if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails));
    return res.result?.result?.value;
  };
  return new Promise((resolve) => { ws.onopen = () => resolve({ ws, evaluate }); });
}

const openChat = (page, chat) => page.evaluate(async (c) => {
  window.tandemChat.open(c);
  await new Promise((r) => setTimeout(r, 800));
}, chat);

const chord = (page, key, shiftKey = true) => page.evaluate(async (k, shift) => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: k, ctrlKey: true, shiftKey: shift, bubbles: true }));
  await new Promise((r) => setTimeout(r, 600));
}, key, shiftKey);

const panel = (page) => page.evaluate(() => {
  // The section keeps its border when the panel around it collapses, so the
  // panel is what gets measured.
  const right = document.querySelector('section#right')?.parentElement;
  const open = !!right && right.getBoundingClientRect().width > 0;
  const tabs = [...document.querySelectorAll('section#right [role="tab"]')].map((t) => t.textContent.trim());
  const shells = document.querySelectorAll('#terms .term-host').length;
  return { open, tabs, shells };
});

const show = (p) => `${p.open ? 'open' : 'shut'} [${p.tabs.join(', ')}]`;

async function main() {
  checkSource();
  if (process.env.TANDEM_SOURCE_ONLY) {
    console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
    process.exit(failures.length ? 1 : 0);
  }

  const fx = fixture();
  const electron = require(path.join(ROOT, 'node_modules', 'electron'));
  const app = spawn(electron, [
    ROOT, `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(fx.base, 'userdata')}`, '--no-sandbox',
  ], { env: { ...process.env, HOME: fx.home, TANDEM_CWD: fx.a }, stdio: 'ignore' });

  try {
    const page = await connect(await renderer());
    await page.evaluate(async () => {
      for (let i = 0; i < 60 && !window.tandemChat; i++) await new Promise((r) => setTimeout(r, 250));
      await new Promise((r) => setTimeout(r, 1000));
    });
    const { one, two, three } = fx.chats;

    await openChat(page, one);
    await chord(page, '`', false);
    let p = await panel(page);
    check('terminal-opens-in-chat-one', p.open && p.tabs.includes('Terminal') && p.shells === 1, `${show(p)} shells=${p.shells}`);
    const shellConnected = await page.evaluate(() => {
      const host = document.querySelector('#terms .term-host');
      return !!(host && document.getElementById('terms')?.contains(host));
    });
    check('terminal-host-in-terms', shellConnected);

    await openChat(page, two);
    p = await panel(page);
    check('chat-two-same-folder-starts-shut', !p.open, show(p));

    // Opening the column on chat two used to remount #terms (conditional
    // ResizableHandle) and leave chat one's xterm host detached. The shell
    // count must stay 1 and the host must still sit under #terms.
    await chord(page, 'D');
    p = await panel(page);
    check('files-opens-in-chat-two', p.open && p.tabs.includes('Files'), show(p));
    const stillHomed = await page.evaluate(() => {
      const hosts = [...document.querySelectorAll('.term-host')];
      const box = document.getElementById('terms');
      return hosts.length === 1 && !!box && hosts.every((h) => box.contains(h));
    });
    check('chat-one-shell-still-under-terms', stillHomed, 'host left #terms after opening the other chat');

    await openChat(page, one);
    p = await panel(page);
    check('chat-one-terminal-comes-back', p.open && p.tabs.includes('Terminal') && p.shells === 1, `${show(p)} shells=${p.shells}`);
    const backHomed = await page.evaluate(() => {
      const host = document.querySelector('#terms .term-host.active, #terms .term-host');
      return !!(host && document.getElementById('terms')?.contains(host)
        && host.querySelector('.xterm'));
    });
    check('chat-one-terminal-still-drawn', backHomed);

    await openChat(page, two);
    p = await panel(page);
    check('chat-two-kept-its-files', p.open && p.tabs.join() === 'Files', show(p));

    await openChat(page, one);
    await chord(page, 'D');
    p = await panel(page);
    check('files-opens-in-chat-one', p.open && p.tabs.includes('Files'), show(p));

    await openChat(page, two);
    p = await panel(page);
    check('chat-two-same-folder-starts-shut-again', !p.open, show(p));

    await chord(page, 'G');
    p = await panel(page);
    check('changes-opens-in-chat-two', p.open && p.tabs.includes('Changes'), show(p));

    await openChat(page, one);
    p = await panel(page);
    check('chat-one-comes-back-as-left', p.open && p.tabs.includes('Files') && p.tabs.includes('Terminal'), show(p));

    await openChat(page, two);
    p = await panel(page);
    check('chat-two-comes-back-as-left', p.open && p.tabs.includes('Changes'), show(p));

    await openChat(page, three);
    p = await panel(page);
    check('chat-in-other-folder-starts-shut', !p.open, show(p));

    await chord(page, 'D');
    await openChat(page, one);
    p = await panel(page);
    check('back-across-folders-to-chat-one', p.open && p.tabs.includes('Files'), show(p));

    await openChat(page, three);
    p = await panel(page);
    check('chat-three-kept-its-own', p.open && p.tabs.includes('Files'), show(p));

    await openChat(page, one);
    await chord(page, 'B');
    const withPreview = (await panel(page)).tabs;
    await openChat(page, two);
    await chord(page, '`', false);
    p = await panel(page);
    check('terminal-opens-in-chat-two', p.tabs.includes('Changes') && p.tabs.includes('Terminal') && p.shells >= 1, `${show(p)} shells=${p.shells}`);

    await openChat(page, one);
    p = await panel(page);
    check('chat-one-keeps-its-preview', withPreview.every((t) => p.tabs.includes(t)), `${show(p)} was [${withPreview}]`);
    check('chat-two-shell-lives-while-away', p.shells >= 1, `shells=${p.shells}`);

    await openChat(page, two);
    p = await panel(page);
    check('chat-two-terminal-comes-back', p.open && p.tabs.includes('Terminal') && p.shells >= 1, `${show(p)} shells=${p.shells}`);

    page.ws.close();
  } finally {
    const exited = new Promise((r) => app.once('exit', r));
    app.kill();
    await exited;
    fs.rmSync(fx.base, { recursive: true, force: true, maxRetries: 5 });
  }

  console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
