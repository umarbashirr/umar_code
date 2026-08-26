/* The preview browser: an address bar, the slot the native view is flown into,
   and the console/network drawer under it.

   #paneslot is deliberately empty. The page is a separate web contents that the
   window paints on top of this document at whatever bounds that div reports, so
   everything here is the frame around a hole. */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  AppWindowIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  CameraIcon,
  ChevronDownIcon,
  CodeXmlIcon,
  CrosshairIcon,
  EllipsisVerticalIcon,
  LaptopIcon,
  Maximize2Icon,
  Minimize2Icon,
  MonitorIcon,
  RotateCwIcon,
  ScanIcon,
  SmartphoneIcon,
  TabletIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { runCommand } from '../../app.js';
import {
  askAboutError,
  browserState,
  clearLogs,
  consoleErrors,
  getBrowserVersion,
  go,
  hideDrawer,
  navigate,
  pickElement,
  screenshot,
  setViewport,
  showDrawer,
  subscribeBrowser,
  VIEWPORTS,
} from './browser-store';
import { coverPane, uncoverPane } from './pane-cover';
import { useLayout } from './Shell';

const VIEWPORT_ICON = {
  scan: ScanIcon,
  smartphone: SmartphoneIcon,
  tablet: TabletIcon,
  laptop: LaptopIcon,
  monitor: MonitorIcon,
};

const ICON_BUTTON = 'size-7 rounded-md text-muted-foreground';

function useBrowser() {
  useSyncExternalStore(subscribeBrowser, getBrowserVersion, getBrowserVersion);
  return browserState;
}

// ------------------------------------------------------------- address bar

function AddressBar() {
  const s = useBrowser();
  const [draft, setDraft] = useState(s.url);
  const input = useRef(null);

  // The bar follows the page while you are not typing in it.
  const focused = document.activeElement === input.current;
  useEffect(() => { if (!focused) setDraft(s.url); }, [s.url, focused]);

  const onKeyDown = (e) => {
    if (e.key === 'Enter') { navigate((s.scheme + draft).trim()); input.current?.blur(); }
    if (e.key === 'Escape') input.current?.blur();
  };

  return (
    <InputGroup className="h-8">
      {s.scheme && (
        <InputGroupAddon>
          <span className="font-mono text-[11px] text-muted-foreground">{s.scheme}</span>
        </InputGroupAddon>
      )}
      <InputGroupInput
        id="url"
        ref={input}
        spellCheck={false}
        placeholder="localhost:3000, a URL, or a search"
        className="font-mono text-[13px]"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown} />
    </InputGroup>
  );
}

// ---------------------------------------------------------------- pane menu

/* Everything the pane can do beyond navigating, in one menu. The bar kept nine
   icons in a row and none of them said what they were. */
function PaneMenu() {
  const s = useBrowser();
  const { previewFull } = useLayout();
  const [open, setOpen] = useState(false);

  // The menu opens over a native view, so freeze the page under it.
  useEffect(() => {
    if (!open) { uncoverPane(); return undefined; }
    const id = requestAnimationFrame(() => {
      const content = document.querySelector('[data-slot="dropdown-menu-content"]');
      coverPane(content?.getBoundingClientRect());
    });
    return () => cancelAnimationFrame(id);
  }, [open]);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          data-armed={s.picking ? '' : undefined}
          className={`${ICON_BUTTON} data-[armed]:bg-muted-foreground data-[armed]:text-background`}
          title="Preview tools">
          <EllipsisVerticalIcon />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Viewport</DropdownMenuLabel>
        <DropdownMenuGroup>
          {VIEWPORTS.map((v) => {
            const Icon = VIEWPORT_ICON[v.icon];
            return (
              <DropdownMenuCheckboxItem
                key={v.size || 'fit'}
                checked={s.viewport === v.size}
                onCheckedChange={() => setViewport(v.size)}>
                <Icon />
                {v.label}
                {v.note && <span className="ml-auto font-mono text-[10.5px] text-muted-foreground">{v.note}</span>}
              </DropdownMenuCheckboxItem>
            );
          })}
        </DropdownMenuGroup>

        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onSelect={() => pickElement()}>
            <CrosshairIcon />
            Point at an element
            <DropdownMenuShortcut>^⇧E</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => screenshot()}>
            <CameraIcon />
            Screenshot to disk
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => go('devtools')}>
            <CodeXmlIcon />
            DevTools
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => runCommand('previewFull')}>
            {previewFull ? <Minimize2Icon /> : <Maximize2Icon />}
            {previewFull ? 'Back to the chat' : 'Preview at full width'}
            <DropdownMenuShortcut>^⇧F</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuGroup>

        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem variant="destructive" onSelect={() => runCommand('preview', false)}>
            <XIcon />
            Hide the preview
            <DropdownMenuShortcut>^⇧B</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ------------------------------------------------------------------- stage

const CONNECTION = /ERR_CONNECTION|refused|(-102)/i;

