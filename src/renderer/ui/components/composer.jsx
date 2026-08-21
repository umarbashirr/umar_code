import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpIcon, CameraIcon, ChevronDownIcon, CrosshairIcon, FolderIcon,
  GitBranchIcon, PlugZapIcon, PlusIcon, SquareIcon, XIcon,
} from 'lucide-react';

import {
  PromptInput, PromptInputBody, PromptInputTextarea, PromptInputFooter,
  PromptInputTools, PromptInputSubmit,
  PromptInputSelect, PromptInputSelectTrigger, PromptInputSelectContent,
  PromptInputSelectItem, PromptInputSelectValue,
} from '@/components/ai-elements/prompt-input';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { Badge } from '@/components/ui/badge';
import { CatalogDialog } from '@/components/catalog-dialog';
import { SlashMenu, matchSkills, slashQuery } from '@/components/slash-menu';
import { cn } from '@/lib/utils';
import { useProject, shortPath } from '../useProject';
// The panes are the vanilla half's business; this is the one call into it.
import { runCommand } from '../../app.js';

export const MODES = [
  ['default', 'Ask first'],
  ['auto', 'Auto'],
  ['acceptEdits', 'Accept edits'],
  ['plan', 'Plan only'],
  ['bypassPermissions', 'Yolo'],
];

const cleanModelName = (m) =>
  (m.displayName || m.value).replace(/\s*\((recommended|default)\)\s*$/i, '');

// A queued message may start with the element-picker preamble; the chip shows
// what the human actually typed.
const queueLabel = (t) =>
  (t.startsWith('[preview element]') ? t.slice(t.lastIndexOf('\n\n') + 2) : t);

function Pill({ className, children, ...props }) {
  return (
    <button
      type="button"
      className={cn(
        'flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-muted-foreground text-xs',
        'transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none',
        className,
      )}
      {...props}>
      {children}
    </button>
  );
}

