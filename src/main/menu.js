'use strict';
// The native application menu. The window draws its own title bar, so this one
// stays hidden until Alt is pressed; it exists so folder switching, the clipboard
// and the window roles are reachable from the keyboard wherever focus happens to
// be, including inside the preview pane.
//
// View items carry an accelerator for display only. Those chords are already
// handled in the renderer, and registering them here too would fire twice.
const os = require('os');
const { Menu } = require('electron');

const home = os.homedir();
const short = (p) => (p === home ? '~' : p.startsWith(home + '/') ? '~' + p.slice(home.length) : p);

function buildMenu({ recents = [], actions }) {
  const isMac = process.platform === 'darwin';
  const command = (label, name, accelerator) => ({
    label,
    accelerator,
    registerAccelerator: false,
    click: () => actions.command(name),
  });
  // The one chord the menu really owns. With the preview at full width the
  // focus is usually inside the page, where a renderer keydown never lands, so
  // this accelerator is registered for real and the renderer leaves it alone.
  const hotkey = (label, name, accelerator) => ({
    label,
    accelerator,
    click: () => actions.command(name),
  });

  const recentItems = recents.length
    ? [
      ...recents.map((r) => ({ label: short(r.path), click: () => actions.openRecent(r.path) })),
      { type: 'separator' },
      { label: 'Clear list', click: () => actions.clearRecents() },
    ]
    : [{ label: 'Nothing yet', enabled: false }];

  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '&File',
      submenu: [
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+O', click: () => actions.openFolder() },
        { label: 'Open Folder in New Window…', accelerator: 'CmdOrCtrl+Shift+O', click: () => actions.openFolder({ newWindow: true }) },
        { label: 'Open Recent', submenu: recentItems },
        { type: 'separator' },
        command('New Chat', 'newChat'),
        command('New Terminal', 'newTerminal', 'CmdOrCtrl+Shift+T'),
        { type: 'separator' },
        hotkey('Settings…', 'settings', 'CmdOrCtrl+,'),
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: '&View',
      submenu: [
        command('Sessions', 'rail', 'CmdOrCtrl+Shift+S'),
        command('Terminal', 'terminal', 'CmdOrCtrl+`'),
        command('Preview Browser', 'preview', 'CmdOrCtrl+Shift+B'),
        command('Project Files', 'files', 'CmdOrCtrl+Shift+D'),
        command('Uncommitted Changes', 'changes', 'CmdOrCtrl+Shift+G'),
        hotkey('Right Pane at Full Width', 'previewFull', 'CmdOrCtrl+Shift+F'),
        command('Console and Network', 'drawer', 'CmdOrCtrl+Shift+J'),
        { type: 'separator' },
        command('Light or Dark', 'theme'),
        command('Theme…', 'appearance'),
        { type: 'separator' },
        // The renderer owns the zoom, because the app shell and the preview
        // pane are different web contents and only one of them should scale.
        // These are registered for real: with the preview at full width the
        // focus is inside the page, where a renderer keydown never lands.
        hotkey('Zoom In', 'zoomIn', 'CmdOrCtrl+Plus'),
        // Same command on the unshifted key, which is what most keyboards
        // actually produce. A menu item carries one accelerator, so it takes
        // two of them to cover both.
        { ...hotkey('Zoom In', 'zoomIn', 'CmdOrCtrl+='), visible: false },
        hotkey('Zoom Out', 'zoomOut', 'CmdOrCtrl+-'),
        hotkey('Reset Zoom', 'zoomReset', 'CmdOrCtrl+0'),
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools', label: 'Developer Tools (app shell)' },
      ],
    },
    {
      label: '&Help',
      submenu: [
        command('Copy MCP Command', 'copyMcp'),
        command('Check for Updates…', 'updates'),
        command('About', 'about'),
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

const applyMenu = (opts) => Menu.setApplicationMenu(buildMenu(opts));

module.exports = { buildMenu, applyMenu, short };
