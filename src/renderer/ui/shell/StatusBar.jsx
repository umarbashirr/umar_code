/* The strip along the bottom: whether the bridge is up, the one command that
   registers it with claude, what the page in the preview is doing, and the
   zoom. */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { MinusIcon, PlusIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { resetZoom, stepZoom, zoomLevel } from '../../app.js';
import { bridge, copyMcpCommand, getBridgeVersion, loadBridge, subscribeBridge } from './bridge';
import { browserState, getBrowserVersion, subscribeBrowser } from './browser-store';

function useBridge() {
  useSyncExternalStore(subscribeBridge, getBridgeVersion, getBridgeVersion);
  useEffect(() => { loadBridge(); }, []);
  return bridge;
}

// Zoom is written to the settings file, and the file is what everything else
// redraws from, so listening to it covers the menu and the keyboard too.
function useZoom() {
  const [zoom, setZoom] = useState(zoomLevel);
  useEffect(() => window.tandem.settings.onChanged(() => setZoom(zoomLevel())), []);
  return zoom;
}

export default function StatusBar() {
  const { url } = useBridge();
  useSyncExternalStore(subscribeBrowser, getBrowserVersion, getBrowserVersion);
  const zoom = useZoom();

  return (
    <footer
      id="status"
      className="flex h-6 shrink-0 items-center gap-2.5 border-t bg-[var(--rail)] px-3 text-[11px] text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span
          data-up={url ? '' : undefined}
          className="size-1.5 rounded-full bg-[hsl(var(--warning))] data-[up]:bg-[hsl(var(--success))]" />
        {url ? `bridge ${url.replace('http://127.0.0.1', 'loopback')}` : 'starting'}
      </span>

      <Separator orientation="vertical" className="mx-1 !h-3" />

      <Button
        variant="link"
        size="sm"
        className="h-auto p-0 text-[11px] text-muted-foreground"
        title="Copy the MCP registration command"
        onClick={copyMcpCommand}>
        copy mcp command
      </Button>

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