function Chip({ active, shortcut, children, ...props }) {
  return (
    <button
      type="button"
      className={cn(
        'flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors',
        active
          ? 'border-transparent bg-primary text-primary-foreground'
          : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
      {...props}>
      {children}
      {shortcut && (
        <span className={cn('font-mono text-[10px]', active ? 'opacity-70' : 'text-muted-foreground/70')}>
          {shortcut}
        </span>
      )}
    </button>
  );
}

export function Composer({ agent, catalog, text, setText, attachments, setAttachments, onSubmit }) {
  const project = useProject();
  const [showCatalog, setShowCatalog] = useState(false);
  // A slash menu that has been dismissed stays dismissed until the box changes
  // again, so Escape means Escape.
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef(null);

  const query = slashQuery(text);
  const matches = useMemo(
    () => (query === null ? [] : matchSkills(catalog.skills, query)),
    [catalog.skills, query],
  );
  const menu = !dismissed && matches.length > 0;
  // The list can shrink on the same keystroke that moves the cursor, one render
  // before the reset below lands, so clamp rather than index past the end.
  const cursor = Math.min(active, matches.length - 1);

  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => { if (query === null) setDismissed(false); }, [query]);

  // Picking a skill writes the slash line and leaves the caret after it, ready
  // for whatever the skill takes as an argument.
  const pick = useCallback((skill) => {
    if (!skill) return;
    setText(`/${skill.name} `);
    setDismissed(true);
    box.current?.querySelector('textarea')?.focus();
  }, [setText]);

  // Shift+Tab drops into planning and back out again, which is the switch worth
  // having under a key. The other modes are a deliberate trip to the menu: none
  // of them should be one stray keystroke away.
  const togglePlan = useCallback(() => {
    agent.changeMode(agent.mode === 'plan' ? 'default' : 'plan');
  }, [agent]);

  // Stopping the turn empties the queue. The parked text goes back into the
  // box, ahead of whatever is already typed there, rather than vanishing.
  const stop = useCallback(async () => {
    const parked = await agent.interrupt();
    if (parked?.length) setText((t) => [...parked, t].filter(Boolean).join('\n\n'));
  }, [agent, setText]);

  const onKeyDown = useCallback((e) => {
    if (menu) {
      if (e.key === 'ArrowDown') { e.preventDefault(); return setActive((i) => (i + 1) % matches.length); }
      if (e.key === 'ArrowUp') { e.preventDefault(); return setActive((i) => (i - 1 + matches.length) % matches.length); }
      if (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey)) { e.preventDefault(); return pick(matches[cursor]); }
      if (e.key === 'Escape') { e.preventDefault(); return setDismissed(true); }
    }
    if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); togglePlan(); }
  }, [menu, matches, cursor, pick, togglePlan]);

  return (
    <div className="mx-auto w-full max-w-3xl flex-none px-4 pb-4">
      {/* What the agent is pointed at: the folder, the branch, and how freely it
          is allowed to act there. */}
      <div className="mb-1.5 flex items-center gap-0.5 px-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Pill className="font-medium text-foreground/80">
              <FolderIcon className="size-3.5 shrink-0" />
              <span className="truncate">{project.name || 'no folder'}</span>
              <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
            </Pill>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-w-[380px]">
            <DropdownMenuLabel className="font-normal text-muted-foreground text-xs">
              {shortPath(project.dir, project.home)}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => window.pba.project.open({})}>Open folder…</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => window.pba.project.open({ newWindow: true })}>
              Open folder in new window…
            </DropdownMenuItem>
            {project.recents.length > 0 && <DropdownMenuSeparator />}
            {project.recents.slice(0, 6).map((r) => (
              <DropdownMenuItem key={r.path} onSelect={() => window.pba.project.open({ dir: r.path })}>
                <FolderIcon className="size-3.5 text-muted-foreground" />
                <span className="truncate">{r.name}</span>
                <span className="ml-auto truncate text-muted-foreground text-xs" dir="rtl">
                  {shortPath(r.path, project.home)}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {project.branch && (
          <Pill
            disabled
            className="cursor-default"
            title={`${shortPath(project.dir, project.home)} is on ${project.branch}`}>
            <GitBranchIcon className="size-3.5 shrink-0" />
            <span className="truncate">{project.branch}</span>
          </Pill>
        )}

        <PromptInputSelect value={agent.mode} onValueChange={agent.changeMode}>
          <PromptInputSelectTrigger className="h-7 gap-1.5 rounded-md px-2 font-normal text-xs">
            <PromptInputSelectValue />
          </PromptInputSelectTrigger>
          <PromptInputSelectContent>
            {MODES.map(([value, label]) => (
              <PromptInputSelectItem key={value} value={value}>{label}</PromptInputSelectItem>
            ))}
          </PromptInputSelectContent>
        </PromptInputSelect>

        <Pill
          onClick={() => setShowCatalog(true)}
          title="Skills and MCP servers this folder offers the agent">
          <PlugZapIcon className="size-3.5 shrink-0" />
          <span>{catalog.skills.length} skills</span>
          {catalog.mcp.length > 0 && <span>· {catalog.mcp.length} MCP</span>}
        </Pill>
      </div>

      <CatalogDialog catalog={catalog} open={showCatalog} onOpenChange={setShowCatalog} />

      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5 px-1">
          {attachments.map((a) => (
            <Badge key={a.id} variant="secondary" className="gap-1 font-normal">
              {a.hit.role === 'generic' ? a.hit.tag : a.hit.role}{' '}
              {(a.hit.name || a.hit.text || '').slice(0, 28)}
              <button
                type="button"
                onClick={() => setAttachments((list) => list.filter((x) => x !== a))}
                className="opacity-60 hover:opacity-100">
                <XIcon className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}

      {agent.queued.length > 0 && (
        <div className="mb-2 px-1">
          <div className="mb-1 flex items-center gap-2 text-muted-foreground text-xs">
            <span>{agent.queued.length} queued</span>
            <span className="opacity-70">
              {agent.busy ? 'press Enter on an empty box to send now' : 'sending…'}
            </span>
          </div>
          <div className="space-y-1">
            {agent.queued.map((m, i) => (
              <div
                key={m.id}
                className="flex items-center gap-2 rounded-md border border-border border-dashed px-2.5 py-1.5">
                <span className="font-mono text-muted-foreground text-[10px]">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate text-xs">{queueLabel(m.text)}</span>
                <button
                  type="button"
                  title="Drop this one"
                  onClick={() => agent.unqueue(m.id)}
                  className="text-muted-foreground opacity-60 hover:opacity-100">
                  <XIcon className="size-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* PromptInput puts className on the form, so the box itself is reached
          through its slot. The wrapper is what the slash menu hangs off. */}
      <div className="relative" ref={box}>
        {menu && <SlashMenu items={matches} active={cursor} onActive={setActive} onPick={pick} />}
        <PromptInput
          onSubmit={onSubmit}
          className="[&_[data-slot=input-group]]:rounded-2xl [&_[data-slot=input-group]]:shadow-sm">
          <PromptInputBody>
            <PromptInputTextarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={agent.busy
                ? 'Working. Enter parks this, Enter again sends it into this turn'
                : 'Plan, build, or ask about this project'}
              className="min-h-[76px] px-4 pt-3.5 text-[13.5px]" />
          </PromptInputBody>

          <PromptInputFooter className="px-3 pb-3">
            <PromptInputTools className="gap-1.5">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    title="Add something from the preview"
                    className="flex size-8 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
                    <PlusIcon className="size-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onSelect={() => window.pickElement?.()}>
                    <CrosshairIcon className="size-4 text-muted-foreground" />
                    Point at an element
                    <span className="ml-auto font-mono text-muted-foreground text-xs">^⇧E</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => window.pba.browser.action('screenshot', { fullPage: true })}>
                    <CameraIcon className="size-4 text-muted-foreground" />
                    Screenshot the page
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              {agent.models.length === 0 && agent.driver?.message && (
                <span className="px-1 text-muted-foreground text-xs" title={agent.driver.message}>
                  {agent.driver.installed ? 'CLI unavailable' : 'Claude CLI not installed'}
                </span>
              )}

              {agent.models.length > 0 && (
                <PromptInputSelect value={agent.model} onValueChange={agent.changeModel}>
                  <PromptInputSelectTrigger className="h-7 gap-1.5 rounded-md px-2 text-xs">
                    <PromptInputSelectValue />
                  </PromptInputSelectTrigger>
                  <PromptInputSelectContent>
                    {agent.models.map((m) => (
                      <PromptInputSelectItem key={m.value} value={m.value}>{cleanModelName(m)}</PromptInputSelectItem>
                    ))}
                  </PromptInputSelectContent>
                </PromptInputSelect>
              )}
            </PromptInputTools>

            <PromptInputSubmit
              className="size-9 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-30"
              disabled={!agent.busy && !text.trim()}
              status={agent.busy ? 'streaming' : undefined}
              onClick={agent.busy ? (e) => { e.preventDefault(); stop(); } : undefined}>
              {agent.busy ? <SquareIcon className="size-3.5 fill-current" /> : <ArrowUpIcon className="size-4" />}
            </PromptInputSubmit>
          </PromptInputFooter>
        </PromptInput>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5 px-1">
        <Chip active={agent.mode === 'plan'} shortcut="⇧Tab" onClick={togglePlan} title="Work out an approach before touching anything">
          Plan first
        </Chip>
        <Chip shortcut="^⇧E" onClick={() => window.pickElement?.()}>Point at element</Chip>
        <Chip shortcut="^⇧B" onClick={() => runCommand('preview')}>Show preview</Chip>
      </div>
    </div>
  );
}
