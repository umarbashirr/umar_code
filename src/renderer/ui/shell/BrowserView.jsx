/* The preview browser: an address bar, the slot the native view is flown into,
   and the console/network drawer under it.

   #paneslot is deliberately empty. The page is a separate web contents that the
   window paints on top of this document at whatever bounds that div reports, so
   everything here is the frame around a hole.

   A folder can have several previews open, and the frame is drawn once per
   preview tab rather than once for the window. All of them stay mounted and
   every one but the active tab's is display:none. The alternative, one frame
   reading whichever record is active, throws away everything the DOM is holding
   for the tabs behind it: the address you were halfway through typing, where
   you had scrolled the console. Those belong to a tab, not to a window, and
   moving them into the store would repaint three hundred log rows per
   keystroke.

   There is still only one hole. Bounds are measured and watched off #paneslot
   by id, and a native view can only be in one place, so the frames stack around
   a single slot that outlives all of them: toolbars above it, drawers below,
   and the one that is showing gives the hole its height. */
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
  clearLogs,
  consoleErrors,
  getBrowserVersion,
  go,
  hideDrawer,
  navigateTab,
  onScreen,
  pickElement,
  previewOf,
  previews,
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

// Every frame listens and only the one on screen is repainted by the store, so
// a hidden frame costs a version compare. A tab that has not loaded anything
// yet reads as blank rather than borrowing the page of whichever tab is
// current.
function useBrowser(tab) {
  useSyncExternalStore(subscribeBrowser, getBrowserVersion, getBrowserVersion);
  return previewOf(tab);
}

// ------------------------------------------------------------- address bar

function AddressBar({ tab, showing }) {
  const s = useBrowser(tab);
  const [draft, setDraft] = useState(s.url);
  const input = useRef(null);

  // The bar follows the page while you are not typing in it.
  const focused = document.activeElement === input.current;
  useEffect(() => { if (!focused) setDraft(s.url); }, [s.url, focused]);

  const onKeyDown = (e) => {
    if (e.key === 'Enter') { navigateTab((s.scheme + draft).trim(), tab); input.current?.blur(); }
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
        /* Ctrl+Shift+L and the store's "are you typing" check both go by this
           id, so it belongs to the one bar you can see. */
        id={showing ? 'url' : undefined}
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
function PaneMenu({ tab }) {
  const s = useBrowser(tab);
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
                onCheckedChange={() => setViewport(v.size, tab)}>
                <Icon />
                {v.label}
                {v.note && <span className="ml-auto font-mono text-[10.5px] text-muted-foreground">{v.note}</span>}
              </DropdownMenuCheckboxItem>
            );
          })}
        </DropdownMenuGroup>

        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onSelect={() => pickElement(tab)}>
            <CrosshairIcon />
            Point at an element
            <DropdownMenuShortcut>^⇧E</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => screenshot(tab)}>
            <CameraIcon />
            Screenshot to disk
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => go('devtools', tab)}>
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

function PageError({ tab, error }) {
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
          <Button size="sm" onClick={() => askAboutError(tab)}>Ask Agent</Button>
          <Button size="sm" variant="outline" onClick={() => showDrawer('network', tab)}>Show Details</Button>
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

// What is over the hole for one tab. Only the showing tab's is drawn, because
// they would otherwise stack on top of each other in the one stage.
function Stage({ tab, showing }) {
  const s = useBrowser(tab);
  if (!showing) return null;
  if (s.error) return <PageError tab={tab} error={s.error} />;
  return s.live ? null : <Placeholder />;
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

function Drawer({ tab, showing }) {
  const s = useBrowser(tab);
  const body = useRef(null);
  // Where this tab was reading. A hidden drawer is display:none, which drops
  // the scroll offset on the floor, so the tab carries its own place back.
  const seat = useRef({ top: 0, stick: true });
  const rows = s.drawerTab === 'console' ? s.console : s.network;

  useEffect(() => {
    const el = body.current;
    if (!el) return undefined;
    const onScroll = () => {
      seat.current.stick = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
      seat.current.top = el.scrollTop;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [s.drawerOpen]);

  // New lines arrive at the bottom, which is where you are reading, unless you
  // have scrolled off it to look at something.
  useEffect(() => {
    const el = body.current;
    if (!el || !showing) return;
    el.scrollTop = seat.current.stick ? el.scrollHeight : seat.current.top;
  }, [showing, rows.length, s.drawerTab]);

  if (!s.drawerOpen) return null;

  const errors = consoleErrors(tab);

  return (
    <div className="flex h-[220px] shrink-0 flex-col border-t" hidden={!showing || undefined}>
      <Tabs value={s.drawerTab} onValueChange={(v) => showDrawer(v, tab)} className="min-h-0 flex-1 gap-0">
        <div className="flex items-center gap-2 border-b px-2 py-1">
          <TabsList className="h-7 bg-transparent p-0">
            <TabsTrigger value="console" className="gap-1.5 text-xs">
              console
              {s.console.length > 0 && (
                <Badge variant={errors ? 'destructive' : 'secondary'} className="px-1.5 py-0 text-[10px]">
                  {errors || s.console.length}
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

          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-muted-foreground"
            onClick={() => clearLogs(tab)}>
            clear
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={ICON_BUTTON}
            title="Close (Ctrl+Shift+J)"
            onClick={() => hideDrawer(tab)}>
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

// ------------------------------------------------------------------ toolbar

function Toolbar({ tab, showing }) {
  const s = useBrowser(tab);
  const errors = consoleErrors(tab);

  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b px-2.5" hidden={!showing || undefined}>
      <Button variant="ghost" size="icon" className={ICON_BUTTON} title="Back" disabled={!s.canGoBack} onClick={() => go('back', tab)}>
        <ArrowLeftIcon />
      </Button>
      <Button variant="ghost" size="icon" className={ICON_BUTTON} title="Forward" disabled={!s.canGoForward} onClick={() => go('forward', tab)}>
        <ArrowRightIcon />
      </Button>
      <Button variant="ghost" size="icon" className={ICON_BUTTON} title="Reload" onClick={() => go('reload', tab)}>
        <RotateCwIcon />
      </Button>

      <div className="min-w-0 flex-1"><AddressBar tab={tab} showing={showing} /></div>

      {/* The tab badges go off screen with the closed drawer, and the drawer
          starts closed, so a page that loaded fine and then threw a hundred
          times looked exactly like a clean one. */}
      {errors > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-destructive"
          title="Console errors. Click to open the console."
          onClick={() => showDrawer('console', tab)}>
          <TriangleAlertIcon />
          {errors}
        </Button>
      )}

      <PaneMenu tab={tab} />
    </div>
  );
}

// -------------------------------------------------------------------- pane

export default function BrowserView() {
  useSyncExternalStore(subscribeBrowser, getBrowserVersion, getBrowserVersion);
  // Read for the repaint rather than for a value: onScreen() answers out of the
  // layout, so this frame has to redraw when the column opens or shuts.
  useLayout();
  const shown = onScreen();
  const open = previews();

  return (
    <div className="flex h-full min-h-0 flex-col" hidden={!shown || undefined}>
      {open.map(({ tab }) => <Toolbar key={tab} tab={tab} showing={tab === shown} />)}

      <div className="relative min-h-0 flex-1">
        <div id="paneslot" className="absolute inset-0" />
        {open.map(({ tab }) => <Stage key={tab} tab={tab} showing={tab === shown} />)}
      </div>

      {open.map(({ tab }) => <Drawer key={tab} tab={tab} showing={tab === shown} />)}
    </div>
  );
}
