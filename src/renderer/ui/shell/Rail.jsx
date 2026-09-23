/* The chat rail. One section per open project, each holding that folder's
   chats, newest first. The folder you worked in last sits on top.

   The shadcn Sidebar runs with collapsible="none": the resizable panel around
   it owns the width and the collapsing, so all this needs from the component is
   its structure and its palette. The folders fold on their own, which is a
   different thing and belongs to the Collapsible inside each group. */
import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  BlocksIcon, CheckCheckIcon, CheckIcon, ChevronRightIcon, CircleCheckIcon, EllipsisIcon, FolderIcon, FolderMinusIcon,
  FolderOpenIcon, FolderPlusIcon, GaugeIcon, PlusIcon, RotateCcwIcon, SearchIcon, SquarePenIcon, Trash2Icon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { railBadge } from './chat-attention.js';
import { cn } from '@/lib/utils';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Empty, EmptyDescription, EmptyHeader } from '@/components/ui/empty';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
} from '@/components/ui/sidebar';
import { closeProject, openFolder } from '../../project.js';
import { shortPath, useProject } from '../useProject.js';
import {
  activeKey, canMarkDone, doneOpen, getRailVersion, grouped, isDone, isSaved, markAllDone, markDone,
  projectOpen, refreshRail, relative, setDoneOpen, setProjectOpen, subscribeRail,
} from './rail-store';
import { toast } from './toast';

/* The box is a contenteditable, not the textarea this used to reach for, so
   focusing it was quietly doing nothing. A new chat you have to click into is
   half a new chat. The frame is for the chat to be on screen first. */
const focusComposer = () =>
  requestAnimationFrame(() => document.querySelector('#agent-root [contenteditable="true"]')?.focus());

/* Starting a chat in a folder by name rather than in whichever one the window
   is looking at. The folder is unfolded on the way: a chat whose row lands in a
   shut group is a chat that looks like it was never made. */
function startChatIn(dir) {
  if (!dir) return;
  setProjectOpen(dir, true);
  window.tandemChat?.newChat(dir);
  focusComposer();
}

function useRail() {
  useSyncExternalStore(subscribeRail, getRailVersion, getRailVersion);
  // The store owns which folders are open and what is in them, including the
  // fold state, which has to survive a restart.
  useEffect(() => { refreshRail(); }, []);
}

// Chats hang off their folder by the indent alone.
const SUB = 'mx-0 ml-4 border-l-0 px-0 pr-0';

function Row({ chat, current, onDelete }) {
  const done = isDone(chat);
  const saved = isSaved(chat);
  const badge = railBadge(chat);
  const marked = !!(chat.busy || chat.waiting);

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={current}
        title={chat.title}
        className="group-has-data-[sidebar=menu-action]/menu-item:pr-2"
        onClick={() => window.tandemChat?.open(chat)}>
        {/* A dot rather than an icon per row: forty speech bubbles down the
            rail are forty of the same picture. A finished chat keeps its tick. */}
        {done ? (
          <CircleCheckIcon className="size-3.5! text-muted-foreground" />
        ) : (
          <span
            aria-hidden
            className={cn('mx-1 size-1.5 shrink-0 rounded-full', current ? 'bg-sidebar-foreground' : 'bg-sidebar-foreground/30')} />
        )}
        <span className="truncate">{chat.title}</span>
        {badge && (
          <Badge
            variant="secondary"
            className={cn(
              'ml-auto shrink-0 px-1.5 py-0 text-[10px]',
              badge.tone === 'wait' && 'bg-amber-500/15 text-amber-700 dark:text-amber-500',
            )}>
            {badge.label}
          </Badge>
        )}
        <span className={`shrink-0 text-[11px] text-muted-foreground ${marked ? '' : 'ml-auto'}`}>
          {relative(chat.at)}
        </span>
      </SidebarMenuButton>

      {/* The row is a button, so this one stops the click on its way up rather
          than opening the chat it is about to delete. */}
      {/* The icons sit over the end of the row rather than in a gutter cut out
          of it. A gutter is there on every row all the time, and it costs the
          title characters it needs more than the hover needs the space. This
          fades the row out under them instead, from the same colour the row is
          wearing while you are on it, so the title runs out rather than being
          chopped. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0.5 right-0 w-28 rounded-r-md bg-gradient-to-l from-sidebar-accent from-40% to-transparent opacity-0 transition-opacity group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100" />

      {/* Two icons rather than one menu. Both are one click and both are worth
          one: putting a chat away is the thing you do most, and burying it a
          menu deep is what stops people doing it. They stop the click on its
          way up, or the row underneath opens the chat they are about to act
          on. A chat that has never been written to disk has no id to mark, so
          the tick is not offered on one. */}
      {saved && (
        <SidebarMenuAction
          showOnHover
          className="right-8 hover:text-[hsl(var(--success))]"
          title={done ? 'Move back to the list' : 'Mark completed'}
          aria-label={`${done ? 'Move back' : 'Mark completed'}: ${chat.title}`}
          onClick={(e) => { e.stopPropagation(); markDone(chat, !done); }}>
          {done ? <RotateCcwIcon /> : <CheckIcon />}
        </SidebarMenuAction>
      )}
      <SidebarMenuAction
        showOnHover
        className="hover:text-destructive"
        title="Delete chat"
        aria-label={`Delete ${chat.title}`}
        onClick={(e) => { e.stopPropagation(); onDelete(chat); }}>
        <Trash2Icon />
      </SidebarMenuAction>
    </SidebarMenuItem>
  );
}

