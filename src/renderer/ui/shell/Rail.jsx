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
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
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
    <SidebarMenuItem>
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
   header itself rather than a chevron you have to aim at. */
function Folder({ folder, active, onDelete }) {
  return (
    <Collapsible
      className="group/folder"
      open={projectOpen(folder.dir)}
      onOpenChange={(open) => setProjectOpen(folder.dir, open)}>
      <SidebarGroup>
        <SidebarGroupLabel asChild>
          <CollapsibleTrigger
            title={folder.dir}
            className="w-full gap-2 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground">
            <FolderIcon />
            <span className="truncate">{folder.name}</span>
            <ChevronRightIcon
              className="ml-auto transition-transform group-data-[state=open]/folder:rotate-90" />
          </CollapsibleTrigger>
        </SidebarGroupLabel>

        <CollapsibleContent>
          <SidebarGroupContent>
            <SidebarMenu>
              {folder.rows.map((chat) => (
                <Row
                  key={chat.key || chat.id}
                  chat={chat}
                  current={!!chat.key && chat.key === active}
                  onDelete={onDelete} />
              ))}
            </SidebarMenu>
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
