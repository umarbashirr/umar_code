/* The app's own strip, under the window frame. What the agent last did in the
   preview, who is driving it, the three views the right column can show, and
   the switches for the terminal panel and the theme.

   Every button here says what it does with `title` rather than a Tooltip. The
   preview is a native view the window paints on top of this document, so a
   tooltip opening over the right column opens behind the page; a native tooltip
   is drawn by the desktop and lands on top. */
import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  CodeXmlIcon,
  MoonIcon,
  PanelBottomIcon,
  PanelLeftIcon,
  RotateCwIcon,
  SunIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Separator } from '@/components/ui/separator';
import { useTheme } from '@/hooks/use-theme';
import { runCommand, toggleTheme } from '../../app.js';
import { onProject, project } from '../../project.js';
import {
  chosenEditor,
  editors,
  getEditorsVersion,
  loadEditors,
  openEditor,
  subscribeEditors,
} from './editors-store';
import { useFocusedDir, useLayout, usePaneCover, VIEW_KINDS } from './Shell';
import { activeTab, getTabsVersion, KINDS, subscribeTabs } from './tabs-store';

const ICON_BUTTON = 'size-7 rounded-md text-muted-foreground';

// -------------------------------------------------------------------- theme

function ThemeButton() {
  const { pref, resolved } = useTheme();
  const title = pref === 'system'
    ? `Following the system (${resolved}). Click to pin the other one`
    : resolved === 'dark' ? 'Switch to light' : 'Switch to dark';

  return (
    <Button variant="ghost" size="icon" className={ICON_BUTTON} title={title} onClick={toggleTheme}>
      {resolved === 'dark' ? <MoonIcon /> : <SunIcon />}
    </Button>
  );
}

// ----------------------------------------------------------------- activity

/* What the agent last did in the preview, for a couple of seconds. It is a
   statement of fact rather than something to click, so it fades rather than
   sitting there. */
function Activity() {
  const [text, setText] = useState('');

  useEffect(() => {
    let timer;
    const off = window.tandem.agent.onActivity(({ tool, args }) => {
      const detail = args?.url || args?.target || args?.ref || args?.selector || args?.key || args?.text || '';
      setText(`${tool}${detail ? ` ${String(detail).slice(0, 40)}` : ''}`);
      clearTimeout(timer);
      timer = setTimeout(() => setText(''), 1800);
    });
    return () => { off?.(); clearTimeout(timer); };
  }, []);

  return (
    <Badge
      variant="secondary"
      data-live={text ? '' : undefined}
      title="What the agent last did in the preview"
      className="max-w-[38ch] -translate-y-0.5 truncate rounded-full font-mono text-[11px] font-normal opacity-0 transition-[opacity,transform] duration-200 data-[live]:translate-y-0 data-[live]:opacity-100">
      {text}
    </Badge>
  );
}

// ------------------------------------------------------------------- driver

/* One page, several agents that want it. The chip says who has it so a page
   changing under you is explained rather than mysterious, and clicking takes
   the page back: the next agent to ask waits for you instead.

   A lease guards one page and a folder can have several previews open, so this
   speaks for the tab in the box and for nothing else. Two agents driving two
   previews in the same folder is an ordinary thing now, and the one you cannot
   see is not your problem. With the tree or the diff in front there is no page
   to take back, so there is nothing to say. */
function Driver() {
  const [holder, setHolder] = useState(null);
  useSyncExternalStore(subscribeTabs, getTabsVersion, getTabsVersion);
  const dir = useFocusedDir();
  const shown = activeTab(dir);
  const tab = shown?.kind === 'browser' ? shown.id : null;

  useEffect(() => {
    setHolder(null);
    if (!tab) return undefined;
    const apply = (msg) => {
      if (msg?.tab && msg.tab !== tab) return;
      const h = msg?.holder;
      const mine = !h || h.id === 'human' || String(h.id).startsWith('main:');
      setHolder(mine ? null : h);
    };
    const off = window.tandem.browser.onDriver?.(apply);
    window.tandem.browser.driver?.(tab).then(apply).catch(() => {});
    return () => off?.();
  }, [tab]);

  if (!holder) return null;

  return (
    <Button
      variant="outline"
      size="sm"
      title="This agent is driving the preview. Click to take it back."
      className="h-auto max-w-[30ch] rounded-full border-ring/30 px-[9px] py-[3px] font-mono text-[11px] font-normal"
      onClick={() => { window.tandem.browser.seize?.(tab); setHolder(null); }}>
      <span className="size-1.5 shrink-0 rounded-full bg-[hsl(var(--success))] motion-safe:animate-pulse" />
      <span className="truncate">{holder.label} is driving</span>
    </Button>
  );
}

