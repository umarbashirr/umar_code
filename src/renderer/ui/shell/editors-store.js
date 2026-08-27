/* The editors installed on this machine.

   Tandem holds a folder open; sooner or later you want a real editor on the
   same folder, and the way that usually goes is finding a terminal and typing
   the name of one. The toolbar button opens the one you last picked, and the
   File menu lists them all, so both read from here. */
'use strict';
import { toast } from '../../app.js';

export const editors = { list: [], chosen: '' };

const listeners = new Set();
let version = 0;

export const getEditorsVersion = () => version;

export function subscribeEditors(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function changed() {
  version += 1;
  for (const fn of listeners) fn();
}

export const chosenEditor = () => editors.list.find((e) => e.id === editors.chosen) || null;

export async function loadEditors({ fresh = false } = {}) {
  editors.list = await window.tandem.editors.list(fresh) || [];
  editors.chosen = window.tandem.settings.snapshot()?.editor?.id || '';
  // An editor that was uninstalled since it was picked falls back to the first
  // one on the machine rather than to an error nobody asked for.
  if (editors.chosen && !chosenEditor()) editors.chosen = '';
  changed();
}

export async function openEditor(id) {
  const res = await window.tandem.editors.open(id);
  if (res?.error) {
    toast('Could not open that editor', res.error, [{ label: 'ok', primary: true }]);
    return;
  }
  if (editors.chosen === id) return;
  editors.chosen = id;
  window.tandem.settings.set({ editor: { id } });
  changed();
}

// The settings page can change the pick too.
window.tandem.settings.onChanged(() => {
  const id = window.tandem.settings.snapshot()?.editor?.id || '';
  if (id === editors.chosen) return;
  editors.chosen = id;
  changed();
});
