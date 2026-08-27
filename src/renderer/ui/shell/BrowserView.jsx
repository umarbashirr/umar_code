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
  EllipsisVerticalIcon,
  FolderTreeIcon,
  GitCompareIcon,
  GlobeIcon,
  LaptopIcon,
  Maximize2Icon,
  Minimize2Icon,
  MonitorIcon,
  MousePointer2Icon,
  RotateCwIcon,
  ScanIcon,
  SmartphoneIcon,
  SparklesIcon,
  TabletIcon,
  TerminalIcon,
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
import { warmPane } from './pane-cover';
import { useLayout, usePaneCover } from './Shell';

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

/* Lucide has a pointer, and it has sparkles, and nothing that is both. The
   sparkle rides the pointer's top corner, small enough to read as a mark on the
   tool rather than as a second icon standing beside it. */
function PointerSparkIcon() {
  return (
    <span className="relative inline-flex size-4 items-center justify-center">
      <MousePointer2Icon className="size-4" />
      <SparklesIcon className="-top-[3px] -right-[3px] absolute size-2.5" />
    </span>
  );
}

/* Pointing at something in the page and handing it to the agent. It was a line
   in the menu, two clicks from the pointer being on the thing you meant, which
   is the wrong price for the one tool here that is used mid-thought. Armed, it
   wears the state the menu button used to. */
function PickButton({ tab }) {
  const s = useBrowser(tab);

  return (
    <Button
      variant="ghost"
      size="icon"
      data-armed={s.picking ? '' : undefined}
      className={`${ICON_BUTTON} data-[armed]:bg-muted-foreground data-[armed]:text-background`}
      title="Point at an element (Ctrl+Shift+E)"
      onClick={() => pickElement(tab)}>
      <PointerSparkIcon />
    </Button>
  );
}

/* The widths, on their own. Which one the page is in is a thing you change and
   change back while you work, so it gets a button that says which one you are
   in rather than a group buried under a menu that says nothing. */
function ViewportMenu({ tab }) {
  const s = useBrowser(tab);
  const [open, setOpen] = useState(false);
  usePaneCover(open);

  const held = VIEWPORTS.find((v) => v.size === s.viewport) || VIEWPORTS[0];
  const Current = VIEWPORT_ICON[held.icon];

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          data-armed={s.viewport ? '' : undefined}
          className={`${ICON_BUTTON} data-[armed]:text-foreground`}
          title={`Viewport: ${held.label}`}
          onPointerDown={warmPane}>
          <Current />
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* What is left once the pointer and the widths have their own buttons: the
   things you reach for once and are done with. */
function PaneMenu({ tab }) {
  const { previewFull } = useLayout();
  const [open, setOpen] = useState(false);

  // The menu opens over a native view, so freeze the page under it.
  usePaneCover(open);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={ICON_BUTTON}
          title="Preview tools"
          onPointerDown={warmPane}>
          <EllipsisVerticalIcon />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
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

/* A tab with nothing in it yet.

   It used to be a sentence explaining that nothing was there, which is the one
   thing the empty pane had already said. A new tab is a decision, so this is
   the decision: the four things this column can hold, each one click away, and
   the address bar first because it is the one this tab is already set up for.

   Files and Changes are the column's other kinds rather than this tab's, so
   picking one opens that tab beside this one. The preview stays where it is
   with its address bar ready. */
function Tile({ icon: Icon, label, hint, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-24 w-32 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border bg-card text-card-foreground transition-colors hover:border-ring hover:bg-accent">
      <Icon className="size-5 text-muted-foreground" />
      <span className="font-medium text-xs">{label}</span>
      {hint && <span className="text-[10px] text-muted-foreground">{hint}</span>}
    </button>
  );
}

function Placeholder() {
  const address = () => {
    const box = document.getElementById('url');
    box?.focus();
    box?.select();
  };

  return (
    <Empty className="absolute inset-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <AppWindowIcon />
        </EmptyMedia>
        <EmptyTitle>New tab</EmptyTitle>
        <EmptyDescription>
          Start a dev server in the terminal and this pane offers to open it, or pick something below.
        </EmptyDescription>
      </EmptyHeader>

      <EmptyContent>
        <div className="grid grid-cols-2 gap-2">
          <Tile icon={GlobeIcon} label="Open an address" hint="^⇧L" onClick={address} />
          <Tile icon={TerminalIcon} label="Terminal" hint="^`" onClick={() => runCommand('terminal')} />
          <Tile icon={FolderTreeIcon} label="Project files" hint="^⇧D" onClick={() => runCommand('files')} />
          <Tile icon={GitCompareIcon} label="Changes" hint="^⇧G" onClick={() => runCommand('changes')} />
        </div>
        <p className="text-[11px] text-muted-foreground">
          <code>tandem go 3000</code> from the shell or the agent
        </p>
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

/* One bar across the top of the pane while a page is on its way.

   The status line has said "loading…" in words since the beginning, at the very
   bottom of the window, in the place nobody looks while they are waiting to
   find out whether the thing is stuck. This is at the top of the pane, where
   the page is about to appear. */
function LoadingBar({ tab }) {
  const s = useBrowser(tab);
  if (!s.loading) return null;

  return (
    <div className="h-0.5 shrink-0 overflow-hidden bg-transparent">
      <div className="pane-load h-full w-1/4 rounded-full bg-primary" />
    </div>
  );
}

function Toolbar({ tab, showing }) {
  const s = useBrowser(tab);
  const errors = consoleErrors(tab);
  // Held a beat past the click so the turn is seen even when the load is not.
  const [spun, setSpun] = useState(false);
  useEffect(() => {
    if (!spun) return undefined;
    const t = setTimeout(() => setSpun(false), 600);
    return () => clearTimeout(t);
  }, [spun]);

  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b px-2.5" hidden={!showing || undefined}>
      <Button variant="ghost" size="icon" className={ICON_BUTTON} title="Back" disabled={!s.canGoBack} onClick={() => go('back', tab)}>
        <ArrowLeftIcon />
      </Button>
      <Button variant="ghost" size="icon" className={ICON_BUTTON} title="Forward" disabled={!s.canGoForward} onClick={() => go('forward', tab)}>
        <ArrowRightIcon />
      </Button>
      {/* A reload of a page already in cache is over before the next frame, and
          a button that does nothing visible reads as a button that did nothing.
          The spin outlives the fastest load on purpose. */}
      <Button
        variant="ghost"
        size="icon"
        className={ICON_BUTTON}
        title="Reload"
        onClick={() => { setSpun(true); go('reload', tab); }}>
        <RotateCwIcon className={spun || s.loading ? 'animate-spin' : undefined} />
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

      <PickButton tab={tab} />
      <ViewportMenu tab={tab} />
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
      {shown && <LoadingBar tab={shown} />}

      <div className="relative min-h-0 flex-1">
        <div id="paneslot" className="absolute inset-0" />
        {open.map(({ tab }) => <Stage key={tab} tab={tab} showing={tab === shown} />)}
      </div>

      {open.map(({ tab }) => <Drawer key={tab} tab={tab} showing={tab === shown} />)}
    </div>
  );
}
