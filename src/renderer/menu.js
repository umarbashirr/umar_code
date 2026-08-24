/* The menu bar in the title bar. The native menu carries the same items for the
   keyboard and the Alt key; this is the one people can see. */
'use strict';
import { $, el, runCommand } from './app.js';
import { showMenu, closeMenu } from './menu-pop.js';
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
        sep(),
        { label: 'Settings…', hint: '^,', run: () => runCommand('settings') },
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
      { label: 'Undo', hint: '^Z', run: () => window.tandem.win.action('undo') },
      { label: 'Redo', hint: '^⇧Z', run: () => window.tandem.win.action('redo') },
      sep(),
      { label: 'Cut', hint: '^X', run: () => window.tandem.win.action('cut') },
      { label: 'Copy', hint: '^C', run: () => window.tandem.win.action('copy') },
      { label: 'Paste', hint: '^V', run: () => window.tandem.win.action('paste') },
      { label: 'Select all', hint: '^A', run: () => window.tandem.win.action('selectAll') },
    ],
  },
  {
    id: 'view',
    label: 'View',
    items: () => [
      { label: 'Sessions', hint: '^⇧S', run: () => runCommand('rail') },
      { label: 'Full screen', hint: 'F11', run: () => window.tandem.win.action('fullScreen') },
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
      { label: 'Check for updates…', run: () => runCommand('updates') },
      { label: 'About', run: () => runCommand('about') },
    ],
  },
];

let open = null; // the menu id currently showing

function paint() {
  for (const b of $('#menubar').children) b.classList.toggle('on', b.dataset.menu === open);
}

function show(menu, trigger) {
  // showMenu closes whatever was showing first, and that fires its onClose.
  showMenu(trigger, menu.items(), { id: menu.id, onClose: () => { if (open === menu.id) { open = null; paint(); } } });
  open = menu.id;
  paint();
}

const bar = $('#menubar');
for (const menu of MENUS) {
  const btn = el('button', 'menu-trigger', menu.label);
  btn.dataset.menu = menu.id;
  btn.onclick = (e) => { e.stopPropagation(); open === menu.id ? closeMenu() : show(menu, btn); };
  // Once one menu is showing, sliding across the bar walks between them.
  btn.onmouseenter = () => { if (open && open !== menu.id) show(menu, btn); };
  bar.appendChild(btn);
}
