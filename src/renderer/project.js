/* The project folder: the label in the title bar, the empty state when no
   folder has been chosen, and the switch itself. Everything else in the window
   is scoped to whatever this says. */
'use strict';
import { $, el, icons, iconMark, resetTerminals, toast } from './app.js';

export const project = { dir: '', name: '', chosen: false, home: '', recents: [] };

const listeners = new Set();
export const onProject = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

export const shortPath = (p) => {
  if (!p) return '';
  if (p === project.home) return '~';
  return project.home && p.startsWith(project.home + '/') ? '~' + p.slice(project.home.length) : p;
};

// -------------------------------------------------------------- switching

export async function openFolder(opts = {}) {
  const res = await window.pba.project.open(opts);
  if (res?.error) toast('Could not open that folder', res.error, [{ label: 'ok', primary: true }]);
  else if (res?.focused) toast('Already open', 'Raised the window already on that folder.', [{ label: 'ok', primary: true }]);
  return res;
}

export const openRecent = (dir) => openFolder({ dir });
export const openInNewWindow = (dir) => openFolder({ dir, newWindow: true });

// -------------------------------------------------------------- rendering

function apply(info) {
  Object.assign(project, info);

  const label = $('#project');
  if (label) {
    label.textContent = info.chosen ? info.name : 'no folder';
    label.title = info.chosen ? info.dir : 'No folder open. Pick one to start.';
    label.classList.toggle('empty', !info.chosen);
  }

  $('#agent-cwd').textContent = shortPath(info.dir);
  $('#agent-cwd').title = info.dir;

  renderWelcome();
  for (const fn of listeners) fn(project);
}

function renderWelcome() {
  const box = $('#welcome');
  box.hidden = project.chosen;
  if (project.chosen) return;

  $('#wel-home').textContent = shortPath(project.home);

  const list = $('#wel-recent');
  list.innerHTML = '';
  if (!project.recents.length) return;

  list.appendChild(el('div', 'wel-label', 'Recent'));
  for (const r of project.recents.slice(0, 6)) {
    const row = el('button', 'wel-row');
    row.appendChild(iconMark('folder'));
    row.appendChild(el('span', 'wel-name', r.name));
    row.appendChild(el('span', 'wel-path', shortPath(r.path)));
    row.onclick = () => openRecent(r.path);
    list.appendChild(row);
  }
  icons();
}

// ------------------------------------------------------------------ wiring

$('#wel-open').onclick = () => openFolder();
$('#wel-new').onclick = () => openFolder({ newWindow: true });
$('#wel-skip').onclick = () => openFolder({ dir: project.home });

window.pba.project.onChanged((info) => {
  const moved = info.dir !== project.dir;
  apply(info);
  if (!moved) return;

  // The agent, the shells and the chat list all belonged to the old folder.
  resetTerminals();
  window.pbaChat?.newChat();
  window.pbaRail?.setCurrent(null);
  window.pbaRail?.refresh();
  toast('Opened folder', shortPath(info.dir), [{ label: 'ok', primary: true }]);
});

(async () => {
  apply(await window.pba.project.info());
})();
