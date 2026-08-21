// Renders the app icon with Electron itself, so the repo needs no image tooling.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SIZE = 512;
const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#161b26"/>
      <stop offset="1" stop-color="#0a0c11"/>
    </linearGradient>
    <linearGradient id="ink" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7aa2f7"/>
      <stop offset="1" stop-color="#b48cf2"/>
    </linearGradient>
  </defs>
  <rect width="${SIZE}" height="${SIZE}" rx="112" fill="url(#bg)"/>
  <rect x="8" y="8" width="${SIZE - 16}" height="${SIZE - 16}" rx="106" fill="none" stroke="#232936" stroke-width="4"/>
  <g stroke="url(#ink)" stroke-width="30" stroke-linecap="round" stroke-linejoin="round" fill="none">
    <polyline points="130,180 208,256 130,332"/>
    <line x1="248" y1="332" x2="382" y2="332"/>
  </g>
  <rect x="248" y="150" width="134" height="104" rx="16" fill="none" stroke="#3a4considerable" stroke-width="0"/>
  <rect x="252" y="154" width="126" height="96" rx="14" fill="none" stroke="url(#ink)" stroke-width="14" opacity="0.55"/>
  <circle cx="286" cy="182" r="8" fill="url(#ink)" opacity="0.8"/>
</svg>`.replace('#3a4considerable', '#3a4152');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE, height: SIZE, show: false, frame: false, transparent: true,
    webPreferences: { offscreen: true },
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    `<html><body style="margin:0;background:transparent">${svg}</body></html>`,
  ));
  await new Promise((r) => setTimeout(r, 350));
  const img = await win.webContents.capturePage();
  const out = path.join(__dirname, '..', 'build', 'icon.png');
  fs.writeFileSync(out, img.toPNG());
  console.log(`wrote ${out} (${img.getSize().width}x${img.getSize().height})`);
  app.quit();
});
