/* The chat rail. A list of every chat in this folder, newest first, grouped by
   the day it was last touched.

   The shadcn Sidebar runs with collapsible="none": the resizable panel around
   it owns the width and the collapsing, so all this needs from the component is
   its structure and its palette. */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { FolderIcon, MessageSquareDotIcon, MessageSquareIcon, SearchIcon, SquarePenIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { onProject, project, shortPath } from '../../project.js';
import { activeKey, getRailVersion, grouped, refreshRail, relative, subscribeRail } from './rail-store';

function useRail() {
  useSyncExternalStore(subscribeRail, getRailVersion, getRailVersion);
  // The folder label and the empty state live in project.js; this list only
  // cares about which chats belong to whatever folder is open.
  useEffect(() => { refreshRail(); }, []);
}

function useProjectDir() {
  const [, bump] = useState(0);
  useEffect(() => onProject(() => bump((n) => n + 1)), []);
  return project.dir;
}

function Row({ chat, current }) {
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
    </SidebarMenuItem>
  );
}

export default function Rail() {
  useRail();
  const dir = useProjectDir();
  const [filter, setFilter] = useState('');
  const groups = grouped(filter);
  const active = activeKey();

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
        {groups.length === 0 ? (
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
          groups.map((group) => (
            <SidebarGroup key={group.label}>
              <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.rows.map((chat) => (
                    <Row key={chat.key || chat.id} chat={chat} current={!!chat.key && chat.key === active} />
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))
        )}
      </SidebarContent>

      <SidebarFooter>
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" title={dir}>
          <FolderIcon className="size-3.5 shrink-0" />
          <span dir="rtl" className="truncate font-mono [unicode-bidi:plaintext]">{shortPath(dir)}</span>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
