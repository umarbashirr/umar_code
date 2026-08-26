/* The title bar: the mark, the menus, and the window buttons.

   The BrowserWindow is frameless, so minimise, maximise and close are ours to
   draw. The native menu carries the same items for the keyboard and the Alt
   key; this is the one people can see. */
import { Fragment, useEffect, useState, useSyncExternalStore } from 'react';
import { CheckIcon, CopyIcon, HexagonIcon, MinusIcon, SquareIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Menubar,
  MenubarContent,
  MenubarGroup,
  MenubarItem,
  MenubarLabel,
  MenubarMenu,
  MenubarSeparator,
  MenubarShortcut,
  MenubarTrigger,
} from '@/components/ui/menubar';
import { runCommand } from '../../app.js';
import { onProject, openFolder, openRecent, project, shortPath } from '../../project.js';
import { chosenEditor, editors, getEditorsVersion, openEditor, subscribeEditors } from './editors-store';
import { coverPane, uncoverPane } from './pane-cover';

// project.js still owns the folder and tells its listeners when it changes.
function useProject() {
  const [, bump] = useState(0);
  useEffect(() => onProject(() => bump((n) => n + 1)), []);
  return project;
}

function useWindowState() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const apply = (s) => setMaximized(!!s?.maximized);
    window.tandem.win.onState(apply);
    window.tandem.win.state().then(apply).catch(() => {});
  }, []);
  return maximized;
}

/* A menu that opens over the preview opens behind it: the preview is a native
   view painted on top of this document. Freeze the page under whichever menu is
   showing, and let it go once none is. Walking the bar carries a menu off the
   pane and back on again, so this runs on every change, not only the first. */
