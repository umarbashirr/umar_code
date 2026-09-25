/* The window's layout. Two nested resizable groups: the rail beside the
   content, and the chat beside the right column, which holds the previews,
   the terminals, the file tree and the diff as tabs.

   The splitters used to be 1px divs with a mousemove handler that wrote inline
   widths. react-resizable-panels owns them now.

   Every panel stays mounted whether or not it is on screen. Closing one
   collapses it to zero rather than unmounting it, which is what the preview
   needs anyway: a native view that stops laying out hands the agent a 0x0
   page. The splitters between panels stay mounted for the same reason: taking
   one out of the tree remounts its neighbours, and the terminals hang real
   xterm hosts under #terms that do not survive a remount.

   Sizes are the ones the old CSS carried. In this version of the library a bare
   number means pixels and a bare string means percent, so "18" is 18% of the
   window and "180px" is the floor the rail used to have. */
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { usePanelRef } from 'react-resizable-panels';
import { BotIcon, FolderTreeIcon, GitCompareIcon, GlobeIcon, PlusIcon, SquareTerminalIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SidebarProvider } from '@/components/ui/sidebar';
import { Toaster } from '@/components/ui/sonner';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import App from '../App';
import { focusShell, runCommand } from '../../app.js';
import { onProject, project } from '../../project.js';
import TitleBar from './TitleBar';
import AgentsView from './AgentsView';
import BrowserView from './BrowserView';
import ChangesView from './ChangesView';
import FilesView from './FilesView';
import Palette from './Palette';
import Rail from './Rail';
import StatusBar from './StatusBar';
import Welcome from './Welcome';
import { previewOf, subscribeBrowser, getBrowserVersion } from './browser-store';
import { getVersion, layout, relayoutNow, setLayout, subscribe } from './layout-store';
import { coverPane, uncoverPane } from './pane-cover';
import {
  activateTab,
  activeKind,
  activeTab,
  closeTab,
  getTabsVersion,
  KINDS,
  subscribeTabs,
  tabsOf,
} from './tabs-store';

export const useLayout = () => {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return layout;
};

// The folder with focus. There is one right column, so one folder at a time
// gets to draw its tabs.
export function useFocusedDir() {
  const [, bump] = useState(0);
  useEffect(() => onProject(() => bump((n) => n + 1)), []);
  return project.focused || project.dir;
}

/* A dropdown opening over the right column opens behind the preview, which is a
   native view the window paints on top of this document. Freezing the pane
   while the menu is up is the fix, and both menus in the window want it. */
export function usePaneCover(open) {
  useEffect(() => {
    if (!open) { uncoverPane(); return undefined; }
    const id = requestAnimationFrame(() => {
      const content = document.querySelector('[data-slot="dropdown-menu-content"]');
      coverPane(content?.getBoundingClientRect());
    });
    return () => cancelAnimationFrame(id);
  }, [open]);
}

// Collapsed before the first paint when it starts closed, so nothing flashes
// open on launch, and imperatively after that.
function useCollapse(ref, open) {
  useLayoutEffect(() => {
    if (open) ref.current?.expand();
    else ref.current?.collapse();
  }, [ref, open]);
}

// ----------------------------------------------------------------- the tabs

/* What the column can show, in one place. The tab and the toolbar button that
   opens it should be the same picture and the same word, so both read this.
   `command` is app.js's name for the opening, which is unchanged: the commands
   still do the work and this only says which one. `hint` names the shortcut,
   which only the toolbar has the room to say. */
export const VIEW_KINDS = {
  // `adds` is what the strip's plus runs when the kind can be opened more than
  // once. Only a preview can.
  browser: { icon: GlobeIcon, label: 'Browser', command: 'preview', adds: 'newPreview', hint: 'Preview browser (Ctrl+Shift+B)' },
  files: { icon: FolderTreeIcon, label: 'Files', command: 'files', hint: 'Project files (Ctrl+Shift+D)' },
  changes: { icon: GitCompareIcon, label: 'Changes', command: 'changes', hint: 'Uncommitted changes (Ctrl+Shift+G)' },
  terminal: { icon: SquareTerminalIcon, label: 'Terminal', command: 'terminal', adds: 'newTerminal', hint: 'Terminal (Ctrl+`)' },
  agents: { icon: BotIcon, label: 'Agents', command: 'agents', hint: "This chat's subagents" },
};

