/* The project folder: the label in the title bar, the empty state when no
   folder has been chosen, and the switch itself. Everything else in the window
   is scoped to whatever this says. */
'use strict';
import { resetTerminals, toast } from './app.js';

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
  const res = await window.tandem.project.open(opts);
  if (res?.error) toast('Could not open that folder', res.error, [{ label: 'ok', primary: true }]);
  else if (res?.focused) toast('Already open', 'Raised the window already on that folder.', [{ label: 'ok', primary: true }]);
  return res;
}

export const openRecent = (dir) => openFolder({ dir });
export const openInNewWindow = (dir) => openFolder({ dir, newWindow: true });

// -------------------------------------------------------------- rendering

function apply(info) {
  Object.assign(project, info);

  for (const fn of listeners) fn(project);
}

window.tandem.project.onChanged((info) => {
  const moved = info.dir !== project.dir;
  apply(info);
  if (!moved) return;

  // The agent, the shells and the chat list all belonged to the old folder.
  resetTerminals();
  window.tandemChat?.clearChats();
  window.tandemRail?.refresh();
  toast('Opened folder', shortPath(info.dir), [{ label: 'ok', primary: true }]);
});

(async () => {
  apply(await window.tandem.project.info());
})();
