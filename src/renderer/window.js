/* The window buttons. The BrowserWindow is frameless, so minimise, maximise and
   close are ours to draw and ours to wire up. */
'use strict';
import { $, icons, iconMark } from './app.js';

const maxBtn = document.querySelector('[data-win="maximize"]');

function apply({ maximized }) {
  if (!maxBtn) return;
  maxBtn.replaceChildren(iconMark(maximized ? 'copy' : 'square'));
  maxBtn.title = maximized ? 'Restore' : 'Maximize';
  icons();
}

for (const btn of document.querySelectorAll('[data-win]')) {
  btn.onclick = () => window.pba.win.action(btn.dataset.win);
}

// Frameless windows do not get the double-click-to-maximise the desktop gives
// every other window, so the drag strip has to offer it.
$('#titlebar').addEventListener('dblclick', (e) => {
  if (e.target.closest('button, input, nav')) return;
  window.pba.win.action('maximize');
});

window.pba.win.onState(apply);
window.pba.win.state().then(apply).catch(() => {});
