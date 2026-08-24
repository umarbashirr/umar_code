import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpIcon, CameraIcon, ChevronDownIcon, CrosshairIcon, FileIcon, FolderIcon,
  GitBranchIcon, PaperclipIcon, PlugZapIcon, PlusIcon, SquareIcon, XIcon,
} from 'lucide-react';

import {
  PromptInput, PromptInputBody, PromptInputHeader, PromptInputTextarea, PromptInputFooter,
  PromptInputTools, PromptInputSubmit,
  PromptInputSelect, PromptInputSelectTrigger, PromptInputSelectContent,
  PromptInputSelectItem, PromptInputSelectValue,
} from '@/components/ai-elements/prompt-input';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { Badge } from '@/components/ui/badge';
import { AttachmentPreview } from '@/components/attachment-preview';
import { CatalogDialog } from '@/components/catalog-dialog';
import { SlashMenu, matchSkills, slashQuery } from '@/components/slash-menu';
import { cn } from '@/lib/utils';
import { useProject, shortPath } from '../useProject';
import { spoken } from '../useAgent';
import { fromBlob, fromPaths, sizeLabel, toAttachments } from '@/lib/attachments';

// How freely the agent may act, loosest first, which is also the order Shift+Tab
// walks. Four of these are the SDK's own permission modes; Ask, Debug and Auto
// are this app's, enforced in main/modes.js, which holds the matching ids.
export const MODES = [
  ['plan', 'Plan', 'Work out an approach and stop before touching anything'],
  ['ask', 'Ask', 'Asks before writing a file or running a command'],
  ['debug', 'Debug', 'Reproduce and isolate before fixing. Asks like Ask does'],
  ['auto', 'Auto', 'Edits and ordinary commands run. Stops on anything destructive'],
  ['acceptEdits', 'Accept edits', 'Edits run without asking. Commands still ask'],
  ['always', 'Ask confirmation always', 'Asks before every tool, reads included'],
  ['bypass', 'Full bypass', 'Nothing asks. Nothing is checked'],
];

const MODE_LABEL = Object.fromEntries(MODES.map(([v, label]) => [v, label]));

const cleanModelName = (m) =>
  (m.displayName || m.value).replace(/\s*\((recommended|default)\)\s*$/i, '');

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

// One chip per attached thing. A picture shows itself, because a filename is a
// poor way to notice you attached the wrong screenshot, and the whole chip
// opens the full-size preview for the same reason.
function Attachment({ item, onOpen, onRemove }) {
  const remove = (
    <button type="button" onClick={onRemove} className="opacity-60 hover:opacity-100" title="Remove">
      <XIcon className="size-3" />
    </button>
  );

  // The chip body, not the chip, is the button: the remove control sits beside
  // it rather than inside it.
  const open = (className, children, title) => (
    <button type="button" onClick={onOpen} title={title} className={cn('flex min-w-0 items-center gap-1.5', className)}>
      {children}
    </button>
  );

  if (item.kind === 'image') {
    return (
      <span className="flex h-8 items-center gap-1.5 rounded-md border border-border bg-secondary/60 py-0 pr-2 pl-0 text-xs">
        {open(
          'h-8',
          <>
            <img src={item.preview} alt="" className="h-8 w-8 rounded-l-md border-border border-r object-cover" />
            <span className="max-w-[16ch] truncate">{item.name}</span>
          </>,
          `${item.name} · ${item.width}×${item.height} · ${sizeLabel(item.size)} · click to see it`,
        )}
        {remove}
      </span>
    );
  }

  if (item.kind === 'error') {
    return (
      <Badge variant="secondary" className="gap-1 font-normal text-destructive">
        {open('', <>{item.name}: {item.error}</>, 'Click for the details')}
        {remove}
      </Badge>
    );
  }

  if (item.kind === 'file') {
    return (
      <Badge variant="secondary" className="gap-1 font-normal">
        {open(
          '',
          <>
            <FileIcon className="size-3 opacity-70" />
            <span className="max-w-[22ch] truncate">{item.name}</span>
            <span className="text-muted-foreground">{sizeLabel(item.size)}</span>
          </>,
          item.note ? `${item.path} — ${item.note}` : `${item.path} · click for the details`,
        )}
        {remove}
      </Badge>
    );
  }

  const { hit } = item;
  return (
    <Badge variant="secondary" className="gap-1 font-normal">
      {open(
        '',
        <>{hit.role === 'generic' ? hit.tag : hit.role} {(hit.name || hit.text || '').slice(0, 28)}</>,
        'Click for the selector and the box it was in',
      )}
      {remove}
    </Badge>
  );
}