/* The chats in a folder that have been marked done.

   Shut by default and counted on its own line, so a folder with two live chats
   and forty finished ones reads as two. It is a fold rather than a separate
   place: the chats are still that folder's, still open with one click, and
   still resumable. Nothing was archived and nothing moved on disk.

   It sits under the folder's own heading and above its live chats. The bottom
   of the list is where this belongs by rank, and it is also where you would
   never find it: a folder with ninety chats puts it ninety rows down. One quiet
   line at the top costs the live chats nothing and can always be reached.

   A folder with nothing put away draws no line at all. An empty "Completed 0"
   under every folder would be the same clutter this exists to remove. */
function Completed({ folder, active, onDelete }) {
  if (!folder.done.length) return null;

  return (
    <Collapsible
      className="group/done mt-0.5"
      open={doneOpen(folder.dir)}
      onOpenChange={(open) => setDoneOpen(folder.dir, open)}>
      <CollapsibleTrigger
        className="ml-4 flex w-[calc(100%-1rem)] cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-muted-foreground text-xs transition-colors hover:text-sidebar-foreground">
        <ChevronRightIcon
          className="size-3.5 shrink-0 transition-transform group-data-[state=open]/done:rotate-90" />
        <span>Completed</span>
        <span className="ml-auto tabular-nums">{folder.done.length}</span>
      </CollapsibleTrigger>

      <CollapsibleContent>
        <SidebarMenuSub className={SUB}>
          {folder.done.map((chat) => (
            <Row
              key={chat.key || chat.id}
              chat={chat}
              current={!!chat.key && chat.key === active}
              onDelete={onDelete} />
          ))}
        </SidebarMenuSub>
      </CollapsibleContent>
    </Collapsible>
  );
}

/* One project and its chats. The Collapsible wraps the whole group, so the
   folder's row folds the chats under it and nothing else, and the trigger is
   the row itself rather than a chevron you have to aim at.

   The folder reads as a row with a folder in front of it, and its chats hang
   off it indented, each behind a dot. No rules between folders and no heading
   type: the indent and the folder icon are what say where one ends.

   The rows stay SidebarMenuItem rather than SidebarMenuSubItem. The row
   actions read their hover and active state off the menu-item group and the
   menu-button peer, and the sub variants carry neither. */