function usePaneCover(open) {
  useEffect(() => {
    if (!open) {
      uncoverPane();
      return undefined;
    }
    // Radix portals and positions the content after this fires.
    const id = requestAnimationFrame(() => {
      const content = document.querySelector('[data-slot="menubar-content"]');
      coverPane(content?.getBoundingClientRect());
    });
    return () => cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => uncoverPane, []);
}

/* A path is clipped from the left, which is the end you can throw away. An rtl
   box puts the ellipsis at the start; plaintext keeps the path itself reading
   left to right, so the leading ~ does not end up on the wrong end. */
const Note = ({ children }) => (
  <span
    dir="rtl"
    className="ml-auto max-w-[22ch] truncate font-mono text-[10.5px] text-muted-foreground [unicode-bidi:plaintext]">
    {children}
  </span>
);

function FileMenu({ folder }) {
  // The toolbar's own button is the short way in; this lists them all, because
  // a button with no label is a button nobody finds on purpose.
  useSyncExternalStore(subscribeEditors, getEditorsVersion, getEditorsVersion);
  const chosen = chosenEditor();
  const recents = folder.recents.slice(0, 6);

  return (
    <MenubarMenu value="file">
      <MenubarTrigger>File</MenubarTrigger>
      <MenubarContent align="start">
        <MenubarGroup>
          <MenubarItem onSelect={() => openFolder()}>
            Open folder…
            <MenubarShortcut>^O</MenubarShortcut>
          </MenubarItem>
          <MenubarItem onSelect={() => openFolder({ newWindow: true })}>
            Open folder in new window…
            <MenubarShortcut>^⇧O</MenubarShortcut>
          </MenubarItem>
        </MenubarGroup>

        {recents.length > 0 && (
          <>
            <MenubarSeparator />
            <MenubarLabel>Recent</MenubarLabel>
            <MenubarGroup>
              {recents.map((r) => (
                <MenubarItem key={r.path} onSelect={() => openRecent(r.path)}>
                  <span className="truncate">{r.name}</span>
                  <Note>{shortPath(r.path)}</Note>
                </MenubarItem>
              ))}
            </MenubarGroup>
          </>
        )}

        {editors.list.length > 0 && folder.chosen && (
          <>
            <MenubarSeparator />
            <MenubarLabel>Open this folder in</MenubarLabel>
            <MenubarGroup>
              {editors.list.map((e) => (
                <MenubarItem key={e.id} onSelect={() => openEditor(e.id)}>
                  {/* An installed app's own icon is a better likeness than any
                      line drawing from the icon set. */}
                  {e.icon && <img src={e.icon} alt="" className="size-4 rounded-xs" />}
                  <span className="truncate">{e.name}</span>
                  {e.id === chosen?.id && <CheckIcon className="ml-auto" />}
                </MenubarItem>
              ))}
            </MenubarGroup>
          </>
        )}

        <MenubarSeparator />
        <MenubarGroup>
          <MenubarItem onSelect={() => runCommand('newChat')}>New chat</MenubarItem>
          <MenubarItem onSelect={() => runCommand('newTerminal')}>
            New terminal
            <MenubarShortcut>^⇧T</MenubarShortcut>
          </MenubarItem>
        </MenubarGroup>

        <MenubarSeparator />
        <MenubarGroup>
          <MenubarItem onSelect={() => runCommand('settings')}>
            Settings…
            <MenubarShortcut>^,</MenubarShortcut>
          </MenubarItem>
        </MenubarGroup>
      </MenubarContent>
    </MenubarMenu>
  );
}

// A null is a separator. Edit is routed through the main process because focus
// may be inside the preview pane, which is a different web contents entirely.
const edit = (action) => () => window.tandem.win.action(action);
const command = (name) => () => runCommand(name);

const MENUS = [
  {
    value: 'edit',
    label: 'Edit',
    items: [
      ['Undo', edit('undo'), '^Z'],
      ['Redo', edit('redo'), '^⇧Z'],
      null,
      ['Cut', edit('cut'), '^X'],
      ['Copy', edit('copy'), '^C'],
      ['Paste', edit('paste'), '^V'],
      ['Select all', edit('selectAll'), '^A'],
    ],
  },
  {
    value: 'view',
    label: 'View',
    items: [
      ['Sessions', command('rail'), '^⇧S'],
      ['Full screen', edit('fullScreen'), 'F11'],
      ['Terminal', command('terminal'), '^`'],
      ['Preview browser', command('preview'), '^⇧B'],
      ['Project files', command('files'), '^⇧D'],
      ['Uncommitted changes', command('changes'), '^⇧G'],
      ['Right pane at full width', command('previewFull'), '^⇧F'],
      ['Console and network', command('drawer'), '^⇧J'],
      null,
      ['Bigger', command('zoomIn'), '^+'],
      ['Smaller', command('zoomOut'), '^-'],
      ['Reset size', command('zoomReset'), '^0'],
      null,
      ['Light or dark', command('theme')],
      ['Theme…', command('appearance')],
    ],
  },
  {
    value: 'help',
    label: 'Help',
    items: [
      ['Copy MCP command', command('copyMcp')],
      ['Check for updates…', command('updates')],
      ['About', command('about')],
    ],
  },
];

function groups(items) {
  const out = [[]];
  for (const item of items) {
    if (item) out[out.length - 1].push(item);
    else out.push([]);
  }
  return out;
}

function SimpleMenu({ menu }) {
  return (
    <MenubarMenu value={menu.value}>
      <MenubarTrigger>{menu.label}</MenubarTrigger>
      <MenubarContent align="start">
        {groups(menu.items).map((group, i) => (
          <Fragment key={group[0][0]}>
            {i > 0 && <MenubarSeparator />}
            <MenubarGroup>
              {group.map(([label, run, hint]) => (
                <MenubarItem key={label} onSelect={run}>
                  {label}
                  {hint && <MenubarShortcut>{hint}</MenubarShortcut>}
                </MenubarItem>
              ))}
            </MenubarGroup>
          </Fragment>
        ))}
      </MenubarContent>
    </MenubarMenu>
  );
}

const WINDOW_BUTTON = 'h-full w-11 rounded-none text-muted-foreground [&_svg]:size-3.5';

export default function TitleBar() {
  const folder = useProject();
  const maximized = useWindowState();
  const [open, setOpen] = useState('');
  usePaneCover(open);

  // Frameless windows do not get the double-click-to-maximise the desktop gives
  // every other window, so the drag strip has to offer it.
  const onDoubleClick = (e) => {
    if (e.target.closest('button, input, [data-slot="menubar"]')) return;
    window.tandem.win.action('maximize');
  };

  return (
    <header id="titlebar" onDoubleClick={onDoubleClick}>
      <span className="flex text-muted-foreground"><HexagonIcon className="size-[15px]" /></span>

      {/* A menu bar in a title bar is the chrome, not a card sitting on it. */}
      <Menubar
        value={open}
        onValueChange={setOpen}
        className="h-auto rounded-none border-0 bg-transparent p-0 shadow-none">
        <FileMenu folder={folder} />
        {MENUS.map((menu) => <SimpleMenu key={menu.value} menu={menu} />)}
      </Menubar>

      <span className="flex-1" />

      <div className="flex self-stretch">
        <Button variant="ghost" size="icon" className={WINDOW_BUTTON} title="Minimize" onClick={edit('minimize')}>
          <MinusIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={WINDOW_BUTTON}
          title={maximized ? 'Restore' : 'Maximize'}
          onClick={edit('maximize')}>
          {maximized ? <CopyIcon /> : <SquareIcon />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={`${WINDOW_BUTTON} hover:bg-destructive hover:text-white`}
          title="Close"
          onClick={edit('close')}>
          <XIcon />
        </Button>
      </div>
    </header>
  );
}