function PageError({ error }) {
  return (
    <Empty className="absolute inset-0 bg-card">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <TriangleAlertIcon />
        </EmptyMedia>
        <EmptyTitle>
          {CONNECTION.test(error.message) ? "Can't connect to server" : 'This page did not load'}
        </EmptyTitle>
        <EmptyDescription>{`${error.url || 'the page'} — ${error.message}`}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <div className="flex gap-2">
          <Button size="sm" onClick={askAboutError}>Ask Agent</Button>
          <Button size="sm" variant="outline" onClick={() => showDrawer('network')}>Show Details</Button>
        </div>
      </EmptyContent>
    </Empty>
  );
}

function Placeholder() {
  return (
    <Empty className="absolute inset-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <AppWindowIcon />
        </EmptyMedia>
        <EmptyTitle>No page loaded</EmptyTitle>
        <EmptyDescription>
          Start a dev server in the terminal. When it prints a local address, this pane offers to open it.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <div className="flex flex-col items-center gap-1 text-xs text-muted-foreground">
          <span><kbd>^⇧L</kbd> address bar</span>
          <span><code>tandem go 3000</code> from the shell or the agent</span>
        </div>
      </EmptyContent>
    </Empty>
  );
}

// ------------------------------------------------------------------ drawer

function LogRow({ row }) {
  const level = row.level || (row.kind === 'failed' ? 'error' : '') || row.kind || '';
  const message = row.message ?? `${row.status || row.error || ''} ${row.method || ''} ${row.url || ''}`.trim();

  return (
    <div className="flex gap-2 border-b px-3 py-1 font-mono text-[11px] last:border-b-0">
      <span
        data-level={level}
        className="w-14 shrink-0 text-muted-foreground data-[level=error]:text-destructive data-[level=warning]:text-[hsl(var(--warning))]">
        {level}
      </span>
      <span className="min-w-0 break-all">{message}</span>
    </div>
  );
}

function Drawer() {
  const s = useBrowser();
  const body = useRef(null);
  const rows = s.drawerTab === 'console' ? s.console : s.network;

  // New lines arrive at the bottom, which is where you are reading.
  useEffect(() => {
    if (body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [rows.length, s.drawerTab]);

  if (!s.drawerOpen) return null;

  return (
    <div className="flex h-[220px] shrink-0 flex-col border-t">
      <Tabs value={s.drawerTab} onValueChange={showDrawer} className="min-h-0 flex-1 gap-0">
        <div className="flex items-center gap-2 border-b px-2 py-1">
          <TabsList className="h-7 bg-transparent p-0">
            <TabsTrigger value="console" className="gap-1.5 text-xs">
              console
              {s.console.length > 0 && (
                <Badge variant={consoleErrors() ? 'destructive' : 'secondary'} className="px-1.5 py-0 text-[10px]">
                  {consoleErrors() || s.console.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="network" className="gap-1.5 text-xs">
              network
              {s.network.length > 0 && (
                <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">{s.network.length}</Badge>
              )}
            </TabsTrigger>
          </TabsList>

          <span className="flex-1" />

          <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={clearLogs}>
            clear
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={ICON_BUTTON}
            title="Close (Ctrl+Shift+J)"
            onClick={hideDrawer}>
            <ChevronDownIcon />
          </Button>
        </div>

        <ScrollArea className="min-h-0 flex-1" viewportRef={body}>
          {rows.length === 0
            ? <div className="p-3 text-xs text-muted-foreground">{`no ${s.drawerTab} entries`}</div>
            : rows.slice(-300).map((row, i) => <LogRow key={`${i}-${row.url || row.message}`} row={row} />)}
        </ScrollArea>
      </Tabs>
    </div>
  );
}

// -------------------------------------------------------------------- pane

export default function BrowserView() {
  const s = useBrowser();
  const { rightOpen, rightView } = useLayout();
  const errors = consoleErrors();

  return (
    <div className="flex h-full min-h-0 flex-col" hidden={!(rightOpen && rightView === 'browser') || undefined}>
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-2.5">
        <Button variant="ghost" size="icon" className={ICON_BUTTON} title="Back" disabled={!s.canGoBack} onClick={() => go('back')}>
          <ArrowLeftIcon />
        </Button>
        <Button variant="ghost" size="icon" className={ICON_BUTTON} title="Forward" disabled={!s.canGoForward} onClick={() => go('forward')}>
          <ArrowRightIcon />
        </Button>
        <Button variant="ghost" size="icon" className={ICON_BUTTON} title="Reload" onClick={() => go('reload')}>
          <RotateCwIcon />
        </Button>

        <div className="min-w-0 flex-1"><AddressBar /></div>

        {/* The tab badges go off screen with the closed drawer, and the drawer
            starts closed, so a page that loaded fine and then threw a hundred
            times looked exactly like a clean one. */}
        {errors > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-destructive"
            title="Console errors. Click to open the console."
            onClick={() => showDrawer('console')}>
            <TriangleAlertIcon />
            {errors}
          </Button>
        )}

        <PaneMenu />
      </div>

      <div className="relative min-h-0 flex-1">
        <div id="paneslot" className="absolute inset-0" />
        {s.error ? <PageError error={s.error} /> : !s.live && <Placeholder />}
      </div>

      <Drawer />
    </div>
  );
}
