/* One popup, shared by the title bar menus and the preview pane menu. Only one
   can be on screen at a time, so they share the element too. */
'use strict';
import { el, icons, iconMark } from './app.js';

let box = null;
let current = null;   // { id, onClose }

function popup() {
  if (box) return box;
  box = el('div', 'menu-pop');
  box.hidden = true;
  document.body.appendChild(box);
  return box;
}

export const openMenu = () => current?.id ?? null;

/* The preview is a native view the window paints on top of this document, so a
   popup landing over it opens somewhere nobody can see. The pane menu's own
   trigger sits in that column, so its menu always lands there; the title bar
   menus do too once the preview runs full width.

   Parking the pane the way a modal does would resize the page, and picking a
   viewport while the page jumps to another width is no good. So freeze it
   instead: photograph the page, hang the picture where the view was, and hide
   the view until the menu closes. The bounds never change, so nothing reflows
   and the page comes back on exactly the frame it left. */
let still = null;

function coverPane(popRect) {
  const slot = document.querySelector('#paneslot');
  const r = slot.getBoundingClientRect();
  const clear = !r.width || !r.height       // nothing in that column to cover
    || popRect.right < r.left || popRect.left > r.right
    || popRect.bottom < r.top || popRect.top > r.bottom;
  // Walking the menu bar can carry a menu off the pane and back on again.
  if (clear) return uncoverPane();
  if (still) return;

  const mine = current;
  window.tandem.browser.action('still').then((url) => {
    // A photograph that arrived after its menu was dismissed.
    if (current !== mine || still) return;
    still = el('img', 'pane-still');
    if (url) still.src = url;
    slot.appendChild(still);
    window.tandem.browser.setVisible(false);
  }).catch(() => {});
}

function uncoverPane() {
  if (!still) return;
  still.remove();
  still = null;
  window.tandem.browser.setVisible(true);
}

export function closeMenu() {
  if (!current) return;
  const { onClose } = current;
  current = null;
  popup().hidden = true;
  uncoverPane();
  onClose?.();
}

/* items: { label, hint, note, ltr, icon, on, danger, disabled, run } | { sep } | { header }
   note is right-aligned and clipped from the left, which is what a path wants;
   ltr turns that off for notes that read left to right, like a pixel size. */
export function showMenu(trigger, items, { id = 'menu', align = 'left', onClose } = {}) {
  const wasOpen = current;
  current = null;              // so closeMenu's callback doesn't fight this open
  if (wasOpen) { popup().hidden = true; wasOpen.onClose?.(); }

  const pop = popup();
  pop.innerHTML = '';
  const withIcons = items.some((i) => i.icon);

  for (const item of items) {
    if (item.sep) { pop.appendChild(el('div', 'menu-sep')); continue; }
    if (item.header) { pop.appendChild(el('div', 'menu-header', item.header)); continue; }

    const row = el('button', 'menu-item' + (item.danger ? ' danger' : '') + (item.on ? ' on' : ''));
    if (withIcons) {
      const slot = el('span', 'menu-icon');
      if (item.icon) slot.appendChild(iconMark(item.icon));
      row.appendChild(slot);
    }
    row.appendChild(el('span', 'menu-label', item.label));
    if (item.note) row.appendChild(el('span', 'menu-note' + (item.ltr ? ' ltr' : ''), item.note));
    if (item.hint) row.appendChild(el('kbd', null, item.hint));
    if (item.on) row.appendChild(iconMark('check'));
    row.disabled = !!item.disabled;
    row.onclick = () => { closeMenu(); item.run?.(); };
    pop.appendChild(row);
  }

  pop.hidden = false;
  icons();

  const r = trigger.getBoundingClientRect();
  const w = pop.getBoundingClientRect().width;
  const left = align === 'right' ? r.right - w : r.left;
  pop.style.left = Math.round(Math.max(8, Math.min(left, window.innerWidth - w - 8))) + 'px';
  pop.style.top = Math.round(r.bottom + 4) + 'px';

  current = { id, onClose };
  coverPane(pop.getBoundingClientRect());
}

window.addEventListener('click', closeMenu);
// Focus moving to the preview pane never reaches this document as a click.
window.addEventListener('blur', closeMenu);
window.addEventListener('resize', closeMenu);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
