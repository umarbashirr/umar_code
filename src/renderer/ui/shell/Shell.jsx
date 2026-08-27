/* The window's layout. Three nested resizable groups: the rail beside the
   content, the panes above the terminal, and the chat beside the right column.

   The splitters used to be 1px divs with a mousemove handler that wrote inline
   widths. react-resizable-panels owns them now.

   Every panel stays mounted whether or not it is on screen. Closing one
   collapses it to zero rather than unmounting it, which is what the preview
   needs anyway: a native view that stops laying out hands the agent a 0x0
   page.

   Sizes are the ones the old CSS carried. In this version of the library a bare
   number means pixels and a bare string means percent, so "18" is 18% of the
   window and "180px" is the floor the rail used to have. */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { usePanelRef } from 'react-resizable-panels';
import { FolderTreeIcon, GitCompareIcon, GlobeIcon, PlusIcon, XIcon } from 'lucide-react';
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
import { runCommand } from '../../app.js';
import { onProject, project } from '../../project.js';
import TitleBar from './TitleBar';
import BrowserView from './BrowserView';
import ChangesView from './ChangesView';
import FilesView from './FilesView';
import Palette from './Palette';
import Rail from './Rail';
import StatusBar from './StatusBar';
import Welcome from './Welcome';
import TerminalPanel from './TerminalPanel';
import Toolbar from './Toolbar';
import { getVersion, layout, relayoutNow, setLayout, subscribe } from './layout-store';
import { coverPane, uncoverPane } from './pane-cover';
import {
  activateTab,
  activeKind,
  activeTab,
  carryInto,
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

// The folder with focus. There is one right column and one terminal panel, so
// one folder at a time gets to draw its tabs and its shells.
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
};

// A preview whose page has not said what it is yet, or has not loaded anything
// at all. Every browser calls that tab the same thing, so this one does too.
const labelOf = (tab) => (tab.kind === 'browser' ? tab.title || 'New tab' : VIEW_KINDS[tab.kind].label);

/* Starting one. Files and Changes may already be open in this folder, in which
   case the store hands back the one that is there, so all three are offered
   every time rather than the menu guessing which are spent. */
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
      <DropdownMenuContent align="start">
        {KINDS.map((kind) => {
          const { icon: Icon, label, command, adds } = VIEW_KINDS[kind];
          // The plus asks for another tab. For the tree and the diff there is
          // only ever the one, so it lands you on it; for a preview it means a
          // second page, which is what the toolbar button cannot ask for.
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
   tree and the diff. It draws the focused folder's row, and switching folders
   swaps it for that folder's own, the way the terminal strip does.

   Clicking only moves the store. The pages behind the preview tabs are native
   views main holds, and app.js reconciles those against the store, so nothing
   here talks to main about them.

   The plus is the tallest thing in the row, so the strip stands the same height
   empty as full. That matters more than it looks: the preview's bounds are read
   off the DOM below this, and a row that grew when the first tab arrived would
   leave the page laid out for the wrong box. */
function TabStrip() {
  useSyncExternalStore(subscribeTabs, getTabsVersion, getTabsVersion);
  const dir = useFocusedDir();
  const tabs = tabsOf(dir);
  const active = activeTab(dir);

  /* Arriving somewhere with the column open and an empty strip. The kind you
     were reading comes across, because leaving a diff in one project to land on
     a blank column in the next is not what the move meant. Harmless if app.js
     got there first: a folder with tabs keeps the ones it has. */
  const cameFrom = useRef(null);
  useEffect(() => {
    if (cameFrom.current && cameFrom.current !== dir) carryInto(dir, activeKind(cameFrom.current));
    cameFrom.current = dir;
  }, [dir]);

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
          return (
            <TabsTrigger key={tab.id} value={tab.id} title={label} className="group flex-none gap-1.5 text-xs">
              <Icon />
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
            means a folder that has never had one open. Say so, rather than
            leaving a lone plus over a blank column. */}
        {!tabs.length && <span className="px-1 text-xs text-muted-foreground">Nothing open in this folder</span>}
      </TabsList>
    </Tabs>
  );
}

// -------------------------------------------------------------------- window

export default function Shell() {
  const { railOpen, rightOpen, panelOpen } = useLayout();
  // There is nothing to go full width into until the right column is open.
  const full = layout.previewFull && rightOpen;

  const rail = usePanelRef();
  const agent = usePanelRef();
  const right = usePanelRef();
  const panel = usePanelRef();

  useCollapse(rail, railOpen);
  useCollapse(right, rightOpen);
  useCollapse(panel, panelOpen);
  useCollapse(agent, !full);

  // A panel that has just opened or closed has moved every other panel with it,
  // and the preview's bounds are read off the DOM. Measure after the paint the
  // change caused, not during it.
  useEffect(() => {
    const id = requestAnimationFrame(relayoutNow);
    return () => cancelAnimationFrame(id);
  }, [railOpen, rightOpen, full, panelOpen]);

  return (
    <>
      <TitleBar />
      <Toolbar />

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
        {railOpen && <ResizableHandle />}

        <ResizablePanel id="content" minSize="380px">
          <ResizablePanelGroup orientation="vertical" onLayoutChange={relayoutNow}>
            <ResizablePanel id="panes" minSize="160px">
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
                {!full && rightOpen && <ResizableHandle />}
                <ResizablePanel id="right" panelRef={right} collapsible defaultSize="42" minSize="320px">
                  <section id="right" data-full={full || undefined}>
                    <TabStrip />
                    <BrowserView />
                    <FilesView />
                    <ChangesView />
                  </section>
                </ResizablePanel>
              </ResizablePanelGroup>
            </ResizablePanel>

            {panelOpen && <ResizableHandle />}
            <ResizablePanel id="panel" panelRef={panel} collapsible defaultSize={280} minSize={124}>
              <TerminalPanel />
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
