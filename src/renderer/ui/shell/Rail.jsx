/* The chat rail. One section per open project, each holding that folder's
   chats, newest first. The folder you worked in last sits on top.

   The shadcn Sidebar runs with collapsible="none": the resizable panel around
   it owns the width and the collapsing, so all this needs from the component is
   its structure and its palette. The folders fold on their own, which is a
   different thing and belongs to the Collapsible inside each group. */
import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  CheckIcon, ChevronRightIcon, CircleCheckIcon, EllipsisIcon, FolderIcon, FolderMinusIcon,
  FolderPlusIcon, MessageSquareDotIcon, MessageSquareIcon, PlusIcon, RotateCcwIcon,
  SearchIcon, SquarePenIcon, Trash2Icon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
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
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
} from '@/components/ui/sidebar';
import { closeProject, openFolder } from '../../project.js';
import { shortPath, useProject } from '../useProject.js';
import {
  activeKey, doneOpen, getRailVersion, grouped, isDone, markDone, projectOpen, refreshRail,
  relative, setDoneOpen, setProjectOpen, subscribeRail,
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

function Row({ chat, current, onDelete }) {
  const done = isDone(chat);
  // A live chat claude has not written yet is named by our own key, and there
  // is no session id to write down against it.
  const saved = !!chat.id && chat.id !== chat.key;
  const Icon = done ? CircleCheckIcon : current ? MessageSquareDotIcon : MessageSquareIcon;

  return (
    /* The chat you are in thickens the guide line beside it. The row already
       takes the accent tint, but that tint stops at the row's own edge, and the
       thing worth seeing from across the rail is which folder you are working
       in. The marker sits on the border SidebarMenuSub draws, 11px left of the
       row: 1px of border, then the list's 10px of padding. */
    <SidebarMenuItem
      className={current
        ? 'before:absolute before:-left-[11px] before:top-1.5 before:bottom-1.5 before:w-0.5 before:rounded-full before:bg-sidebar-foreground/50'
        : undefined}>
      <SidebarMenuButton
        isActive={current}
        title={chat.title}
        className="group-has-data-[sidebar=menu-action]/menu-item:pr-2"
        onClick={() => { if (!current) window.tandemChat?.open(chat); }}>
        <Icon />
        <span className="truncate">{chat.title}</span>
        {chat.busy && (
          <Badge variant="secondary" className="ml-auto shrink-0 px-1.5 py-0 text-[10px]">
            {chat.agents ? `${chat.agents} agents` : 'working'}
          </Badge>
        )}
        <span className={`shrink-0 text-[11px] text-muted-foreground${chat.busy ? '' : ' ml-auto'}`}>
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
        className="mx-3.5 flex w-[calc(100%-1.75rem)] cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-muted-foreground text-xs transition-colors hover:text-sidebar-foreground">
        <ChevronRightIcon
          className="size-3.5 shrink-0 transition-transform group-data-[state=open]/done:rotate-90" />
        <span>Completed</span>
        <span className="ml-auto tabular-nums">{folder.done.length}</span>
      </CollapsibleTrigger>

      <CollapsibleContent>
        <SidebarMenuSub className="mr-0 pr-0">
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
   header folds the rows under it and nothing else, and the trigger is the
   header itself rather than a chevron you have to aim at.

   The header and the rows have to read as two levels, not as one list of
   lookalikes. The header takes the heading language the app already uses for
   section labels, small uppercase and tracked, and it gives up the accent fill
   on hover: that fill is what marks the chat you are in, and a heading should
   never wear it. The chats sit on a SidebarMenuSub, which indents them and runs
   a border down their left edge, so a row visibly hangs off the folder above.

   The rows stay SidebarMenuItem rather than SidebarMenuSubItem. The delete
   action reads its hover and active state off the menu-item group and the
   menu-button peer, and the sub variants carry neither. */
function Folder({ folder, active, current, first, onDelete, onRemove }) {
  const open = projectOpen(folder.dir);
  const count = folder.rows.length + folder.done.length;

  return (
    <Collapsible
      className="group/folder"
      open={open}
      onOpenChange={(next) => setProjectOpen(folder.dir, next)}>
      {/* One folder, one band. The rule along the top is what separates them:
          three headings and their chats used to run together down the rail as
          one column of text, and the only thing saying where one folder ended
          was the gap before the next. The first needs no rule, since the search
          box above it already draws one. */}
      <SidebarGroup className={`gap-0 px-0 py-1${first ? '' : ' border-t border-sidebar-border'}`}>
        {/* The heading stays put while its chats scroll under it. A folder with
            ninety chats otherwise scrolls its own name away, and then the rail
            is a list of titles with nothing saying whose they are. It needs the
            sidebar's own background to stay opaque over the rows going past. */}
        {/* The rail's own colour is 55% alpha over the window, so a heading
            wearing it lets the rows scroll through it and read as double
            exposure. The ::before is the opaque layer that colour is meant to
            sit on, put back under this one row: background first, sidebar tint
            over it, text on top. */}
        <div
          className={`sticky top-0 z-10 flex items-center gap-1 bg-sidebar px-2 py-0.5
            before:absolute before:inset-0 before:-z-10 before:bg-background${current
            ? ' text-sidebar-foreground after:absolute after:top-1.5 after:bottom-1.5 after:left-0 after:w-0.5 after:rounded-full after:bg-sidebar-foreground/60'
            : ''}`}>
          {/* The heading styling rides on the label rather than on the trigger.
              The label merges a className through twMerge, so text-[11px] beats
              its text-xs; anything set on the trigger only gets concatenated and
              would leave the stylesheet to break the tie. */}
          <SidebarGroupLabel
            asChild
            className={`h-7 min-w-0 flex-1 px-1.5 text-[11px] font-semibold uppercase tracking-wide [&>svg]:size-3.5${current ? ' text-sidebar-foreground' : ''}`}>
            <CollapsibleTrigger
              title={folder.dir}
              className="cursor-pointer gap-1.5 transition-colors hover:text-sidebar-foreground">
              {/* The chevron leads, sitting a pixel off the guide line that starts
                  below it, so the fold and the chats it holds share one edge. */}
              {/* The size goes on the icon. The label carries an [&>svg] rule
                  for it, but the chevron is the trigger's child rather than the
                  label's, so nothing was catching it and it drew at lucide's
                  own 24px, twice the height of the word beside it. */}
              <ChevronRightIcon
                className="size-3.5 shrink-0 transition-transform group-data-[state=open]/folder:rotate-90" />
              <span className="truncate">{folder.name}</span>

              {/* What a shut folder is holding. Open, the chats say it
                  themselves and a number beside them is noise. Left out of the
                  tree rather than faded out: a hidden span still takes its
                  width, and it was taking it off the folder's name. */}
              {!open && !!count && (
                <span className="ml-auto pl-1 font-normal tabular-nums opacity-50">{count}</span>
              )}
            </CollapsibleTrigger>
          </SidebarGroupLabel>

          {/* A chat in this folder, started from the folder. It sits beside the
              heading rather than inside it: the heading is the fold's trigger,
              and a button inside a button is neither valid nor clickable. The
              window stays where it is, because asking for a chat in another
              folder is not asking to be moved to it, and the chip under the box
              says which folder you are about to type into. */}
          <button
            type="button"
            title={`New chat in ${folder.name}`}
            aria-label={`New chat in ${folder.name}`}
            className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-foreground/50 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
            onClick={() => startChatIn(folder.dir)}>
            <PlusIcon className="size-3.5" />
          </button>

          {/* The rest of what can be done to a folder. It was on hover at
              first, which left the plus sitting a button's width in from the
              edge with a hole beside it: a control that is invisible still
              takes its place in the row. Both are here all the time now, quiet
              until you are on them. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                title={`More for ${folder.name}`}
                aria-label={`More for ${folder.name}`}
                className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-foreground/50 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-foreground">
                <EllipsisIcon className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => startChatIn(folder.dir)}>
                <PlusIcon />
                New chat here
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => onRemove(folder)}>
                <FolderMinusIcon />
                Remove from this window
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <CollapsibleContent>
          {/* The group gave up its padding to let the rule above run the full
              width of the rail, so the rows carry their own inset now. */}
          <SidebarGroupContent className="px-2 pb-1">
            {/* A folder you have just opened has no chats yet, and the guide
                line down the left of an empty list is a stub hanging off
                nothing. Say what is there instead. */}
            <Completed folder={folder} active={active} onDelete={onDelete} />

            {!folder.rows.length && !folder.done.length ? (
              /* Sitting where the rows would, so the note reads as the folder's
                 contents rather than as something loose under the heading. */
              <p className="mx-3.5 px-2.5 py-1 text-muted-foreground text-xs">No chats here yet</p>
            ) : (
              /* The list keeps its left margin, which is where the border lives,
                 and drops the right one. The rail is narrow and the rows carry a
                 badge, a timestamp and a delete button on that edge. */
              <SidebarMenuSub className="mr-0 pr-0">
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
  const [filter, setFilter] = useState('');
  const [doomed, setDoomed] = useState(null);
  const [leaving, setLeaving] = useState(null);
  const [starting, setStarting] = useState(false);
  const folders = grouped(filter);
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
      <SidebarHeader className="gap-2">
        {/* Two starts, side by side. Stacked they took two full rows off the
            top of the rail to say two short things, and the second one is the
            rarer of the two by a distance. Joined, they read as one control
            with two ways in.

            The second adds a folder to this window, which is a different thing
            from opening one in a new window. The rail is the list of folders,
            so the way to add one belongs at the top of it rather than only in a
            menu. The picker is main's, so a folder already open here is brought
            forward instead of opened twice. */}
        <ButtonGroup className="@container/starts w-full">
          <Button
            variant="outline"
            className="flex-1 justify-center"
            title="Start a chat"
            onClick={() => setStarting(true)}>
            <SquarePenIcon />
            {/* Narrow the rail and the words go, not the row. Two labels that
                no longer fit wrap to a second line each and turn a one-row
                control into four, and a rail dragged that thin was dragged thin
                to give the room to the chat. The icons carry it from there, and
                the title says the rest. The measure is this group's own width
                rather than the window's, so it holds wherever the rail is
                parked. */}
            <span className="@max-[220px]/starts:hidden">New chat</span>
          </Button>
          <Button
            variant="outline"
            className="flex-1 justify-center"
            title="Open another folder in this window"
            onClick={() => openFolder()}>
            <FolderPlusIcon />
            <span className="@max-[220px]/starts:hidden">New project</span>
          </Button>
        </ButtonGroup>

        <InputGroup>
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            spellCheck={false}
            placeholder="Search chats"
            value={filter}
            onChange={(e) => setFilter(e.target.value)} />
        </InputGroup>
      </SidebarHeader>

      <SidebarContent>
        {folders.length === 0 ? (
          <Empty className="px-4">
            <EmptyHeader>
              <EmptyDescription>
                {filter
                  ? 'Nothing matches that.'
                  : 'No chats in this folder yet. Ask for something and it lands here.'}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          folders.map((folder, i) => (
            <Folder
              key={folder.dir}
              folder={folder}
              active={active}
              current={folder.dir === currentDir}
              first={i === 0}
              onDelete={setDoomed}
              onRemove={setLeaving} />
          ))
        )}
      </SidebarContent>

      <NewChatDialog open={starting} onOpenChange={setStarting} />
      <ConfirmRemove folder={leaving} onCancel={() => setLeaving(null)} onConfirm={removeFolder} />
      <ConfirmDelete chat={doomed} onCancel={() => setDoomed(null)} onConfirm={remove} />
    </Sidebar>
  );
}