export function Composer({ agent, catalog, text, setText, attachments, setAttachments, onSubmit }) {
  const project = useProject();
  const [showCatalog, setShowCatalog] = useState(false);
  // Which attachment the preview dialog is showing, by id, so removing it while
  // it is up closes the dialog instead of freezing a copy of it.
  const [previewing, setPreviewing] = useState(null);
  // A slash menu that has been dismissed stays dismissed until the box changes
  // again, so Escape means Escape.
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef(null);

  // Dropping onto the composer is the gesture people try first, so the whole
  // box is the target and it says so while something is over it.
  const [dropping, setDropping] = useState(false);

  const attach = useCallback(async (incoming) => {
    if (!incoming.length) return;
    setAttachments((list) => [...list, ...incoming]);
  }, [setAttachments]);

  const drop = useCallback((id) => {
    setAttachments((list) => list.filter((x) => x.id !== id));
  }, [setAttachments]);

  const pickFiles = useCallback(async () => {
    const res = await window.pba.attach.pick();
    if (res?.canceled) return;
    attach(await toAttachments(res.files || []));
  }, [attach]);

  const onDrop = useCallback(async (e) => {
    e.preventDefault();
    setDropping(false);
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    // A real file has a path and stays on disk. Anything dragged out of a web
    // page arrives as bytes with no file behind it, so it gets written to one.
    const paths = files.map((f) => window.pba.attach.pathFor(f)).filter(Boolean);
    if (paths.length === files.length) return attach(await fromPaths(paths));
    for (const f of files) {
      const path = window.pba.attach.pathFor(f);
      attach(path ? await fromPaths([path]) : await fromBlob(f, f.name));
    }
  }, [attach]);

  const onPaste = useCallback(async (e) => {
    const items = [...(e.clipboardData?.items || [])].filter((i) => i.kind === 'file');
    if (!items.length) return;
    // Only swallow the paste when it really was a file; a copied screenshot on
    // Linux often carries the text form as well.
    e.preventDefault();
    for (const it of items) {
      const file = it.getAsFile();
      if (!file) continue;
      const path = window.pba.attach.pathFor(file);
      attach(path ? await fromPaths([path]) : await fromBlob(file, file.name || 'pasted image'));
    }
  }, [attach]);

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

  // Shift+Tab walks the list and wraps. Full bypass sits at the far end, so
  // reaching it from Plan takes six deliberate presses rather than one.
  const cycleMode = useCallback(() => {
    const i = MODES.findIndex(([v]) => v === agent.mode);
    agent.changeMode(MODES[(i + 1) % MODES.length][0]);
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
    if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); cycleMode(); }
  }, [menu, matches, cursor, pick, cycleMode]);

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
            {MODES.map(([value, label, note]) => (
              <PromptInputSelectItem key={value} value={value} title={note}>{label}</PromptInputSelectItem>
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
      <AttachmentPreview
        item={attachments.find((a) => a.id === previewing) || null}
        onOpenChange={(open) => { if (!open) setPreviewing(null); }} />

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
                <span className="min-w-0 flex-1 truncate text-xs">{spoken(m.text)}</span>
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
      <div
        className="relative"
        ref={box}
        onDragOver={(e) => { e.preventDefault(); setDropping(true); }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDropping(false); }}
        onDrop={onDrop}>
        {menu && <SlashMenu items={matches} active={cursor} onActive={setActive} onPick={pick} />}
        {dropping && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl border-2 border-primary/60 border-dashed bg-background/80 text-sm">
            Drop to attach
          </div>
        )}
        <PromptInput
          onSubmit={onSubmit}
          className="[&_[data-slot=input-group]]:rounded-2xl [&_[data-slot=input-group]]:shadow-sm">
          <PromptInputBody>
            {/* Inside the box, above what you are typing: an attachment belongs
                to this message, so it sits in the same container as the text. */}
            {attachments.length > 0 && (
              <PromptInputHeader className="gap-1.5 px-4 pt-3 pb-0">
                {attachments.map((a) => (
                  <Attachment
                    key={a.id}
                    item={a}
                    onOpen={() => setPreviewing(a.id)}
                    onRemove={() => drop(a.id)} />
                ))}
              </PromptInputHeader>
            )}
            <PromptInputTextarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              placeholder={agent.busy
                ? 'Working. Enter parks this, Enter again sends it into this turn'
                : 'Plan, build, or ask about this project'}
              className={cn('min-h-[76px] px-4 text-[13.5px]', attachments.length > 0 ? 'pt-2' : 'pt-3.5')} />
          </PromptInputBody>

          <PromptInputFooter className="px-3 pb-3">
            <PromptInputTools className="gap-1.5">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    title="Attach a file, or add something from the preview"
                    className="flex size-8 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
                    <PlusIcon className="size-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onSelect={pickFiles}>
                    <PaperclipIcon className="size-4 text-muted-foreground" />
                    Attach files…
                    <span className="ml-auto text-muted-foreground text-xs">or drop them here</span>
                  </DropdownMenuItem>
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
        <Chip
          active={agent.mode !== 'ask'}
          shortcut="⇧Tab"
          onClick={cycleMode}
          title={MODES.find(([v]) => v === agent.mode)?.[2]}>
          {MODE_LABEL[agent.mode] || agent.mode}
        </Chip>
      </div>
    </div>
  );
}