function Folder({ folder, active, current, onDelete, onRemove }) {
  const open = projectOpen(folder.dir);
  const count = folder.rows.length + folder.done.length;
  const finishable = folder.rows.filter(canMarkDone);

  // No confirm: every chat it moves is one click from coming back.
  const markAll = async () => {
    const failed = await markAllDone(finishable);
    if (failed) toast(`Could not mark ${failed} of those chats completed`, 'They are still in the list.', [{ label: 'OK' }]);
  };

  return (
    <Collapsible
      className="group/folder"
      open={open}
      onOpenChange={(next) => setProjectOpen(folder.dir, next)}>
      <SidebarGroup className="gap-0 p-0">
        {/* A row like the chats under it, only with a folder in front. The
            heading stays put while its chats scroll under it, so a folder with
            ninety chats does not scroll its own name away. The rail's colour is
            a tint over the window, so the row is the window's colour and the
            ::before lays the tint back over it: opaque, and the same colour as
            the rail around it. */}
        <div
          className="group/head sticky top-0 z-10 flex h-8 items-center gap-1 rounded-md bg-background pr-1 pl-2
            before:absolute before:inset-0 before:-z-10 before:rounded-md before:bg-sidebar before:transition-colors hover:before:bg-sidebar-accent">
          <CollapsibleTrigger
            title={folder.dir}
            className={cn(
              'flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 text-sm [&>svg]:size-4 [&>svg]:shrink-0',
              current ? 'text-sidebar-foreground' : 'text-sidebar-foreground/80',
            )}>
            {open ? <FolderOpenIcon /> : <FolderIcon />}
            <span className="truncate">{folder.name}</span>
          </CollapsibleTrigger>

          {/* The newest chat's age, where the actions go on hover. Both share
              the same corner, so neither costs the name any width. */}
          {!!folder.at && (
            <span className="pointer-events-none absolute right-2 text-[11px] text-muted-foreground tabular-nums transition-opacity group-hover/head:opacity-0 group-has-[[aria-haspopup=menu][aria-expanded=true]]/head:opacity-0">
              {relative(folder.at)}
            </span>
          )}

          <div className="flex items-center opacity-0 transition-opacity group-hover/head:opacity-100 focus-within:opacity-100 has-[[aria-haspopup=menu][aria-expanded=true]]:opacity-100">
            {/* A chat in this folder, started from the folder. It sits beside
                the name rather than inside it: the name is the fold's trigger,
                and a button inside a button is neither valid nor clickable. The
                window stays where it is, because asking for a chat in another
                folder is not asking to be moved to it. */}
            <button
              type="button"
              title={`New chat in ${folder.name}`}
              aria-label={`New chat in ${folder.name}`}
              className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-foreground/60 transition-colors hover:bg-sidebar hover:text-sidebar-foreground"
              onClick={() => startChatIn(folder.dir)}>
              <PlusIcon className="size-3.5" />
            </button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  title={`More for ${folder.name}`}
                  aria-label={`More for ${folder.name}`}
                  className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-foreground/60 transition-colors hover:bg-sidebar hover:text-sidebar-foreground">
                  <EllipsisIcon className="size-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => startChatIn(folder.dir)}>
                  <PlusIcon />
                  New chat here
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!finishable.length} onSelect={markAll}>
                  <CheckCheckIcon />
                  Mark all completed
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => onRemove(folder)}>
                  <FolderMinusIcon />
                  Remove from this window
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <CollapsibleContent>
          <SidebarGroupContent className="pb-1">
            {/* A folder you have just opened has no chats yet, and the guide
                line down the left of an empty list is a stub hanging off
                nothing. Say what is there instead. */}
            <Completed folder={folder} active={active} onDelete={onDelete} />

            {!folder.rows.length && !folder.done.length ? (
              /* Sitting where the rows would, so the note reads as the folder's
                 contents rather than as something loose under the heading. */
              <p className="ml-4 px-2 py-1 text-muted-foreground text-xs">No chats yet</p>
            ) : (
              <SidebarMenuSub className={SUB}>
                {folder.rows.map((chat) => (
                  <Row
                    key={chat.key || chat.id}
                    chat={chat}
                    current={!!chat.key && chat.key === active}
                    onDelete={onDelete} />
                ))}
              </SidebarMenuSub>
            )}
          </SidebarGroupContent>
        </CollapsibleContent>
      </SidebarGroup>
    </Collapsible>
  );
}

/* Starting a chat, and saying where.

   New chat used to mean "here", and here was whichever folder the window
   happened to be looking at. That is fine until the two come apart, which they
   do the moment you read a chat from another project, and then the chat you
   started lands somewhere you were not looking with nothing to say it had. The
   folder is the question, so the button asks it.

   Three ways to answer, in the order they are worth offering: a folder this
   window already holds, one you had open recently, or one you go and find. The
   last two have to be opened before a chat can run in them, which is why they
   go the long way round. */
