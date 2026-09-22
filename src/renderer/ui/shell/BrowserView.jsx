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
   and the one that is showing gives the hole its height.

   Empty and error Stages paint inside the hole. The guest is hidden for those
   states (see guestWanted in browser-store), otherwise Chromium's blank page
   would cover this chrome. */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  AppWindowIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  CameraIcon,
  ChevronDownIcon,
  CodeXmlIcon,
  EllipsisVerticalIcon,
  ExternalLinkIcon,
  FolderTreeIcon,
  GitCompareIcon,
  GlobeIcon,
  HistoryIcon,
  LaptopIcon,
  Maximize2Icon,
  Minimize2Icon,
  MonitorIcon,
  MousePointer2Icon,
  RadioTowerIcon,
  RotateCcwSquareIcon,
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
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { runCommand } from '../../app.js';
import {
  askAboutError,
  clearLogs,
  consoleErrors,
  getBrowserVersion,
  go,
  hideDrawer,
  localServers,
  navigateTab,
  onScreen,
  parseViewport,
  pickElement,
  previewOf,
  previews,
  recentUrls,
  removeRecent,
  rotateViewport,
  frameBox,
  holdScale,
  MAX_VIEWPORT,
  MIN_VIEWPORT,
  toggleResponsive,
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

const ERROR_HINTS = [
  [/ERR_CONNECTION_REFUSED|refused|(-102)/i, 'Connection refused'],
  [/ERR_NAME_NOT_RESOLVED|(-105)/i, 'DNS address could not be found'],
  [/ERR_CONNECTION_TIMED_OUT|(-118)/i, 'Connection timed out'],
  [/ERR_INTERNET_DISCONNECTED|(-106)/i, 'No internet connection'],
  [/ERR_SSL|CERT_/i, 'SSL certificate problem'],
  [/ERR_EMPTY_RESPONSE|(-324)/i, 'Empty response from server'],
];

function friendlyError(message) {
  for (const [re, label] of ERROR_HINTS) {
    if (re.test(message || '')) return label;
  }
  return 'The page did not load';
}

function errorCode(message) {
  const m = /(ERR_[A-Z0-9_]+)|(-?\d{2,4})/.exec(message || '');
  return m ? (m[1] || `ERR_${Math.abs(Number(m[2]))}`) : 'ERR_FAILED';
}

function useBrowser(tab) {
  useSyncExternalStore(subscribeBrowser, getBrowserVersion, getBrowserVersion);
  return previewOf(tab);
}

function Tip({ label, children }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

// ------------------------------------------------------------- address bar

function AddressBar({ tab, showing }) {
  const s = useBrowser(tab);
  const [draft, setDraft] = useState(s.url);
  const [focused, setFocused] = useState(false);
  const input = useRef(null);

  useEffect(() => { if (!focused) setDraft(s.url); }, [s.url, focused]);
  // An agent or a failed load can change the page while the bar is focused.
  // Keep the draft on the real address once a load settles, so the field does
  // not stick on what you were halfway through typing over a different page.
  useEffect(() => {
    if (focused && !s.loading) setDraft(s.url);
  }, [s.url, s.loading, focused]);

  const submit = () => {
    const next = (s.scheme + draft).trim();
    if (!next) return;
    navigateTab(next, tab);
    input.current?.blur();
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter') submit();
    if (e.key === 'Escape') {
      e.preventDefault();
      setDraft(s.url);
      input.current?.blur();
    }
  };

  const openExternal = () => go('openExternal', tab);
  const canOpen = s.live && !s.error;

  return (
    <InputGroup className="group/address h-8">
      {s.scheme && (
        <InputGroupAddon>
          <span className="font-mono text-[11px] text-amber-600 dark:text-amber-400">{s.scheme}</span>
        </InputGroupAddon>
      )}
      <InputGroupInput
        id={showing ? 'url' : undefined}
        ref={input}
        spellCheck={false}
        placeholder="Search or enter URL"
        className="font-mono text-[13px]"
        value={focused ? draft : (s.scheme + s.url || draft)}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => {
          setDraft(s.url);
          setFocused(true);
          queueMicrotask(() => input.current?.select());
        }}
        onBlur={() => setFocused(false)}
        onKeyDown={onKeyDown} />
      {canOpen && !focused && (
        <InputGroupAddon
          align="inline-end"
          className="pointer-events-none absolute inset-y-0 right-0 opacity-0 transition-opacity group-hover/address:pointer-events-auto group-hover/address:opacity-100">
          <Tip label="Open in system browser">
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              type="button"
              onClick={openExternal}>
              <ExternalLinkIcon className="size-3.5" />
            </Button>
          </Tip>
        </InputGroupAddon>
      )}
    </InputGroup>
  );
}

// ---------------------------------------------------------------- pane menu

function PointerSparkIcon() {
  return (
    <span className="relative inline-flex size-4 items-center justify-center">
      <MousePointer2Icon className="size-4" />
      <SparklesIcon className="-top-[3px] -right-[3px] absolute size-2.5" />
    </span>
  );
}

function PickButton({ tab }) {
  const s = useBrowser(tab);

  return (
    <Tip label={s.picking ? 'Cancel pick (Esc)' : 'Point at an element (Ctrl+Shift+E)'}>
      <Button
        variant="ghost"
        size="icon"
        data-armed={s.picking ? '' : undefined}
        className={`${ICON_BUTTON} data-[armed]:bg-muted-foreground data-[armed]:text-background`}
        aria-pressed={s.picking ? 'true' : 'false'}
        onClick={() => pickElement(tab)}>
        <PointerSparkIcon />
      </Button>
    </Tip>
  );
}

function ResponsiveButton({ tab }) {
  const s = useBrowser(tab);
  const held = VIEWPORTS.find((v) => v.size === s.viewport);
  const Current = VIEWPORT_ICON[held?.icon] || SmartphoneIcon;

  return (
    <Tip label={s.viewport ? 'Close responsive mode' : 'Responsive mode'}>
      <Button
        variant="ghost"
        size="icon"
        aria-pressed={!!s.viewport}
        data-armed={s.viewport ? '' : undefined}
        className={`${ICON_BUTTON} data-[armed]:bg-accent data-[armed]:text-foreground`}
        onClick={() => toggleResponsive(tab)}>
        <Current />
      </Button>
    </Tip>
  );
}

/* Chrome's device toolbar, under the address bar while a viewport is set. The
   presets used to live in a dropdown on the toolbar button; they are here now,
   beside the numbers they set, and the button only turns the mode on and off. */
function SizeInput({ value, label, onCommit }) {
  const [draft, setDraft] = useState(null);
  const commit = () => {
    const n = Math.round(Number(draft));
    if (draft !== null && n >= MIN_VIEWPORT && n <= MAX_VIEWPORT) onCommit(n);
    setDraft(null);
  };

  return (
    <input
      aria-label={label}
      inputMode="numeric"
      className="h-6 w-14 rounded-md border bg-transparent px-1.5 text-center font-mono text-xs tabular-nums outline-none focus-visible:ring-1 focus-visible:ring-ring"
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value.replace(/\D/g, ''))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') { setDraft(null); e.currentTarget.blur(); }
      }} />
  );
}

