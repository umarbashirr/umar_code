/* One box for everything the window can be asked to do.

   The rail searches chats, the chip switches folders, the toolbar holds the
   views and the menu bar holds the rest. Each of those is the right place to
   put its own thing and the wrong place to look when you do not know which of
   them you want. This is the place you go when you know what you want and not
   where it lives: a chat in any folder, a folder, a file in the one you are in,
   or a command by its name.

   Ctrl+K opens it, except with the cursor in a terminal, where Ctrl+K has meant
   kill-to-end-of-line for forty years and this app is a terminal first.
   Ctrl+Shift+P opens it from anywhere, including there, which is the rule the
   rest of the app's chords already follow.

   Files are the one section that has to ask main. Chats, folders and commands
   are all in memory, so the list is whole from the first keystroke. */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ClipboardIcon, DownloadIcon, FileIcon, FolderIcon, FolderPlusIcon, FolderTreeIcon,
  GitCompareIcon, GlobeIcon, InfoIcon, MaximizeIcon, MessageSquareIcon, PaletteIcon,
  PlusIcon, SettingsIcon, SquarePenIcon, SquareTerminalIcon, SunMoonIcon, TerminalIcon,
} from 'lucide-react';
import {
  Command, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { runCommand } from '../../app.js';
import { openFolder } from '../../project.js';
import { shortPath, useProject } from '../useProject.js';
import { getRailVersion, grouped, refreshRail, relative, subscribeRail } from './rail-store';

/* The commands worth reaching by name. Everything runCommand answers to is not
   the same list: the zoom steps and the folder pickers have chords and buttons
   of their own, and a palette that lists every branch of a switch statement is
   a switch statement with a search box. */
const COMMANDS = [
  { name: 'preview', label: 'Preview browser', icon: GlobeIcon, hint: 'Ctrl+Shift+B' },
  { name: 'files', label: 'Project files', icon: FolderTreeIcon, hint: 'Ctrl+Shift+D' },
  { name: 'changes', label: 'Uncommitted changes', icon: GitCompareIcon, hint: 'Ctrl+Shift+G' },
  { name: 'terminal', label: 'Terminal panel', icon: TerminalIcon, hint: 'Ctrl+`' },
  { name: 'drawer', label: 'Console and network', icon: SquareTerminalIcon, hint: 'Ctrl+Shift+J' },
  { name: 'previewFull', label: 'Right pane at full width', icon: MaximizeIcon, hint: 'Ctrl+Shift+F' },
  { name: 'newTerminal', label: 'New terminal', icon: PlusIcon, hint: 'Ctrl+Shift+T' },
  { name: 'newChat', label: 'New chat', icon: SquarePenIcon },
  { name: 'theme', label: 'Light or dark', icon: SunMoonIcon },
  { name: 'appearance', label: 'Theme and appearance', icon: PaletteIcon },
  { name: 'settings', label: 'Settings', icon: SettingsIcon, hint: 'Ctrl+,' },
  { name: 'copyMcp', label: 'Copy MCP command', icon: ClipboardIcon },
  { name: 'updates', label: 'Check for updates', icon: DownloadIcon },
  { name: 'about', label: 'About Tandem', icon: InfoIcon },
];

// A key pressed with the cursor in a terminal belongs to the shell. xterm
// forwards it to the pty and the event carries on up here regardless, so the
// only way to tell is to ask where it started.
const inTerminal = (target) => !!(target instanceof Element && target.closest('.xterm'));

export default function Palette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [files, setFiles] = useState([]);
  const window_ = useProject();

  // The rail's store already holds every chat this window knows about, in the
  // order it draws them, with the ones marked done kept apart. Reading it here
  // costs a subscription and keeps one answer to what a chat is called.
  const [, bump] = useState(0);
  useEffect(() => subscribeRail(() => bump(getRailVersion())), []);
  useEffect(() => { if (open) refreshRail(); }, [open]);

  const chats = grouped().flatMap((folder) =>
    [...folder.rows, ...folder.done].map((chat) => ({ chat, folder })));

  const here = new Set((window_.projects || []).map((p) => p.dir));
  const recents = (window_.recents || []).filter((r) => !here.has(r.path)).slice(0, 6);

  /* Files are the one thing main has to be asked for. The wait is the same 80ms
     the composer's @ menu uses, and the last answer stays on screen while the
     next one is out rather than the list blinking on every keystroke. */
  const live = useRef(0);
  useEffect(() => {
    if (!open || !query.trim()) { setFiles([]); return undefined; }
    const seq = ++live.current;
    const timer = setTimeout(async () => {
      const res = await window.tandem.files.search(query.trim()).catch(() => null);
      if (seq === live.current) setFiles((res?.matches || []).slice(0, 8));
    }, 80);
    return () => clearTimeout(timer);
  }, [open, query]);

  const run = useCallback((fn) => { setOpen(false); setQuery(''); fn(); }, []);

  /* cmdk's own filter scores every item against the query and leaves the groups
     where they are, which reads fine until one group is a hundred rows. Typing
     "term" then answers with eight chats that mention terminals and buries the
     command that opens one. So the filtering is done here: each group is cut to
     its own best few, and a group that matched nothing drops out rather than
     pushing the ones that did off the bottom. */
  const q = query.trim().toLowerCase();
  const at = (text) => (text || '').toLowerCase().indexOf(q);
  const hit = (text) => !q || at(text) >= 0;
  const near = (text) => (at(text) < 0 ? 1e6 : at(text));

  // With nothing typed the chats are the recent ones across every folder, not
  // the first few of whichever folder the rail happens to draw first.
  const chatRows = (q
    ? chats.filter(({ chat, folder }) => hit(`${chat.title} ${folder.name}`))
      .sort((a, b) => near(a.chat.title) - near(b.chat.title))
    : [...chats].sort((a, b) => (b.chat.at || 0) - (a.chat.at || 0))
  ).slice(0, 6);

  const folderRows = (window_.projects || []).filter((p) => hit(`${p.name} ${p.dir}`));
  const recentRows = recents.filter((r) => hit(`${r.name} ${r.path}`));
  const commandRows = COMMANDS.filter((c) => hit(c.label));
  const findFolder = hit('find a folder on this machine');
  const nothing = !chatRows.length && !files.length && !folderRows.length
    && !recentRows.length && !commandRows.length && !findFolder;

  /* The two ways in. Ctrl+Shift+P is in the app's own chord range, so the
     terminal hands it over; plain Ctrl+K is not, so it arrives here even from a
     shell that has already acted on it, and that one is turned away. */
  useEffect(() => {
    window.tandemPalette = { open: () => setOpen(true), toggle: () => setOpen((v) => !v) };
    const onKey = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      const k = (e.key || '').toLowerCase();
      const wanted = (mod && e.shiftKey && k === 'p')
        || (mod && !e.shiftKey && k === 'k' && !inTerminal(e.target));
      if (!wanted) return;
      e.preventDefault();
      setOpen((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); window.tandemPalette = null; };
  }, []);

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) setQuery(''); }}>
      <DialogHeader className="sr-only">
        <DialogTitle>Command palette</DialogTitle>
        <DialogDescription>Search chats, folders and files, or run a command.</DialogDescription>
      </DialogHeader>
      <DialogContent className="overflow-hidden p-0 sm:max-w-2xl" showCloseButton={false}>
        {/* Ours, not cmdk's. See the note above the row lists. */}
        <Command shouldFilter={false} className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground">
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Search chats, folders and files, or type a command" />
          <CommandList className="max-h-[60vh]">
            {nothing && (
              <div className="py-8 text-center text-muted-foreground text-sm">Nothing matches that.</div>
            )}

            {!!chatRows.length && (
              <CommandGroup heading={q ? 'Chats' : 'Recent chats'}>
                {chatRows.map(({ chat, folder }) => (
                  <CommandItem
                    key={chat.key || chat.id}
                    value={`chat ${chat.key || chat.id}`}
                    onSelect={() => run(() => window.tandemChat?.open(chat))}>
                    <MessageSquareIcon />
                    <span className="truncate">{chat.title}</span>
                    <span className="ml-auto shrink-0 text-muted-foreground text-xs">
                      {folder.name} · {relative(chat.at)}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {!!files.length && (
              <CommandGroup heading="Files">
                {files.map((f) => (
                  <CommandItem
                    key={f.path}
                    value={`file ${f.path}`}
                    onSelect={() => run(() => runCommand('openFile', f.path))}>
                    <FileIcon />
                    <span className="truncate">{f.name}</span>
                    {/* Where it is, not what it is called again: a file in the
                        root of the project would otherwise print its own name
                        twice across the row. */}
                    {f.path !== f.name && (
                      <span className="ml-auto shrink-0 truncate text-muted-foreground text-xs">
                        {f.path.slice(0, f.path.length - f.name.length - 1)}
                      </span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {!!commandRows.length && (
              <CommandGroup heading="Commands">
                {commandRows.map((c) => (
                  <CommandItem
                    key={c.name}
                    value={`command ${c.name}`}
                    onSelect={() => run(() => runCommand(c.name))}>
                    <c.icon />
                    <span>{c.label}</span>
                    {c.hint && <span className="ml-auto shrink-0 text-muted-foreground text-xs">{c.hint}</span>}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {(!!folderRows.length || !!recentRows.length || findFolder) && (
              <CommandGroup heading="Folders">
                {folderRows.map((p) => (
                  <CommandItem
                    key={p.dir}
                    value={`folder ${p.dir}`}
                    onSelect={() => run(() => window.tandem.project.focus(p.dir))}>
                    <FolderIcon />
                    <span className="truncate">{p.name}</span>
                    <span className="ml-auto shrink-0 truncate text-muted-foreground text-xs">
                      {shortPath(p.dir, window_.home)}
                    </span>
                  </CommandItem>
                ))}
                {recentRows.map((r) => (
                  <CommandItem
                    key={r.path}
                    value={`recent ${r.path}`}
                    onSelect={() => run(() => openFolder({ dir: r.path }))}>
                    <FolderPlusIcon />
                    <span className="truncate">{r.name}</span>
                    <span className="ml-auto shrink-0 truncate text-muted-foreground text-xs">
                      {shortPath(r.path, window_.home)}
                    </span>
                  </CommandItem>
                ))}
                {findFolder && (
                  <CommandItem value="find-folder" onSelect={() => run(() => openFolder())}>
                    <FolderPlusIcon />
                    <span>Find a folder on this machine…</span>
                  </CommandItem>
                )}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