function NewChatDialog({ open, onOpenChange }) {
  const window_ = useProject();
  const here = new Set((window_.projects || []).map((p) => p.dir));
  const recents = (window_.recents || []).filter((r) => !here.has(r.path)).slice(0, 8);

  /* Picking a folder here is choosing where to work, not only where to file the
     chat, so the window goes with it and the terminal, the files and the preview
     are the ones the chat is about to talk about. The plus on a folder heading
     is the other half of this: that one starts a chat over there and leaves you
     where you are. Opening a folder focuses it in main already. */
  const start = (dir) => {
    onOpenChange(false);
    window.tandem.project.focus(dir);
    startChatIn(dir);
  };

  // Main answers with the folder it landed on, which is not always the one that
  // was asked for: a folder already open under another path is raised rather
  // than opened twice, and the picker can be dismissed.
  const openThenStart = async (dir) => {
    onOpenChange(false);
    const res = await openFolder(dir ? { dir } : {});
    if (!res || res.error || res.canceled) return;
    startChatIn(res.focused || res.dir || dir);
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="New chat"
      description="Pick the folder the chat runs in.">
      <CommandInput placeholder="Search folders" />
      <CommandList>
        <CommandEmpty>No folder by that name.</CommandEmpty>

        {!!window_.projects?.length && (
          <CommandGroup heading="Open in this window">
            {window_.projects.map((p) => (
              <CommandItem key={p.dir} value={`${p.name} ${p.dir}`} onSelect={() => start(p.dir)}>
                <FolderIcon />
                <span className="truncate">{p.name}</span>
                {/* Left to right. The composer's copy of this list runs the
                    paths rtl to keep the tail of a long one, which reads a
                    short path back to front: ~/projects/x comes out as
                    projects/x/~. There is room for the whole thing here. */}
                <span className="ml-auto truncate text-muted-foreground text-xs">
                  {shortPath(p.dir, window_.home)}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {!!recents.length && (
          <CommandGroup heading="Recent">
            {recents.map((r) => (
              <CommandItem key={r.path} value={`${r.name} ${r.path}`} onSelect={() => openThenStart(r.path)}>
                <FolderIcon />
                <span className="truncate">{r.name}</span>
                <span className="ml-auto truncate text-muted-foreground text-xs">
                  {shortPath(r.path, window_.home)}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        <CommandGroup heading="Elsewhere">
          <CommandItem value="find browse folder machine" onSelect={() => openThenStart(null)}>
            <FolderPlusIcon />
            <span>Find a folder on this machine…</span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

/* Taking a folder out of this window. Nothing on disk is touched: the folder,
   its files and its transcripts are all still there, and opening it again picks
   up where this left off. What does go is everything this window was running
   for it, which is the part worth asking about, and it is why this is a
   question rather than a click.

   The last folder cannot go. Main says so and the toast in project.js says it
   back, so this does not have to guess which one is last. */
function ConfirmRemove({ folder, onCancel, onConfirm }) {
  const [working, setWorking] = useState(false);

  return (
    <Dialog open={!!folder} onOpenChange={(next) => { if (!next && !working) onCancel(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Remove this folder from the window?</DialogTitle>
          <DialogDescription>
            Its chats stop, its terminals close and its file watches go. Nothing is deleted:
            the folder stays on disk with its transcripts, and opening it again brings them back.
          </DialogDescription>
        </DialogHeader>

        <p className="truncate rounded-md bg-muted px-3 py-2 text-sm">{folder?.dir}</p>

        <DialogFooter>
          <Button variant="ghost" disabled={working} onClick={onCancel}>Cancel</Button>
          <Button
            variant="destructive"
            disabled={working}
            onClick={async () => { setWorking(true); await onConfirm(folder); setWorking(false); }}>
            Remove
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* The confirm. A transcript is the only copy of a conversation and this unlinks
   it, so the question gets asked, and it names the chat: the rail is a list of
   near-identical rows and the wrong one is easy to hit. */
function ConfirmDelete({ chat, onCancel, onConfirm }) {
  const [working, setWorking] = useState(false);

  return (
    <Dialog open={!!chat} onOpenChange={(next) => { if (!next && !working) onCancel(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete this chat?</DialogTitle>
          <DialogDescription>
            {chat?.busy
              ? 'This chat is mid-turn. Deleting stops it and removes its transcript for good.'
              : 'Its transcript goes with it, here and from claude --resume. This cannot be undone.'}
          </DialogDescription>
        </DialogHeader>

        <p className="truncate rounded-md bg-muted px-3 py-2 text-sm">{chat?.title}</p>

        <DialogFooter>
          <Button variant="ghost" disabled={working} onClick={onCancel}>Cancel</Button>
          <Button
            variant="destructive"
            disabled={working}
            onClick={async () => { setWorking(true); await onConfirm(chat); setWorking(false); }}>
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function Rail() {
  useRail();
  const [doomed, setDoomed] = useState(null);
  const [leaving, setLeaving] = useState(null);
  const [starting, setStarting] = useState(false);
  const folders = grouped();
  const active = activeKey();
  /* The folder holding the chat you are in. Its heading brightens, which is the
     one thing the rail was not saying: with three folders open and a chat from
     each on screen at some point, the row's own marker tells you which chat and
     nothing tells you whose. */
  const currentDir = folders.find((f) => [...f.rows, ...f.done].some((c) => c.key && c.key === active))?.dir;

  const remove = async (chat) => {
    const res = await window.tandemChat?.remove(chat);
    setDoomed(null);
    // Deleting is one click and a confirm; failing at it silently would leave
    // the row sitting there looking like nothing happened.
    if (res?.error) toast('Could not delete that chat', res.error, [{ label: 'OK' }]);
  };

  // project.js toasts the reason on its own, the last-folder one included.
  const removeFolder = async (folder) => {
    await closeProject(folder.dir);
    setLeaving(null);
  };

  return (
    <Sidebar collapsible="none" className="h-full w-full border-r">
      <SidebarHeader className="gap-0 pb-0">
        {/* Where you start from, as rows rather than buttons. */}
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton title="Start a chat" onClick={() => setStarting(true)}>
              <SquarePenIcon />
              <span>New chat</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            {/* The palette, which finds chats, folders, files and commands in
                one list. It used to sit in the title bar as a search field. */}
            <SidebarMenuButton title="Search chats, folders, files and commands (Ctrl+K)" onClick={() => window.tandemPalette?.open()}>
              <SearchIcon />
              <span>Search</span>
              <span className="ml-auto text-[10px] text-muted-foreground/70">Ctrl K</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            {/* Skills, agents and MCP servers for this folder, and the app's
                settings, on a page in the chat's place. */}
            <SidebarMenuButton title="Skills, MCP servers and settings" onClick={() => window.tandemChat?.customize()}>
              <BlocksIcon />
              <span>Customize</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton title="Tokens, cost and plan limits for every chat and agent" onClick={() => window.tandemChat?.usage()}>
              <GaugeIcon />
              <span>Usage</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup className="gap-0.5">
          {/* The rail is the list of folders, so the way to add one belongs at
              the top of it. The picker is main's, so a folder already open here
              is brought forward instead of opened twice. */}
          <SidebarGroupLabel>Projects</SidebarGroupLabel>
          <SidebarGroupAction title="Open another folder in this window" onClick={() => openFolder()}>
            <PlusIcon />
          </SidebarGroupAction>

          {folders.length === 0 ? (
            <Empty className="px-4">
              <EmptyHeader>
                <EmptyDescription>No chats in this folder yet. Ask for something and it lands here.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            folders.map((folder) => (
              <Folder
                key={folder.dir}
                folder={folder}
                active={active}
                current={folder.dir === currentDir}
                onDelete={setDoomed}
                onRemove={setLeaving} />
            ))
          )}
        </SidebarGroup>
      </SidebarContent>

      <NewChatDialog open={starting} onOpenChange={setStarting} />
      <ConfirmRemove folder={leaving} onCancel={() => setLeaving(null)} onConfirm={removeFolder} />
      <ConfirmDelete chat={doomed} onCancel={() => setDoomed(null)} onConfirm={remove} />
    </Sidebar>
  );
}