function DeviceBar({ tab, showing }) {
  const s = useBrowser(tab);
  const [open, setOpen] = useState(false);
  usePaneCover(open);
  const dims = parseViewport(s.viewport);
  if (!showing || !dims) return null;

  const held = VIEWPORTS.find((v) => v.size === s.viewport);
  const resize = (width, height) => setViewport(`${width}x${height}`, tab);

  return (
    <div className="flex h-9 shrink-0 items-center justify-center gap-2 border-b border-border/60 px-2 text-xs">
      <span className="text-muted-foreground">Dimensions:</span>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-xs" onPointerDown={warmPane}>
            {held ? held.label : 'Responsive'}
            <ChevronDownIcon className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-52">
          <DropdownMenuCheckboxItem checked={!held} onCheckedChange={() => {}}>
            <ScanIcon />
            Responsive
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          {VIEWPORTS.map((v) => {
            const Icon = VIEWPORT_ICON[v.icon];
            return (
              <DropdownMenuCheckboxItem
                key={v.size}
                checked={s.viewport === v.size}
                onCheckedChange={() => setViewport(v.size, tab)}>
                <Icon />
                {v.label}
                <span className="ml-auto font-mono text-[10.5px] text-muted-foreground">{v.note}</span>
              </DropdownMenuCheckboxItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      <SizeInput label="Width" value={dims.width} onCommit={(w) => resize(w, dims.height)} />
      <span className="text-muted-foreground">×</span>
      <SizeInput label="Height" value={dims.height} onCommit={(h) => resize(dims.width, h)} />

      <Tip label="Rotate">
        <Button variant="ghost" size="icon" className="size-6" onClick={() => rotateViewport(tab)}>
          <RotateCcwSquareIcon />
        </Button>
      </Tip>
      <Tip label="Close responsive mode">
        <Button variant="ghost" size="icon" className="size-6" onClick={() => setViewport('', tab)}>
          <XIcon />
        </Button>
      </Tip>
    </div>
  );
}

function PaneMenu({ tab }) {
  const s = useBrowser(tab);
  const { previewFull } = useLayout();
  const [open, setOpen] = useState(false);
  usePaneCover(open);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tip label="Preview tools">
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={ICON_BUTTON}
            onPointerDown={warmPane}>
            <EllipsisVerticalIcon />
          </Button>
        </DropdownMenuTrigger>
      </Tip>

      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuItem onSelect={() => screenshot(tab)}>
            <CameraIcon />
            Screenshot to disk
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => go('hardReload', tab)}>
            <RotateCwIcon />
            Hard reload
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => go('devtools', tab)}>
            <CodeXmlIcon />
            DevTools
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => go('openExternal', tab)}>
            <ExternalLinkIcon />
            Open in system browser
          </DropdownMenuItem>
          <DropdownMenuCheckboxItem checked={!!s.viewport} onCheckedChange={() => toggleResponsive(tab)}>
            <SmartphoneIcon />
            Responsive mode
          </DropdownMenuCheckboxItem>
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

function PageError({ tab, error }) {
  const [details, setDetails] = useState(false);
  const host = (() => {
    try { return new URL(error.url || 'http://local').host; } catch { return error.url || 'the page'; }
  })();

  return (
    <div className="absolute inset-0 overflow-y-auto bg-background">
      <div className="mx-auto flex min-h-full w-full max-w-xl flex-col px-8 py-12">
        <TriangleAlertIcon className="mb-6 size-10 text-muted-foreground/70" />
        <h1 className="mb-3 font-semibold text-2xl text-foreground leading-tight">
          This site can&apos;t be reached
        </h1>
        <p className="text-muted-foreground text-sm leading-relaxed">
          <span className="font-semibold text-foreground">{host}</span>
          {`: ${friendlyError(error.message)}.`}
        </p>

        {details && (
          <div className="mt-6 rounded-lg border bg-muted/40 p-4 text-sm">
            <p className="mb-2 font-medium text-foreground">Try:</p>
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              <li>Confirming the dev server is running</li>
              <li>Checking the port in the address bar</li>
              <li>Asking the agent to start or fix the server</li>
            </ul>
            <p className="mt-3 break-all font-mono text-[11px] text-muted-foreground">
              {error.message}
            </p>
          </div>
        )}

        <div className="mt-8 text-[11px] text-muted-foreground/70 uppercase tracking-wide">
          {errorCode(error.message)}
        </div>

        <div className="mt-auto flex flex-wrap items-center gap-2 pt-8">
          <Button type="button" variant="outline" size="sm" onClick={() => setDetails((v) => !v)}>
            {details ? 'Hide details' : 'Details'}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => showDrawer('network', tab)}>
            Network
          </Button>
          <span className="flex-1" />
          <Button type="button" variant="outline" size="sm" onClick={() => go('reload', tab)}>
            Reload
          </Button>
          <Button type="button" size="sm" onClick={() => askAboutError(tab)}>
            Ask Agent
          </Button>
        </div>
      </div>
    </div>
  );
}

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

function RecentRow({ entry, onOpen, onRemove }) {
  let label = entry.url;
  try {
    const u = new URL(entry.url);
    label = `${u.host}${u.pathname === '/' ? '' : u.pathname}${u.search}`;
  } catch { /* keep url */ }

  return (
    <div className="group relative flex w-full items-center">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-3 px-3 py-2.5 pr-10 text-left hover:bg-accent/40">
        <GlobeIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-sm">{entry.title || label}</span>
          {entry.title && <span className="block truncate text-muted-foreground text-xs">{label}</span>}
        </span>
      </button>
      <button
        type="button"
        aria-label={`Remove ${label}`}
        className="absolute right-2 rounded p-1 text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100"
        onClick={onRemove}>
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}

function Placeholder({ tab }) {
  useBrowser(tab);
  const recents = recentUrls().slice(0, 8);
  const servers = localServers();

  const address = () => {
    const box = document.getElementById('url');
    box?.focus();
    box?.select();
  };

  const hasLists = recents.length > 0 || servers.length > 0;

  return (
    <div className="absolute inset-0 overflow-y-auto">
      {!hasLists ? (
        <Empty className="min-h-full">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <AppWindowIcon />
            </EmptyMedia>
            <EmptyTitle>New tab</EmptyTitle>
            <EmptyDescription>
              Type a URL above, or run a dev script. Local servers show up here when the terminal prints them.
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
      ) : (
        <div className="mx-auto flex w-full max-w-xl flex-col gap-6 px-5 py-8">
          {recents.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <HistoryIcon className="size-4 shrink-0" />
                <h2 className="font-medium">Recently used</h2>
              </div>
              <div className="overflow-hidden rounded-lg border">
                {recents.map((entry) => (
                  <RecentRow
                    key={entry.url}
                    entry={entry}
                    onOpen={() => navigateTab(entry.url, tab)}
                    onRemove={() => removeRecent(entry.url)} />
                ))}
              </div>
            </div>
          )}

          {servers.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <RadioTowerIcon className="size-4 shrink-0" />
                <h2 className="font-medium">Local servers</h2>
              </div>
              <div className="overflow-hidden rounded-lg border">
                {servers.map((server) => (
                  <button
                    key={server.url}
                    type="button"
                    className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-accent/40"
                    onClick={() => navigateTab(server.url, tab)}>
                    <RadioTowerIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate font-medium text-sm">{server.url}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Tile icon={GlobeIcon} label="Address" hint="^⇧L" onClick={address} />
            <Tile icon={TerminalIcon} label="Terminal" hint="^`" onClick={() => runCommand('terminal')} />
            <Tile icon={FolderTreeIcon} label="Files" hint="^⇧D" onClick={() => runCommand('files')} />
            <Tile icon={GitCompareIcon} label="Changes" hint="^⇧G" onClick={() => runCommand('changes')} />
          </div>
        </div>
      )}
    </div>
  );
}

function useSize(ref) {
  const [size, setSize] = useState(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setSize({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/* The page itself is a native view that main lays over the frame's box, so all
   this draws is what sits around it: the outline and the three handles. The
   handles sit just outside the box, since anything inside it is under the view.

   A drag holds the scale it started at. Refitting as the frame grows or
   shrinks would move it under the pointer, and the handle would run away from
   the hand dragging it. Past the edge of the pane it does have to shrink, and
   the frame refits once the drag lets go. */
function DeviceFrame({ tab, showing }) {
  const s = useBrowser(tab);
  const here = useRef(null);
  const slot = useSize(here);
  const dims = parseViewport(s.viewport);
  const on = showing && s.live && !s.error && dims;

  const box = on && slot ? frameBox(slot, dims, s.hold) : null;

  const drag = (axes) => (e) => {
    if (!box || e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const start = { x: e.clientX, y: e.clientY, ...dims };
    const { scale } = box;
    const clamp = (n) => Math.max(MIN_VIEWPORT, Math.min(MAX_VIEWPORT, Math.round(n)));
    holdScale(scale, tab);

    let next = null;
    let frame = 0;
    const move = (ev) => {
      // The frame is centred, so the right edge moves half of what the width
      // does. Twice the pointer's travel keeps the handle under it.
      const width = axes.includes('x') ? clamp(start.width + (2 * (ev.clientX - start.x)) / scale) : start.width;
      const height = axes.includes('y') ? clamp(start.height + (ev.clientY - start.y) / scale) : start.height;
      next = `${width}x${height}`;
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; setViewport(next, tab); });
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      cancelAnimationFrame(frame);
      if (next) setViewport(next, tab);
      holdScale(null, tab);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  return (
    <div ref={here} className="absolute inset-0" hidden={!on || undefined}>
      {box && (
        <div className="absolute inset-0 bg-muted/35">
          <div
            className="pointer-events-none absolute rounded-[1px] outline outline-1 outline-border"
            style={{ left: box.x, top: box.y, width: box.width, height: box.height }} />
          <div
            title="Drag to resize"
            className="absolute flex w-3 cursor-ew-resize touch-none items-center justify-center rounded-sm hover:bg-accent"
            style={{ left: box.x + box.width + 3, top: box.y, height: box.height }}
            onPointerDown={drag('x')}>
            <div className="h-8 w-1 rounded-full bg-muted-foreground/50" />
          </div>
          <div
            title="Drag to resize"
            className="absolute flex h-3 cursor-ns-resize touch-none items-center justify-center rounded-sm hover:bg-accent"
            style={{ left: box.x, top: box.y + box.height + 3, width: box.width }}
            onPointerDown={drag('y')}>
            <div className="h-1 w-8 rounded-full bg-muted-foreground/50" />
          </div>
          <div
            title="Drag to resize"
            className="absolute size-3 cursor-nwse-resize touch-none rounded-sm hover:bg-accent"
            style={{ left: box.x + box.width + 3, top: box.y + box.height + 3 }}
            onPointerDown={drag('xy')} />
        </div>
      )}
    </div>
  );
}

function Stage({ tab, showing }) {
  const s = useBrowser(tab);
  if (!showing) return null;
  if (s.error) return <PageError tab={tab} error={s.error} />;
  return s.live ? <DeviceFrame tab={tab} showing={showing} /> : <Placeholder tab={tab} />;
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
          <Tip label="Close drawer (Ctrl+Shift+J)">
            <Button
              variant="ghost"
              size="icon"
              className={ICON_BUTTON}
              onClick={() => hideDrawer(tab)}>
              <ChevronDownIcon />
            </Button>
          </Tip>
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

function LoadingBar({ tab }) {
  const s = useBrowser(tab);
  return (
    <div
      aria-hidden
      data-loading={s.loading ? '' : undefined}
      className="preview-loading-progress pointer-events-none absolute right-0 bottom-0 left-0 z-10 h-0.5 origin-left rounded-r-full bg-primary" />
  );
}

function Toolbar({ tab, showing }) {
  const s = useBrowser(tab);
  const errors = consoleErrors(tab);

  const onRefresh = () => {
    if (s.loading) go('stop', tab);
    else go('reload', tab);
  };

  return (
    <div className="relative flex h-10 shrink-0 items-center gap-1 border-b border-border/60 px-2" hidden={!showing || undefined}>
      <div className="flex items-center gap-0.5" role="group" aria-label="Navigation">
        <Tip label="Back">
          <Button variant="ghost" size="icon" className={ICON_BUTTON} disabled={!s.canGoBack} onClick={() => go('back', tab)}>
            <ArrowLeftIcon />
          </Button>
        </Tip>
        <Tip label="Forward">
          <Button variant="ghost" size="icon" className={ICON_BUTTON} disabled={!s.canGoForward} onClick={() => go('forward', tab)}>
            <ArrowRightIcon />
          </Button>
        </Tip>
        <Tip label={s.loading ? 'Stop' : 'Reload'}>
          <Button variant="ghost" size="icon" className={ICON_BUTTON} onClick={onRefresh}>
            <RotateCwIcon className={s.loading ? 'animate-spin' : undefined} />
          </Button>
        </Tip>
      </div>

      <div className="min-w-0 flex-1"><AddressBar tab={tab} showing={showing} /></div>

      {errors > 0 && (
        <Tip label="Console errors">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-destructive"
            onClick={() => showDrawer('console', tab)}>
            <TriangleAlertIcon />
            {errors}
          </Button>
        </Tip>
      )}

      <PickButton tab={tab} />
      <ResponsiveButton tab={tab} />
      <PaneMenu tab={tab} />
      <LoadingBar tab={tab} />
    </div>
  );
}

// -------------------------------------------------------------------- pane

export default function BrowserView() {
  useSyncExternalStore(subscribeBrowser, getBrowserVersion, getBrowserVersion);
  useLayout();
  const shown = onScreen();
  const open = previews();

  return (
    <div className="flex h-full min-h-0 flex-col" hidden={!shown || undefined}>
      {open.map(({ tab }) => <Toolbar key={tab} tab={tab} showing={tab === shown} />)}
      {open.map(({ tab }) => <DeviceBar key={tab} tab={tab} showing={tab === shown} />)}

      <div className="relative min-h-0 flex-1">
        <div id="paneslot" className="absolute inset-0" />
        {open.map(({ tab }) => <Stage key={tab} tab={tab} showing={tab === shown} />)}
      </div>

      {open.map(({ tab }) => <Drawer key={tab} tab={tab} showing={tab === shown} />)}
    </div>
  );
}
