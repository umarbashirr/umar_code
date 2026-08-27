/* The strip along the bottom: what the page in the preview is doing, and the
   zoom.

   It used to lead with the bridge's port and a link to copy the MCP
   registration command. Both were there to be read once and then never again,
   and a port number nobody acts on is not status, it is furniture. The command
   is still in the Help menu, which is where you go when you actually want it. */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { MinusIcon, PlusIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { resetZoom, stepZoom, zoomLevel } from '../../app.js';
import { browserState, getBrowserVersion, subscribeBrowser } from './browser-store';

// Zoom is written to the settings file, and the file is what everything else
// redraws from, so listening to it covers the menu and the keyboard too.
function useZoom() {
  const [zoom, setZoom] = useState(zoomLevel);
  useEffect(() => window.tandem.settings.onChanged(() => setZoom(zoomLevel())), []);
  return zoom;
}

export default function StatusBar() {
  useSyncExternalStore(subscribeBrowser, getBrowserVersion, getBrowserVersion);
  const zoom = useZoom();

  return (
    <footer
      id="status"
      className="flex h-6 shrink-0 items-center gap-2.5 border-t bg-[var(--rail)] px-3 text-[11px] text-muted-foreground">
      <span className="min-w-0 flex-1" />

      <span className="max-w-[50ch] truncate font-mono text-muted-foreground">{browserState.status}</span>

      <Separator orientation="vertical" className="mx-1 !h-3" />

      <div className="flex items-center gap-0.5">
        <Button variant="ghost" size="icon-xs" title="Smaller (Ctrl+-)" onClick={() => stepZoom(-1)}>
          <MinusIcon />
        </Button>
        <Button
          variant="ghost"
          size="xs"
          data-default={zoom === 1 ? '' : undefined}
          className="min-w-[5ch] font-mono text-[10px] data-[default]:text-muted-foreground"
          title="Back to 100% (Ctrl+0)"
          onClick={resetZoom}>
          {`${Math.round(zoom * 100)}%`}
        </Button>
        <Button variant="ghost" size="icon-xs" title="Bigger (Ctrl++)" onClick={() => stepZoom(1)}>
          <PlusIcon />
        </Button>
      </div>
    </footer>
  );
}
