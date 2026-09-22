'use strict';
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const { BrowserPane } = require(path.join(ROOT, 'src/main/browser.js'));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 800, height: 600 });
  const projectA = '/tmp/tandem-iso-a';
  const projectB = '/tmp/tandem-iso-b';
  let paneA;
  let paneB;
  try {
    paneA = new BrowserPane(win, null, { project: projectA });
    paneB = new BrowserPane(win, null, { project: projectB });
  } catch (e) {
    console.log(`FAIL cookie-probe-construct: ${e.message}`);
    app.exit(1);
    return;
  }

  if (paneA.wc.session === paneB.wc.session) {
    console.log('FAIL cookie-partitions-isolated: panes share session object');
    app.exit(1);
    return;
  }

  const cookie = {
    url: 'https://example.com',
    name: 'tandem_iso',
    value: 'secret-a',
    path: '/',
  };
  await paneA.wc.session.cookies.set(cookie);
  const fromB = await paneB.wc.session.cookies.get({ url: 'https://example.com', name: 'tandem_iso' });
  const fromA = await paneA.wc.session.cookies.get({ url: 'https://example.com', name: 'tandem_iso' });

  if (!fromA.length || fromA[0].value !== 'secret-a') {
    console.log(`FAIL cookie-partitions-isolated: set on A failed (${JSON.stringify(fromA)})`);
    app.exit(1);
    return;
  }
  if (fromB.length) {
    console.log(`FAIL cookie-partitions-isolated: B saw A's cookie (${JSON.stringify(fromB)})`);
    app.exit(1);
    return;
  }

  console.log('PASS cookie-partitions-isolated');
  try { paneA.dispose(); } catch {}
  try { paneB.dispose(); } catch {}
  win.destroy();
  app.exit(0);
}).catch((e) => {
  console.log(`FAIL cookie-probe: ${e.stack || e.message}`);
  app.exit(1);
});