// A preview whose page has not said what it is yet, or has not loaded anything
// at all. Every browser calls that tab the same thing, so this one does too.
const labelOf = (tab) => {
  if (tab.kind === 'browser') return tab.title || 'New tab';
  if (tab.kind === 'terminal') return tab.title || 'Terminal';
  return VIEW_KINDS[tab.kind].label;
};

/* Starting one. Files, Changes and Agents may already be open in this folder,
   in which case the store hands back the one that is there, so every kind is
   offered every time rather than the menu guessing which are spent. */
function AddTab() {
  const [open, setOpen] = useState(false);
  usePaneCover(open);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-foreground"
            title="Open another tab">
          <PlusIcon />
        </Button>
      </DropdownMenuTrigger>
      {/* Focus goes to whatever the menu opened rather than back to the plus.
          The shell that just came up cannot take it for itself: the menu holds
          focus until it has finished closing, and this is that moment. */}
      <DropdownMenuContent align="start" onCloseAutoFocus={(e) => { e.preventDefault(); focusShell(); }}>
        {KINDS.map((kind) => {
          const { icon: Icon, label, command, adds } = VIEW_KINDS[kind];
          // The plus asks for another tab. For the tree and the diff there is
          // only ever the one, so it lands you on it; for a preview or a shell
          // it means another, which is what the toolbar button cannot ask for.
          return (
            <DropdownMenuItem key={kind} onSelect={() => runCommand(adds || command)}>
              <Icon />
              {label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* The strip along the top of the right column: a tab per preview, plus the file
   tree and the diff. It draws the row of the chat on screen in the focused
   folder, and switching chats or folders swaps it for that one's own.

   Clicking only moves the store. The pages behind the preview tabs are native
   views main holds, and app.js reconciles those against the store, so nothing
   here talks to main about them.

   The plus is the tallest thing in the row, so the strip stands the same height
   empty as full. That matters more than it looks: the preview's bounds are read
   off the DOM below this, and a row that grew when the first tab arrived would
   leave the page laid out for the wrong box. */
function TabStrip() {
  useSyncExternalStore(subscribeTabs, getTabsVersion, getTabsVersion);
  useSyncExternalStore(subscribeBrowser, getBrowserVersion, getBrowserVersion);
  const dir = useFocusedDir();
  const tabs = tabsOf(dir);
  const active = activeTab(dir);

  return (
    <Tabs
      value={active?.id || ''}
      onValueChange={(id) => activateTab(dir, id)}
      className="shrink-0 gap-0 border-b border-[var(--line)]">
      <TabsList
        variant="line"
        className="h-auto w-full justify-start! gap-1 overflow-x-auto rounded-none p-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((tab) => {
          const { icon: Icon } = VIEW_KINDS[tab.kind];
          const label = labelOf(tab);
          const favicon = tab.kind === 'browser' ? previewOf(tab.id).favicon : '';
          const faviconOk = favicon && !favicon.startsWith('data:,');
          return (
            <TabsTrigger key={tab.id} value={tab.id} title={label} className="group flex-none gap-1.5 text-xs">
              {faviconOk ? (
                <img src={favicon} alt="" className="size-3.5 shrink-0 rounded-sm object-contain" />
              ) : (
                <Icon className="size-3.5 shrink-0" />
              )}
              <span className="max-w-[22ch] truncate">{label}</span>
              {/* The same aim as the terminal strip: the cross is only on the
                  tab under the pointer or the one you are in, so a page you have
                  scrolled somewhere is not one stray click from gone. */}
              <span
                role="button"
                tabIndex={-1}
                aria-label={`Close ${label}`}
                className="-mr-1 rounded-sm opacity-0 transition-opacity group-hover:opacity-60 group-data-[state=active]:opacity-60 hover:!opacity-100 hover:text-destructive"
                onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); closeTab(dir, tab.id); }}>
                <XIcon className="size-3" />
              </span>
            </TabsTrigger>
          );
        })}

        <AddTab />

        {/* The column closes itself when the last tab goes, so an empty strip
            means a chat that has never had one open. Say so, rather than
            leaving a lone plus over a blank column. */}
        {!tabs.length && <span className="px-1 text-xs text-muted-foreground">Nothing open in this chat</span>}
      </TabsList>
    </Tabs>
  );
}

