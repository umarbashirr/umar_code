/* The chat rail. One section per open project, each holding that folder's
   chats, newest first. The folder you worked in last sits on top.

   The shadcn Sidebar runs with collapsible="none": the resizable panel around
   it owns the width and the collapsing, so all this needs from the component is
   its structure and its palette. The folders fold on their own, which is a
   different thing and belongs to the Collapsible inside each group. */
import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  ChevronRightIcon, FolderIcon, MessageSquareDotIcon, MessageSquareIcon, SearchIcon,
  SquarePenIcon, Trash2Icon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Empty, EmptyDescription, EmptyHeader } from '@/components/ui/empty';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
} from '@/components/ui/sidebar';
import { onProject, project, shortPath } from '../../project.js';
import {
  activeKey, getRailVersion, grouped, projectOpen, refreshRail, relative, setProjectOpen,
  subscribeRail,
} from './rail-store';
import { toast } from './toast';

function useRail() {
  useSyncExternalStore(subscribeRail, getRailVersion, getRailVersion);
  // The store owns which folders are open and what is in them, including the
  // fold state, which has to survive a restart.
  useEffect(() => { refreshRail(); }, []);
}

function useProjectDir() {
  const [, bump] = useState(0);
  useEffect(() => onProject(() => bump((n) => n + 1)), []);
  return project.dir;
}

function Row({ chat, current, onDelete }) {
  const Icon = current ? MessageSquareDotIcon : MessageSquareIcon;

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
      <SidebarMenuAction
        showOnHover
        title="Delete chat"
        aria-label={`Delete ${chat.title}`}
        className="hover:text-destructive"
        onClick={(e) => { e.stopPropagation(); onDelete(chat); }}>
        <Trash2Icon />
      </SidebarMenuAction>
    </SidebarMenuItem>
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
function Folder({ folder, active, onDelete }) {
  return (
    <Collapsible
      className="group/folder"
      open={projectOpen(folder.dir)}
      onOpenChange={(open) => setProjectOpen(folder.dir, open)}>
      <SidebarGroup>
        {/* The heading styling rides on the label rather than on the trigger.
            The label merges a className through twMerge, so text-[11px] beats
            its text-xs; anything set on the trigger only gets concatenated and
            would leave the stylesheet to break the tie. */}
        <SidebarGroupLabel
          asChild
          className="text-[11px] font-semibold uppercase tracking-wide [&>svg]:size-3.5">
          <CollapsibleTrigger
            title={folder.dir}
            className="w-full cursor-pointer gap-1.5 transition-colors hover:text-sidebar-foreground">
            {/* The chevron leads, sitting a pixel off the guide line that starts
                below it, so the fold and the chats it holds share one edge. */}
            <ChevronRightIcon
              className="transition-transform group-data-[state=open]/folder:rotate-90" />
            <span className="truncate">{folder.name}</span>
          </CollapsibleTrigger>
        </SidebarGroupLabel>

        <CollapsibleContent>
          <SidebarGroupContent>
            {/* A folder you have just opened has no chats yet, and the guide
                line down the left of an empty list is a stub hanging off
                nothing. Say what is there instead. */}
            {!folder.rows.length ? (
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
  const dir = useProjectDir();
  const [filter, setFilter] = useState('');
  const [doomed, setDoomed] = useState(null);
  const folders = grouped(filter);
  const active = activeKey();

  const remove = async (chat) => {
    const res = await window.tandemChat?.remove(chat);
    setDoomed(null);
    // Deleting is one click and a confirm; failing at it silently would leave
    // the row sitting there looking like nothing happened.
    if (res?.error) toast('Could not delete that chat', res.error, [{ label: 'OK' }]);
  };

  return (
    <Sidebar collapsible="none" className="h-full w-full border-r">
      <SidebarHeader className="gap-2">
        <Button
          variant="outline"
          className="justify-start"
          onClick={() => {
            window.tandemChat?.newChat();
            document.querySelector('#agent-root textarea')?.focus();
          }}>
          <SquarePenIcon />
          New chat
        </Button>

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
          folders.map((folder) => (
            <Folder key={folder.dir} folder={folder} active={active} onDelete={setDoomed} />
          ))
        )}
      </SidebarContent>

      <SidebarFooter>
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" title={dir}>
          <FolderIcon className="size-3.5 shrink-0" />
          <span dir="rtl" className="truncate font-mono [unicode-bidi:plaintext]">{shortPath(dir)}</span>
        </div>
      </SidebarFooter>

      <ConfirmDelete chat={doomed} onCancel={() => setDoomed(null)} onConfirm={remove} />
    </Sidebar>
  );
}
