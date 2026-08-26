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
import { useEffect, useLayoutEffect, useSyncExternalStore } from 'react';
import { usePanelRef } from 'react-resizable-panels';
import { SidebarProvider } from '@/components/ui/sidebar';
import { Toaster } from '@/components/ui/sonner';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import App from '../App';
import TitleBar from './TitleBar';
import BrowserView from './BrowserView';
import ChangesView from './ChangesView';
import FilesView from './FilesView';
import Rail from './Rail';
import StatusBar from './StatusBar';
import Welcome from './Welcome';
import TerminalPanel from './TerminalPanel';
import Toolbar from './Toolbar';
import { getVersion, layout, relayoutNow, setLayout, subscribe } from './layout-store';

export const useLayout = () => {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return layout;
};

// Collapsed before the first paint when it starts closed, so nothing flashes
// open on launch, and imperatively after that.
function useCollapse(ref, open) {
  useLayoutEffect(() => {
    if (open) ref.current?.expand();
    else ref.current?.collapse();
  }, [ref, open]);
}

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
                <ResizablePanel id="agent" panelRef={agent} collapsible minSize="380px">
                  <section id="agent">
                    <div id="agent-root"><App /></div>
                    <Welcome />
                  </section>
                </ResizablePanel>
                {!full && rightOpen && <ResizableHandle />}
                <ResizablePanel id="right" panelRef={right} collapsible defaultSize="42" minSize="420px">
                  <section id="right" data-full={full || undefined}>
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

      {/* Where the hand-rolled #toasts container used to sit, just clear of the
          status bar. */}
      <Toaster position="bottom-right" offset={{ bottom: 36, right: 16 }} />
    </>
  );
}
