/* Which panels are on screen. The shell used to answer that by toggling a
   `closed` class on four elements, which meant the layout lived in the DOM and
   only app.js could read it. React needs to render from the same answer, so it
   lives here instead and both halves read it.

   Deliberately not a hook: app.js is still plain modules, and it drives most of
   these (keyboard chords, the native menu, the agent asking for the preview). */
'use strict';

export const layout = {
  railOpen: true,
  // Whether the right column is on screen. What is in it is a strip of tabs,
  // and which tabs those are belongs to the focused folder, so it lives in
  // tabs-store.js rather than here.
  rightOpen: false,
  previewFull: false,
  panelOpen: false,
  // How many files git has not been told about yet. changes-store.js counts
  // them and the toolbar's Changes tab wears the number.
  changesCount: 0,
};

const listeners = new Set();

// useSyncExternalStore compares snapshots by identity, so a mutable object
// cannot be the snapshot. The counter is.
let version = 0;
export const getVersion = () => version;

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setLayout(partial) {
  let changed = false;
  for (const [k, v] of Object.entries(partial)) {
    if (layout[k] === v) continue;
    layout[k] = v;
    changed = true;
  }
  if (!changed) return;
  version += 1;
  for (const fn of listeners) fn();
}

/* Resizing a panel changes how many CSS pixels the preview and the terminal
   have, and neither of them can work that out for itself: xterm has to be told
   to remeasure, and the preview is a native view whose bounds are set from this
   side. app.js owns both, so it registers here and the layout calls it. */
const relayout = new Set();

export function onRelayout(fn) {
  relayout.add(fn);
  return () => relayout.delete(fn);
}

export function relayoutNow() {
  for (const fn of relayout) fn();
}

/* Actions that only app.js can perform, for the modules that need them without
   importing it. app.js is imported by half the React tree already; importing it
   back from a store would close the loop and leave one of them half-evaluated. */
const actions = {};

export const registerActions = (next) => Object.assign(actions, next);
export const act = (name, ...args) => actions[name]?.(...args);
