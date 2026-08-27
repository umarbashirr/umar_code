/* The tabs in the right column.

   The column used to hold one view at a time, chosen by three toolbar buttons.
   It holds a strip of tabs now, and each tab is a preview, the file tree or the
   diff. A folder can have as many previews as it has things to look at, and one
   tree and one diff, because a second of either would draw the same folder
   twice.

   Tabs belong to a folder, the way shells and trees and diffs do. Switching
   folders swaps the strip, and the tabs you left are there when you come back.

   Same shape as the other stores here: a mutable map, a version counter for
   useSyncExternalStore, and changed() to bump it. */
'use strict';
import { layout, setLayout } from './layout-store.js';

export const KINDS = ['browser', 'files', 'changes'];

// One tree and one diff per folder, so opening either twice lands you back on
// the one you have. A preview is the exception: two dev servers, or the docs
// beside the app, is the reason this strip exists at all.
const SINGLE = new Set(['files', 'changes']);

const byProject = new Map(); // dir -> { tabs: [{ id, kind, title }], activeId }

const listeners = new Set();
let version = 0;

export const getTabsVersion = () => version;

export function subscribeTabs(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function changed() {
  version += 1;
  for (const fn of listeners) fn();
}

/* Ids are minted once per window and never reused, because main keys a native
   preview off them and a recycled id would hand a new tab the last one's page.
   Main mints them too, when an agent asks for a preview in a folder that has no
   tab open for one, so the prefix says who made it and the two can never
   collide. */
let seq = 0;
const mintId = (kind) => `${kind[0]}r${++seq}`;

const groupOf = (dir) => {
  let group = byProject.get(dir);
  if (!group) {
    group = { tabs: [], activeId: null };
    byProject.set(dir, group);
  }
  return group;
};

// What the column is drawing. An empty list is a folder nobody has opened the
// column on yet, which is most folders most of the time.
export const tabsOf = (dir) => byProject.get(dir)?.tabs || [];

export function activeTab(dir) {
  const group = byProject.get(dir);
  if (!group) return null;
  return group.tabs.find((t) => t.id === group.activeId) || null;
}

export const activeKind = (dir) => activeTab(dir)?.kind || null;

/* Open a tab of this kind, or go to the one already there. `id` lets main name
   the tab it just made a preview for, so the pane and the tab agree on which
   one they are. Returns the tab either way, because most callers want to tell
   main about it.

   `reveal` is whether this tab is one somebody asked for. A person clicking
   Files wants the column, so it comes up. An agent putting a page on screen in
   a folder nobody is looking at has not asked for anything of the sort, and
   opening the column would show the focused folder's tab instead, which is a
   column appearing for no reason with the wrong thing in it. */
export function openTab(dir, kind, id = null, { reveal = true } = {}) {
  if (!KINDS.includes(kind)) return null;
  const group = groupOf(dir);

  /* Two callers can name the same tab. Main mints the id for a preview it has
     already made, and more than one path in here answers that. An id already in
     the strip is the tab it names, not a second one to push beside it: closing
     goes by id and takes the first row it finds, so a pair sharing an id close
     each other. */
  const held = SINGLE.has(kind)
    ? group.tabs.find((t) => t.kind === kind)
    : (id ? group.tabs.find((t) => t.id === id) : null);
  const tab = held || { id: id || mintId(kind), kind, title: '' };
  if (!held) group.tabs.push(tab);

  group.activeId = tab.id;
  if (reveal) setLayout({ rightOpen: true });
  changed();
  return tab;
}

export function activateTab(dir, id) {
  const group = byProject.get(dir);
  if (!group || group.activeId === id) return;
  if (!group.tabs.some((t) => t.id === id)) return;
  group.activeId = id;
  changed();
}

/* Closing one. The neighbour to the right takes over, which is where your eye
   already is, and the column puts itself away when the last tab goes rather
   than sitting there empty. The caller is told which tab left so it can tell
   main to drop the pane behind it. */
export function closeTab(dir, id) {
  const group = byProject.get(dir);
  if (!group) return null;
  const at = group.tabs.findIndex((t) => t.id === id);
  if (at < 0) return null;

  const [gone] = group.tabs.splice(at, 1);
  if (group.activeId === id) {
    const next = group.tabs[at] || group.tabs[at - 1] || null;
    group.activeId = next?.id || null;
    if (!next && layout.rightOpen) setLayout({ rightOpen: false });
  }
  changed();
  return gone;
}

// A browser tab wears the page it is showing. Nothing else has a title worth
// keeping: a tree and a diff are named by their kind.
export function setTabTitle(dir, id, title) {
  const tab = byProject.get(dir)?.tabs.find((t) => t.id === id);
  if (!tab || tab.title === title) return;
  tab.title = title || '';
  changed();
}

/* The folder is closing. Its tabs go with it, and the previews behind them are
   handed back so main can let those native views go. */
export function dropProject(dir) {
  const group = byProject.get(dir);
  if (!group) return [];
  const previews = group.tabs.filter((t) => t.kind === 'browser').map((t) => t.id);
  byProject.delete(dir);
  changed();
  return previews;
}

export const previewTabs = (dir) => tabsOf(dir).filter((t) => t.kind === 'browser').map((t) => t.id);

// Every folder this store is holding tabs for, so a caller reconciling against
// main does not have to keep its own list of folders to ask about.
export const projectDirs = () => [...byProject.keys()];

/* Moving to a folder with an open column and nothing in its strip. Reading the
   diff in one project and switching to another means you want that project's
   diff, not an empty column with three buttons in it, so the kind you were
   looking at comes across. Nothing is carried when the column is shut: a folder
   you never opened it on keeps costing nothing. */
export function carryInto(dir, kind) {
  if (!layout.rightOpen || !kind) return null;
  if (tabsOf(dir).length) return activeTab(dir);
  return openTab(dir, kind);
}
