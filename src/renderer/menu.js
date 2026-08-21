/* The menu bar in the title bar. The native menu carries the same items for the
   keyboard and the Alt key; this is the one people can see. */
'use strict';
import { $, el, runCommand } from './app.js';
import { project, shortPath, openFolder, openRecent } from './project.js';

const sep = () => ({ sep: true });

const MENUS = [
  {
    id: 'file',
    label: 'File',
    items: () => {
      const items = [
        { label: 'Open folder…', hint: '^O', run: () => openFolder() },
        { label: 'Open folder in new window…', hint: '^⇧O', run: () => openFolder({ newWindow: true }) },
      ];
      const recents = project.recents.slice(0, 6);
      if (recents.length) {
        items.push(sep(), { header: 'Recent' });
        for (const r of recents) items.push({ label: r.name, note: shortPath(r.path), run: () => openRecent(r.path) });
      }
      items.push(
        sep(),
        { label: 'New chat', run: () => runCommand('newChat') },
        { label: 'New terminal', hint: '^⇧T', run: () => runCommand('newTerminal') },
      );
      return items;
    },
  },
  {
    id: 'edit',
    label: 'Edit',
    // Routed through the main process because focus may be inside the preview
    // pane, which is a different web contents entirely.
    items: () => [
      { label: 'Undo', hint: '^Z', run: () => window.pba.win.action('undo') },
      { label: 'Redo', hint: '^⇧Z', run: () => window.pba.win.action('redo') },
      sep(),
      { label: 'Cut', hint: '^X', run: () => window.pba.win.action('cut') },
      { label: 'Copy', hint: '^C', run: () => window.pba.win.action('copy') },
      { label: 'Paste', hint: '^V', run: () => window.pba.win.action('paste') },
      { label: 'Select all', hint: '^A', run: () => window.pba.win.action('selectAll') },
    ],
  },
  {
    id: 'view',
    label: 'View',
    items: () => [
      { label: 'Sessions', hint: '^⇧S', run: () => runCommand('rail') },
      { label: 'Full screen', hint: 'F11', run: () => window.pba.win.action('fullScreen') },
      { label: 'Terminal', hint: '^`', run: () => runCommand('terminal') },
      { label: 'Preview browser', hint: '^⇧B', run: () => runCommand('preview') },
      { label: 'Project files', hint: '^⇧D', run: () => runCommand('files') },
      { label: 'Right pane at full width', hint: '^⇧F', run: () => runCommand('previewFull') },
      { label: 'Console and network', hint: '^⇧J', run: () => runCommand('drawer') },
      sep(),
      { label: 'Bigger', hint: '^+', run: () => runCommand('zoomIn') },
      { label: 'Smaller', hint: '^-', run: () => runCommand('zoomOut') },
      { label: 'Reset size', hint: '^0', run: () => runCommand('zoomReset') },
      sep(),
      { label: 'Light or dark', run: () => runCommand('theme') },
    ],
  },
  {
    id: 'help',
    label: 'Help',
    items: () => [
      { label: 'Copy MCP command', run: () => runCommand('copyMcp') },
      { label: 'About', run: () => runCommand('about') },
    ],
  },
];

let open = null; // the menu id currently showing
let pop = null;

function popup() {
  if (pop) return pop;
  pop = el('div', 'menu-pop');
  pop.hidden = true;
  document.body.appendChild(pop);
  return pop;
}

function close() {
  if (!open) return;
  open = null;
  popup().hidden = true;
  for (const b of $('#menubar').children) b.classList.remove('on');
}

function show(menu, trigger) {
  const box = popup();
  box.innerHTML = '';

  for (const item of menu.items()) {
    if (item.sep) { box.appendChild(el('div', 'menu-sep')); continue; }
    if (item.header) { box.appendChild(el('div', 'menu-header', item.header)); continue; }

    const row = el('button', 'menu-item');
    row.appendChild(el('span', 'menu-label', item.label));
    if (item.note) row.appendChild(el('span', 'menu-note', item.note));
    if (item.hint) row.appendChild(el('kbd', null, item.hint));
    row.disabled = !!item.disabled;
    row.onclick = () => { close(); item.run?.(); };
    box.appendChild(row);
  }

  box.hidden = false;
  const r = trigger.getBoundingClientRect();
  const width = box.getBoundingClientRect().width;
  box.style.left = Math.round(Math.min(r.left, window.innerWidth - width - 8)) + 'px';
  box.style.top = Math.round(r.bottom + 4) + 'px';

  open = menu.id;
  for (const b of $('#menubar').children) b.classList.toggle('on', b.dataset.menu === menu.id);
}

const bar = $('#menubar');
for (const menu of MENUS) {
  const btn = el('button', 'menu-trigger', menu.label);
  btn.dataset.menu = menu.id;
  btn.onclick = (e) => { e.stopPropagation(); open === menu.id ? close() : show(menu, btn); };
  // Once one menu is showing, sliding across the bar walks between them.
  btn.onmouseenter = () => { if (open && open !== menu.id) show(menu, btn); };
  bar.appendChild(btn);
}

// The folder label, when the title bar shows one, doubles as the Project menu.
const projectLabel = $('#project');
if (projectLabel) {
  projectLabel.onclick = (e) => {
    e.stopPropagation();
    const menu = MENUS[0];
    open === menu.id ? close() : show(menu, projectLabel);
  };
}

window.addEventListener('click', close);
// Focus moving to the preview pane never reaches this document as a click.
window.addEventListener('blur', close);
window.addEventListener('resize', close);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