// --------------------------------------------------------------- the views

/* The preview, the files and the changes. These were a toggle group while the
   column held one view at a time: the pressed button was the answer to what am
   I looking at, and pressing it again put the column away.

   The column is a strip of tabs now and there is no single answer. A folder can
   have three previews and a diff, so a pressed Browser would be a quarter true,
   and nothing here can say which tab is in front as well as the strip itself
   says it. They are three plain buttons that each open a tab, and the strip is
   left to do the reporting.

   They stay in the toolbar rather than moving into the strip's plus, because
   the strip is not on screen when the column is shut and because these are
   where you find out that the three have shortcuts. */
function ViewStrip() {
  const { changesCount } = useLayout();

  return (
    <ButtonGroup>
      {KINDS.map((kind) => {
        const { icon: Icon, label, command, hint } = VIEW_KINDS[kind];
        return (
          <Button key={kind} variant="outline" size="sm" title={hint} onClick={() => runCommand(command)}>
            <Icon />
            {label}
            {/* A glance at the count says whether the agent has been writing. It
                is only there once the view has read the folder at least once, so
                a window that never opens this tab never runs git. */}
            {kind === 'changes' && changesCount > 0 && (
              <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">{changesCount}</Badge>
            )}
          </Button>
        );
      })}
    </ButtonGroup>
  );
}

// ------------------------------------------------------------------ open in

function useEditors() {
  useSyncExternalStore(subscribeEditors, getEditorsVersion, getEditorsVersion);
  useEffect(() => { loadEditors(); }, []);
  return editors;
}

/* Nothing installed and no folder open are different reasons to be quiet, and
   both end with the button not being there. Once an editor is picked the button
   wears that editor's own icon, which says what it does better than any label
   would fit. */
function OpenIn({ folder }) {
  const list = useEditors().list;
  const [open, setOpen] = useState(false);
  const pick = chosenEditor();
  usePaneCover(open);

  if (!list.length || !folder.chosen) return null;

  const title = pick
    ? `Open this folder in ${pick.name} (right-click for the others)`
    : 'Open this folder in an editor';

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      {/* A left click on a button that has never been used has nothing to open,
          so it asks. After that it just opens, the way the tab it sits next to
          does. */}
      <DropdownMenuTrigger asChild>
        <Button
            variant="ghost"
            size="icon"
            className={ICON_BUTTON}
            title={title}
            onClick={(e) => {
              if (!pick || e.altKey) return;
              e.preventDefault();
              openEditor(pick.id);
            }}
            onContextMenu={(e) => { e.preventDefault(); setOpen(true); }}>
          {pick?.icon ? <img src={pick.icon} alt="" className="size-4 rounded-xs" /> : <CodeXmlIcon />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          {list.map((e) => (
            <DropdownMenuItem key={e.id} onSelect={() => openEditor(e.id)}>
              {e.icon ? <img src={e.icon} alt="" className="size-4 rounded-xs" /> : <CodeXmlIcon />}
              <span className="truncate">{e.name}</span>
              <span className="ml-auto font-mono text-[10.5px] text-muted-foreground">{e.bin}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onSelect={() => loadEditors({ fresh: true })}>
            <RotateCwIcon />
            Look again
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// -------------------------------------------------------------------- strip

export default function Toolbar() {
  const { panelOpen } = useLayout();
  const [, bump] = useState(0);
  useEffect(() => onProject(() => bump((n) => n + 1)), []);

  return (
    <div id="toolbar">
      <Button
        variant="ghost"
        size="icon"
        className={ICON_BUTTON}
        title="Sessions (Ctrl+Shift+S)"
        onClick={() => runCommand('rail')}>
        <PanelLeftIcon />
      </Button>

      <span className="flex-1" />

      <Activity />
      <Driver />
      <ViewStrip />

      <Separator orientation="vertical" className="mx-0.5 !h-[18px]" />

      <OpenIn folder={project} />

      <Button
        variant="ghost"
        size="icon"
        data-on={panelOpen ? '' : undefined}
        className={`${ICON_BUTTON} data-[on]:bg-secondary data-[on]:text-foreground`}
        title="Terminal panel (Ctrl+`)"
        onClick={() => runCommand('terminal')}>
        <PanelBottomIcon />
      </Button>

      <ThemeButton />
    </div>
  );
}
