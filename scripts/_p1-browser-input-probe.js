'use strict';
const http = require('http');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const { BrowserPane } = require(path.join(ROOT, 'src/main/browser.js'));

const failures = [];
const pass = (name) => console.log(`PASS ${name}`);
const fail = (name, detail) => {
  console.log(`FAIL ${name}: ${detail}`);
  failures.push(name);
};

function startFixture() {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>input-fixture</title></head>
<body>
  <input id="plain" />
  <div id="editor" contenteditable="true">seed</div>
  <iframe id="child" src="/frame.html" width="400" height="120"></iframe>
</body></html>`;
  const frame = `<!doctype html>
<html><body>
  <button id="in-frame">Inside</button>
  <input id="frame-input" />
</body></html>`;

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const body = req.url === '/frame.html' ? frame : html;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}

app.whenReady().then(async () => {
  const { server, url } = await startFixture();
  const win = new BrowserWindow({ show: false, width: 900, height: 700 });
  const pane = new BrowserPane(win, null, { project: '/tmp/tandem-input-p1' });

  try {
    const nav = await pane.navigate(url);
    if (nav.error) fail('navigate-fixture', nav.error);
    else pass('navigate-fixture');

    await pane.evaluate(`Object.defineProperty(window, 'innerWidth', { get: () => 900 });
      Object.defineProperty(window, 'innerHeight', { get: () => 700 });`);

    try {
      const filled = await pane.fill('#editor', 'hello-ce');
      if (filled && /hello-ce/.test(String(filled.value ?? ''))) pass('fill-contenteditable');
      else fail('fill-contenteditable', `value=${JSON.stringify(filled)}`);
    } catch (e) {
      fail('fill-contenteditable', e.message);
    }

    try {
      const filled = await pane.fill('#plain', 'via-fill');
      if (filled && filled.value === 'via-fill') pass('fill-input');
      else fail('fill-input', JSON.stringify(filled));
    } catch (e) {
      fail('fill-input', e.message);
    }

    const sent = [];
    const origSend = pane.wc.sendInputEvent.bind(pane.wc);
    pane.wc.sendInputEvent = (ev) => { sent.push(ev); return origSend(ev); };
    try {
      await pane.type('ab', { target: '#plain', delay: 5 });
    } finally {
      pane.wc.sendInputEvent = origSend;
    }
    const kinds = sent.map((e) => e.type);
    const want = ['keyDown', 'char', 'keyUp', 'keyDown', 'char', 'keyUp'];
    if (want.every((k, i) => kinds[i] === k)) pass('type-emits-keydown-keyup');
    else fail('type-emits-keydown-keyup', `events=${JSON.stringify(sent)}`);

    await pane.waitFor({ ms: 500 });
    const snap = await pane.snapshot();
    let found = null;
    let inFrame = false;
    for (const line of String(snap).split('\n')) {
      if (/- iframe /.test(line)) { inFrame = true; continue; }
      if (inFrame) {
        const m = line.match(/\[ref=(e\d+)\]/);
        if (m) { found = m[1]; break; }
      }
    }
    if (!found) {
      found = await pane.evaluate(`(() => {
        const doc = document.getElementById('child')?.contentDocument;
        if (!doc) return null;
        const btn = doc.getElementById('in-frame');
        return btn?.getAttribute('data-tandem-ref') || null;
      })()`);
    }
    if (found) {
      try {
        await pane.click(found);
        pass('iframe-ref-click');
      } catch (e) {
        fail('iframe-ref-click', e.message);
      }
    } else {
      fail('iframe-ref-click', `no in-frame ref; snapshot=\n${snap}`);
    }

    await new Promise((resolve) => {
      const badFrameHtml = `<!doctype html><html><body>
        <iframe src="http://127.0.0.1:59999/nope"></iframe>
        <p id="ok">main-ok</p>
      </body></html>`;
      const s = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(badFrameHtml);
      });
      s.listen(0, '127.0.0.1', async () => {
        const p = s.address().port;
        try {
          const r = await pane.navigate(`http://127.0.0.1:${p}/`, { timeout: 8000 });
          const text = await pane.evaluate('document.getElementById("ok")?.textContent || ""');
          if (r.error && text === 'main-ok') {
            fail('navigate-ignores-subframe-fail', `reported error=${r.error} though main loaded`);
          } else if (text === 'main-ok' && !r.error) {
            pass('navigate-ignores-subframe-fail');
          } else {
            fail('navigate-ignores-subframe-fail', `state=${JSON.stringify(r)} text=${text}`);
          }
        } catch (e) {
          fail('navigate-ignores-subframe-fail', e.message);
        }
        s.close();
        resolve();
      });
    });
  } catch (e) {
    fail('probe-crash', e.stack || e.message);
  }

  try { pane.dispose(); } catch {}
  win.destroy();
  server.close();
  if (failures.length) {
    console.log(`${failures.length} failure(s)`);
    app.exit(1);
  } else {
    console.log('all probe checks passed');
    app.exit(0);
  }
}).catch((e) => {
  console.log(`FAIL probe-boot: ${e.stack || e.message}`);
  app.exit(1);
});
