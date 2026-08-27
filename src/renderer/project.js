/* The project folders: the label in the title bar, the empty state when none
   has been chosen, and opening, focusing and closing them.

   A window holds several folders open at once and every one of them keeps
   working. `project` is the focused one, which is a narrower thing than it used
   to be: there is one preview pane and one terminal panel, so one folder at a
   time can show its files and its shells. Chats ignore focus entirely and run
   where they were started. */
'use strict';
import { toast } from './app.js';

export const project = { dir: '', name: '', chosen: false, home: '', recents: [], projects: [], focused: '' };

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

// Moving the right-hand column to another folder that is already open. Nothing
// stops and nothing is thrown away.
export const focusProject = (dir) => window.tandem.project.focus(dir);

export async function closeProject(dir) {
  const res = await window.tandem.project.close(dir);
  if (res?.error) toast('Could not close that folder', res.error, [{ label: 'ok', primary: true }]);
  return res;
}

// -------------------------------------------------------------- rendering

function apply(info) {
  Object.assign(project, info);

  for (const fn of listeners) fn(project);
}

window.tandem.project.onChanged((info) => {
  const known = new Set(project.projects.map((p) => p.dir));
  const before = project.focused;
  const added = (info.projects || []).filter((p) => !known.has(p.dir));
  apply(info);

  // Folders come and go without disturbing the chats: nothing is stopped here
  // and nothing is cleared. The files and changes panes hear this same event and
  // follow focus themselves.
  // The rail is a list of folders now, so it redraws when the set of them moves,
  // whether one arrived or one left.
  if (added.length || (info.projects || []).length !== known.size) window.tandemRail?.refresh();

  // Only the first sight of a folder is worth saying out loud. Focus moves
  // every time you click a chat, and a toast on each one would be noise.
  for (const p of added) {
    if (!before) break; // the window's own opening folder, which nobody asked for
    toast('Opened folder', shortPath(p.dir), [{ label: 'ok', primary: true }]);
  }
});

(async () => {
  apply(await window.tandem.project.info());
})();
