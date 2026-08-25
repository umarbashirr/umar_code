/* The "open in" button. Tandem holds a folder open; sooner or later you want a
   real editor on the same folder, and the way that usually goes is finding a
   terminal and typing the name of one.

   The button opens the editor you last picked. The menu behind it lists every
   editor found on the machine, so switching is one click and picking the first
   one is the only setup. */
'use strict';
import { $, el, icons, iconMark, toast } from './app.js';
import { showMenu, closeMenu } from './menu-pop.js';
import { project, onProject } from './project.js';

const btn = $('#open-in');

const state = { list: [], chosen: '', open: false };

const chosen = () => state.list.find((e) => e.id === state.chosen) || null;

function paint() {
  // Nothing installed and no folder open are different reasons to be quiet,
  // and both end with the button not being there.
  btn.hidden = !state.list.length || !project.chosen;
  const e = chosen();
  btn.title = e
    ? `Open this folder in ${e.name} (right-click for the others)`
    : 'Open this folder in an editor';
  btn.classList.toggle('on', state.open);

  // Once an editor is picked the button wears that editor's own icon, which
  // says what it does better than any label would fit.
  const want = e?.icon || '';
  if (btn.dataset.icon === want) return;
  btn.dataset.icon = want;
  if (want) {
    const img = el('img');
    img.src = want;
    img.alt = '';
    btn.replaceChildren(img);
  } else {
    btn.replaceChildren(iconMark('code-xml'));
    icons();
  }
}

async function load({ fresh = false } = {}) {
  state.list = await window.tandem.editors.list(fresh) || [];
  const settings = window.tandem.settings.snapshot();
  state.chosen = settings?.editor?.id || '';
  // An editor that was uninstalled since it was picked falls back to the first
  // one on the machine rather than to an error nobody asked for.
  if (state.chosen && !chosen()) state.chosen = '';
  paint();
}

async function openIn(id) {
  const res = await window.tandem.editors.open(id);
  if (res?.error) {
    toast('Could not open that editor', res.error, [{ label: 'ok', primary: true }]);
    return;
  }
  if (state.chosen !== id) {
    state.chosen = id;
    window.tandem.settings.set({ editor: { id } });
    paint();
  }
}

function menuItems() {
  if (!state.list.length) {
    return [
      { header: 'No editors found' },
      { label: 'Look again', icon: 'rotate-cw', run: () => load({ fresh: true }) },
    ];
  }
  const items = state.list.map((e) => ({
    label: e.name,
    note: e.bin,
    iconUrl: e.icon || undefined,
    icon: e.icon ? undefined : 'code-xml',
    on: e.id === state.chosen,
    run: () => openIn(e.id),
  }));
  items.push({ sep: true }, { label: 'Look again', icon: 'rotate-cw', run: () => load({ fresh: true }) });
  return items;
}

function showList() {
  if (state.open) return closeMenu();
  showMenu(btn, menuItems(), {
    id: 'open-in',
    align: 'right',
    onClose: () => { state.open = false; paint(); },
  });
  state.open = true;
  paint();
}

btn.onclick = (e) => {
  e.stopPropagation();
  // A left click on a button that has never been used has nothing to open, so
  // it asks. After that it just opens, the way the tab it sits next to does.
  const pick = chosen();
  if (!pick || e.altKey) return showList();
  openIn(pick.id);
};

btn.oncontextmenu = (e) => {
  e.preventDefault();
  e.stopPropagation();
  showList();
};

// The list belongs to the machine, not the project, but the button only makes
// sense once a folder is open, and project.js is what knows when that is.
onProject(() => paint());
window.tandem.settings.onChanged(() => {
  const id = window.tandem.settings.snapshot()?.editor?.id || '';
  if (id !== state.chosen) { state.chosen = id; paint(); }
});

// The File menu lists these too, because a button with no label is a button
// nobody finds on purpose.
window.tandemEditors = {
  list: () => state.list,
  chosen: () => state.chosen,
  open: openIn,
};

load();
icons();