/* Where the shells draw. React leaves #terms empty: xterm renders into a host
   element per shell and owns every node under it, and app.js hangs those hosts
   in here and says which one is showing. */
function Terminals() {
  useSyncExternalStore(subscribeTabs, getTabsVersion, getTabsVersion);
  const { rightOpen } = useLayout();
  const dir = useFocusedDir();
  return <div id="terms" hidden={!(rightOpen && activeKind(dir) === 'terminal') || undefined} />;
}

// -------------------------------------------------------------------- window

export default function Shell() {
  const { railOpen, rightOpen } = useLayout();
  // There is nothing to go full width into until the right column is open.
  const full = layout.previewFull && rightOpen;

  const rail = usePanelRef();
  const agent = usePanelRef();
  const right = usePanelRef();

  useCollapse(rail, railOpen);
  useCollapse(right, rightOpen);
  useCollapse(agent, !full);

  // A panel that has just opened or closed has moved every other panel with it,
  // and the preview's bounds are read off the DOM. Measure after the paint the
  // change caused, not during it.
  useEffect(() => {
    const id = requestAnimationFrame(relayoutNow);
    return () => cancelAnimationFrame(id);
  }, [railOpen, rightOpen, full]);

  return (
    <>
      <TitleBar />

      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1" onLayoutChange={relayoutNow}>
        <ResizablePanel id="rail" panelRef={rail} collapsible defaultSize="18" minSize="180px" maxSize="420px">
            {/* The provider is only here for the context and the Ctrl+Shift+S
                shortcut; the panel around it owns the width. */}
            <SidebarProvider
              className="h-full min-h-0"
              open={railOpen}
              onOpenChange={(open) => setLayout({ railOpen: open })}>
              <Rail />
            </SidebarProvider>
        </ResizablePanel>
        {/* Same rule as the handle beside the right column: keep it in the
            tree so collapsing the rail does not remount the content group. */}
        <ResizableHandle className={railOpen ? undefined : 'pointer-events-none opacity-0'} />

        <ResizablePanel id="content" minSize="380px">
          <ResizablePanelGroup orientation="horizontal" onLayoutChange={relayoutNow}>
            {/* 300, not 380. Both panes are collapsible, and when their
                minimums stopped fitting the library picked one to drop to
                nothing: it picked the chat, and a window one notch too
                narrow became a preview pane with no conversation beside it.
                Two smaller floors both fit inside the window's own, so
                neither has to disappear for the other. */}
            <ResizablePanel id="agent" panelRef={agent} collapsible minSize="300px">
              <section id="agent">
                <div id="agent-root"><App /></div>
                <Welcome />
              </section>
            </ResizablePanel>
            {/* Always mounted. Conditionally rendering the handle used to shift
                the right panel in this group's children and remount it, which
                threw away #terms and every xterm host hanging under it while
                app.js still thought those shells were alive. Collapse is what
                hides a pane; the handle just sits between two real panels. */}
            <ResizableHandle className={(full || !rightOpen) ? 'pointer-events-none opacity-0' : undefined} />
            <ResizablePanel id="right" panelRef={right} collapsible defaultSize="42" minSize="320px">
              <section id="right" data-full={full || undefined}>
                <TabStrip />
                <BrowserView />
                <FilesView />
                <ChangesView />
                <AgentsView />
                <Terminals />
              </section>
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>
      </ResizablePanelGroup>

      <StatusBar />

      {/* Nothing until it is asked for, and asked for from anywhere: it listens
          for its own chord rather than hanging off a button, so where it sits
          in the tree only decides that it is mounted once. */}
      <Palette />

      {/* Where the hand-rolled #toasts container used to sit, just clear of the
          status bar. */}
      <Toaster position="bottom-right" offset={{ bottom: 36, right: 16 }} />
    </>
  );
}
