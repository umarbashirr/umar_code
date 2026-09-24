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

const chord = (page, key) => page.evaluate(async (k) => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: k, ctrlKey: true, shiftKey: true, bubbles: true }));
  await new Promise((r) => setTimeout(r, 600));
}, key);

const panel = (page) => page.evaluate(() => {
  // The section keeps its border when the panel around it collapses, so the
  // panel is what gets measured.
  const right = document.querySelector('section#right')?.parentElement;
  const open = !!right && right.getBoundingClientRect().width > 0;
  const tabs = [...document.querySelectorAll('section#right [role="tab"]')].map((t) => t.textContent.trim());
  return { open, tabs };
});

const show = (p) => `${p.open ? 'open' : 'shut'} [${p.tabs.join(', ')}]`;

async function main() {
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
    await chord(page, 'D');
    let p = await panel(page);
    check('files-opens-in-chat-one', p.open && p.tabs.includes('Files'), show(p));

    await openChat(page, two);
    p = await panel(page);
    check('chat-two-same-folder-starts-shut', !p.open, show(p));

    await chord(page, 'G');
    p = await panel(page);
    check('changes-opens-in-chat-two', p.open && p.tabs.join() === 'Changes', show(p));

    await openChat(page, one);
    p = await panel(page);
    check('chat-one-comes-back-as-left', p.open && p.tabs.join() === 'Files', show(p));

    await openChat(page, two);
    p = await panel(page);
    check('chat-two-comes-back-as-left', p.open && p.tabs.join() === 'Changes', show(p));

    await openChat(page, three);
    p = await panel(page);
    check('chat-in-other-folder-starts-shut', !p.open, show(p));

    await chord(page, 'D');
    await openChat(page, one);
    p = await panel(page);
    check('back-across-folders-to-chat-one', p.open && p.tabs.join() === 'Files', show(p));

    await openChat(page, three);
    p = await panel(page);
    check('chat-three-kept-its-own', p.open && p.tabs.join() === 'Files', show(p));

    page.ws.close();
  } finally {
    app.kill();
    fs.rmSync(fx.base, { recursive: true, force: true });
  }

  console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
