import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpIcon, BrainIcon, CameraIcon, CheckIcon, ChevronDownIcon, CrosshairIcon, FileIcon,
  FolderIcon, GaugeIcon, GitBranchIcon, PaperclipIcon, PlugZapIcon, PlusIcon, SquareIcon, XIcon,
} from 'lucide-react';

import {
  PromptInput, PromptInputBody, PromptInputHeader, PromptInputFooter,
  PromptInputTools, PromptInputSubmit,
  PromptInputSelect, PromptInputSelectTrigger, PromptInputSelectContent,
  PromptInputSelectItem, PromptInputSelectValue,
} from '@/components/ai-elements/prompt-input';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator,
  DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent,
} from '@/components/ui/dropdown-menu';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AttachmentPreview } from '@/components/attachment-preview';
import { CatalogDialog } from '@/components/catalog-dialog';
import { MentionMenu, fileRows, skillRows } from '@/components/mention-menu';
import { TokenInput } from '@/components/token-input';
import { TokenText } from '@/components/token-text';
import { UsageMeter } from '@/components/usage-meter';
import { tokenFor } from '@/lib/tokens';
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

// Both CLIs are in one menu, so the top level is who makes the model rather
// than the models themselves. Thirteen names in a flat list is a wall; two
// names that open on hover is a choice you can read in one glance.
/* Anthropic's branding guidance allows "Claude" as a menu label and does not
   allow "Claude Code" as a name inside someone else's product. These head two
   groups of models, so the vendor name is the accurate word anyway, and it
   reads level with ChatGPT rather than naming one CLI and one company. */
const PROVIDER_LABEL = { claude: 'Claude', codex: 'ChatGPT' };

// Where to get each one, for the row that says it is missing.
const INSTALL = {
  claude: 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
};

/* One row per CLI, installed or not. Models keep the order main sent them in,
   which puts the running CLI first; a CLI with nothing behind it still gets a
   row, locked, so a missing install reads as something to fix rather than as a
   provider Tandem never supported. */
function byProvider(models, providers) {
  const out = [];
  for (const m of models) {
    const id = m.provider || 'claude';
    const last = out[out.length - 1];
    if (last?.id === id) last.rows.push(m);
    else out.push({ id, rows: [m] });
  }
  for (const p of providers || []) {
    if (!out.some((g) => g.id === p.id)) out.push({ id: p.id, rows: [], missing: p, locked: true });
  }
  return out;
}

function ModelItems({ rows, current, onPick }) {
  return rows.map((m) => (
    <DropdownMenuItem key={m.value} onSelect={() => onPick(m.value)}>
      {cleanModelName(m)}
      {m.value === current && <CheckIcon className="ml-auto size-3.5" />}
    </DropdownMenuItem>
  ));
}

function ModelPicker({ agent }) {
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState('');
  const groups = useMemo(() => byProvider(agent.models, agent.providers), [agent.models, agent.providers]);
  // With one CLI here and one missing there are still two rows, so the nesting
  // stays: flattening would put the models and the locked row side by side.
  const nested = groups.length > 1;

  const done = (value) => {
    setTyping(false);
    setDraft('');
    if (value) agent.changeModel(value);
  };

  if (typing) {
    return (
      <Input
        autoFocus
        value={draft}
        placeholder="model name, then Enter"
        onChange={(e) => setDraft(e.target.value)}
        // Clicking away is not a decision. Nothing switches until Enter, so a
        // half-typed name cannot become the model every chat runs on.
        onBlur={() => { setTyping(false); setDraft(''); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); done(draft.trim()); }
          if (e.key === 'Escape') { e.preventDefault(); setTyping(false); setDraft(''); }
        }}
        className="h-7 w-56 px-2 text-xs" />
    );
  }

  // A model the list has not heard of still has to name itself on the trigger:
  // a proxy routes names no probe here can see, and a chat resumed on one would
  // otherwise leave the button blank.
  const row = agent.models.find((m) => m.value === agent.model);
  const label = row ? cleanModelName(row) : agent.model || 'Pick a model';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Pill className="rounded-md px-2 font-medium text-xs hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground">
          <span className="min-w-0 truncate">{label}</span>
          <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />
        </Pill>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        {/* One CLI installed means one submenu, and a submenu you have to open
            to reach the only thing inside it is a click charged for nothing. */}
        {groups.map((g) => {
          if (g.locked) {
            return (
              <DropdownMenuItem
                key={g.id}
                disabled
                // A disabled row cannot open anything, so the reason has to be
                // readable without hovering as well as in the tooltip.
                title={`${g.missing?.message || 'Not found on your PATH.'} Install it with: ${INSTALL[g.id] || ''}`}
                className="justify-between gap-6">
                {PROVIDER_LABEL[g.id] || g.id}
                <span className="text-muted-foreground text-xs">not installed</span>
              </DropdownMenuItem>
            );
          }
          if (!nested) {
            return <ModelItems key={g.id} rows={g.rows} current={agent.model} onPick={agent.changeModel} />;
          }
          return (
            <DropdownMenuSub key={g.id}>
              <DropdownMenuSubTrigger>{PROVIDER_LABEL[g.id] || g.id}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-44">
                <ModelItems rows={g.rows} current={agent.model} onPick={agent.changeModel} />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          );
        })}
        <DropdownMenuSeparator />
        {/* A proxy routes whatever names its owner configured, and no probe
            here can be sure it has seen all of them. */}
        <DropdownMenuItem onSelect={() => setTyping(true)}>Type a model name…</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* How hard the model thinks, and how long a window it gets. Both sit next to
   the model because both are about the same choice, and neither was reachable
   before: effort was never passed to the CLI at all, and the long window is a
   second name for a model rather than a setting on it, so the list only ever
   showed whichever half the CLI defaulted to.

   Empty effort means the CLI's own default. It is offered as a level you can
   return to rather than left off the list, because "whatever Claude Code does"
   is a real answer and pinning it to today's default would stop it following. */
function ThinkingPicker({ agent }) {
  if (!agent.efforts?.length) return null;

  return (
    <PromptInputSelect value={agent.effort || 'default'} onValueChange={(v) => agent.changeEffort(v === 'default' ? '' : v)}>
      <PromptInputSelectTrigger className="h-7 min-w-0 gap-1.5 rounded-md px-2 text-xs">
        <BrainIcon className="size-3.5 shrink-0 text-muted-foreground" />
        {/* The brain says what the control is. "Default effort" is the longest
            label down here and the first thing worth losing. */}
        <span className="min-w-0 truncate @max-[300px]/tools:hidden">
          <PromptInputSelectValue />
        </span>
      </PromptInputSelectTrigger>
      <PromptInputSelectContent>
        <PromptInputSelectItem value="default">Default effort</PromptInputSelectItem>
        {agent.efforts.map((level) => (
          <PromptInputSelectItem key={level} value={level}>{`${level} effort`}</PromptInputSelectItem>
        ))}
      </PromptInputSelectContent>
    </PromptInputSelect>
  );
}

function ContextPill({ agent }) {
  const { on, capable } = agent.longContext || {};
  if (!capable) return null;

  return (
    <Pill
      title={on
        ? 'Running the million-token window. Click for the ordinary one.'
        : 'Running the ordinary window. Click for the million-token one.'}
      className={on ? 'text-foreground/80' : undefined}
      onClick={() => agent.changeLongContext(!on)}>
      <GaugeIcon className="size-3.5 shrink-0" />
      {on ? '1M' : '200K'}
    </Pill>
  );
}

function Pill({ className, children, ...props }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className={cn('h-7 min-w-0 gap-1.5 font-normal text-muted-foreground', className)}
      {...props}>
      {children}
    </Button>
  );
}

function Chip({ active, shortcut, children, ...props }) {
  return (
    <Button
      type="button"
      variant={active ? 'default' : 'outline'}
      size="xs"
      className="h-7 gap-1.5 rounded-full px-3 font-normal"
      {...props}>
      {children}
      {shortcut && (
        <span className={cn('font-mono text-[10px]', active ? 'opacity-70' : 'text-muted-foreground/70')}>
          {shortcut}
        </span>
      )}
    </Button>
  );
}

// One chip per attached thing. A picture shows itself, because a filename is a
// poor way to notice you attached the wrong screenshot, and the whole chip
// opens the full-size preview for the same reason.
function Attachment({ item, onOpen, onRemove }) {
  const remove = (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      onClick={onRemove}
      title="Remove"
      className="size-4 text-muted-foreground">
      <XIcon className="size-3" />
    </Button>
  );

  // The chip body, not the chip, is the button: the remove control sits beside
  // it rather than inside it. The padding has to be cleared for the icon case
  // too, or a chip with a file icon in it gains inset the thumbnail cannot sit
  // flush against.
  const open = (className, children, title) => (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      onClick={onOpen}
      title={title}
      className={cn(
        'h-auto min-w-0 justify-start gap-1.5 p-0 font-normal has-[>svg]:p-0',
        className,
      )}>
      {children}
    </Button>
  );

  if (item.kind === 'image') {
    return (
      <span className="flex h-8 items-center gap-1.5 rounded-md border border-border bg-secondary/60 py-0 pr-2 pl-0 text-xs">
        {open(
          'h-8',
          <>
            <img src={item.preview} alt="" className="size-8 rounded-l-md border-border border-r object-cover" />
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
        'min-w-0',
        <>
          <span className="shrink-0">
            {hit.role === 'generic' ? hit.tag : hit.role} {(hit.name || hit.text || '').slice(0, 28)}
          </span>
          {/* Your own words about the thing, on the chip, so the message you
              are about to send says what you meant without opening anything. */}
          {item.note && <span className="min-w-0 truncate text-muted-foreground">— {item.note}</span>}
        </>,
        item.note ? `${hit.css} — ${item.note}` : 'Click for the selector and the box it was in',
      )}
      {remove}
    </Badge>
  );
}

export function Composer({ agent, catalog, text, setText, attachments, setAttachments, onNote, onSubmit }) {
  const window_ = useProject();
  // The folder this chat runs in, which is the one the message about to be typed
  // will land in. Not always the focused folder: reading a chat from another
  // project leaves the window where it was until you click into it.
  const project = window_.projects?.find((p) => p.dir === agent.project) || window_;
  const [showCatalog, setShowCatalog] = useState(false);
  const [previewing, setPreviewing] = useState(null);
  // A menu that has been dismissed stays dismissed until the box changes
  // again, so Escape means Escape.
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  // What the box reports is being typed at the caret, and what to offer for it.
  const [pending, setPending] = useState(null);
  const [rows, setRows] = useState([]);
  const box = useRef(null);
  const input = useRef(null);

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
    const res = await window.tandem.attach.pick();
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
    const paths = files.map((f) => window.tandem.attach.pathFor(f)).filter(Boolean);
    if (paths.length === files.length) return attach(await fromPaths(paths));
    for (const f of files) {
      const path = window.tandem.attach.pathFor(f);
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
      const path = window.tandem.attach.pathFor(file);
      attach(path ? await fromPaths([path]) : await fromBlob(file, file.name || 'pasted image'));
    }
  }, [attach]);

  // The box says what is being typed at the caret, if it is the start of a
  // token: a slash at the head of the message, or an @ anywhere.
  const kind = pending?.kind ?? null;
  const query = pending?.query ?? '';

  // Skills are already in hand. Files come from the index main keeps for the
  // file search box, so this costs a message rather than a walk of the folder,
  // and the last results stay up while the next ones are on their way instead
  // of the list blinking on every keystroke. A bare @ matches everything,
  // which is no help, so the list waits for a character.
  useEffect(() => {
    if (kind === 'skill') { setRows(skillRows(catalog.skills, query)); return undefined; }
    if (kind !== 'path' || !query) { setRows([]); return undefined; }
    let live = true;
    const timer = setTimeout(async () => {
      const res = await window.tandem.files.search(query).catch(() => null);
      if (live) setRows(fileRows((res?.matches || []).slice(0, 40)));
    }, 80);
    return () => { live = false; clearTimeout(timer); };
  }, [kind, query, catalog.skills]);

  const menu = !dismissed && rows.length > 0;
  // The list can shrink on the same keystroke that moves the cursor, one render
  // before the reset below lands, so clamp rather than index past the end.
  const cursor = Math.min(active, rows.length - 1);

  useEffect(() => { setActive(0); }, [kind, query]);
  useEffect(() => { if (!kind) setDismissed(false); }, [kind]);

  // Picking swaps the half-typed name for the badge and leaves the caret after
  // it, ready for whatever the skill takes as an argument.
  const pick = useCallback((item) => {
    if (!item) return;
    input.current?.insert(tokenFor(item.kind, item.raw));
    setDismissed(true);
  }, []);

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
      if (e.key === 'ArrowDown') { e.preventDefault(); return setActive((i) => (i + 1) % rows.length); }
      if (e.key === 'ArrowUp') { e.preventDefault(); return setActive((i) => (i - 1 + rows.length) % rows.length); }
      if (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey)) { e.preventDefault(); return pick(rows[cursor]); }
      if (e.key === 'Escape') { e.preventDefault(); return setDismissed(true); }
    }
    if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); cycleMode(); }
  }, [menu, rows, cursor, pick, cycleMode]);

  return (
    <div className="mx-auto w-full max-w-3xl flex-none px-4 pb-4">
      {/* What the agent is pointed at: the folder, the branch, and how freely it
          is allowed to act there.

          It wraps. Every pill in here is a Button, and shadcn's Button carries
          shrink-0, so in a narrow pane the row could only grow past the edge:
          the branch ended up half cut off and the chat pane grew a horizontal
          scrollbar under everything. A second line costs 28px and is the whole
          row rather than most of it. */}
      <div className="mb-1.5 flex min-w-0 flex-wrap items-center gap-0.5 gap-y-1 px-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Pill className="max-w-full font-medium text-foreground/80">
              <FolderIcon className="size-3.5 shrink-0" />
              <span className="truncate">{project.name || 'no folder'}</span>
              <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
            </Pill>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-w-[380px]">
            <DropdownMenuLabel className="font-normal text-muted-foreground text-xs">
              {shortPath(project.dir, window_.home)}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => window.tandem.project.open({})}>Open folder…</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => window.tandem.project.open({ newWindow: true })}>
              Open folder in new window…
            </DropdownMenuItem>
            {/* The folders already open here. The label on this menu names the
                folder the chat runs in, so picking one has to move the chat and
                not only the window: it used to move the window alone, which left
                the label naming the folder you had just picked your way out of
                and the next message running in it. Nothing starts and nothing
                stops, which is what separates this from opening a folder. */}
            {window_.projects?.length > 1 && <DropdownMenuSeparator />}
            {window_.projects?.length > 1 && window_.projects.map((p) => (
              <DropdownMenuItem
                key={p.dir}
                onSelect={() => { window.tandem.project.focus(p.dir); agent.setProject?.(p.dir); }}>
                <FolderIcon className="size-3.5 text-muted-foreground" />
                <span className="truncate">{p.name}</span>
                {p.dir === project.dir && <CheckIcon className="ml-auto size-3.5 opacity-60" />}
              </DropdownMenuItem>
            ))}
            {window_.recents.length > 0 && <DropdownMenuSeparator />}
            {window_.recents.slice(0, 6).map((r) => (
              <DropdownMenuItem key={r.path} onSelect={() => window.tandem.project.open({ dir: r.path })}>
                <FolderIcon className="size-3.5 text-muted-foreground" />
                <span className="truncate">{r.name}</span>
                <span className="ml-auto truncate text-muted-foreground text-xs" dir="rtl">
                  {shortPath(r.path, window_.home)}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {project.branch && (
          <Pill
            tabIndex={-1}
            className="pointer-events-none"
            title={`${shortPath(project.dir, window_.home)} is on ${project.branch}`}>
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
      {/* Finding it by id rather than holding the object means removing an
          attachment while its dialog is up closes the dialog, instead of
          leaving a frozen copy of something that is gone. */}
      <AttachmentPreview
        item={attachments.find((a) => a.id === previewing) || null}
        onNote={onNote}
        onOpenChange={(open) => { if (!open) setPreviewing(null); }} />

      {agent.queued.length > 0 && (
        <div className="mb-2 px-1">
          <div className="mb-1 flex items-center gap-2 text-muted-foreground text-xs">
            <span>{agent.queued.length} queued</span>
            <span className="opacity-70">
              {agent.busy ? 'press Enter on an empty box to send now' : 'sending…'}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            {agent.queued.map((m, i) => (
              <div
                key={m.id}
                className="flex items-center gap-2 rounded-md border border-border border-dashed px-2.5 py-1.5">
                <span className="font-mono text-muted-foreground text-[10px]">{i + 1}</span>
                <span className="flex min-w-0 flex-1 items-center gap-0.5 truncate text-xs">
                  <TokenText text={spoken(m.text)} />
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  title="Drop this one"
                  onClick={() => agent.unqueue(m.id)}
                  className="size-4 text-muted-foreground">
                  <XIcon className="size-3" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* PromptInput puts className on the form, so the box itself is reached
          through its slot. The wrapper is what the mention menu hangs off. */}
      <div
        className="relative"
        ref={box}
        onDragOver={(e) => { e.preventDefault(); setDropping(true); }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDropping(false); }}
        onDrop={onDrop}>
        {menu && (
          <MentionMenu
            items={rows}
            active={cursor}
            onActive={setActive}
            onPick={pick}
            note={kind === 'path' ? '↑↓ to move · ↵ to pick · the badge shows the name, the agent gets the path' : undefined} />
        )}
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
            <TokenInput
              ref={input}
              value={text}
              onChange={setText}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              onQuery={setPending}
              aria-autocomplete="list"
              aria-expanded={menu}
              aria-controls={menu ? 'composer-mentions' : undefined}
              aria-activedescendant={menu ? `mention-${cursor}` : undefined}
              placeholder={agent.busy
                ? 'Working. Enter parks this, Enter again sends it into this turn'
                : 'Plan, build, or ask about this project'}
              className={cn('min-h-[76px] px-4 pb-2 text-[13.5px]', attachments.length > 0 ? 'pt-2' : 'pt-3.5')} />
          </PromptInputBody>

          <PromptInputFooter className="px-3 pb-3">
            {/* The row shrinks now. It used to size to its contents and slide
                under the send button in a narrow window, which is where the
                effort control was going when the pane got tight: still there,
                still clickable, half of it under a circle. Everything inside
                gives up its label before the row gives up its edge, and the
                measure is the row rather than the window, so it holds at any
                split of the panes. */}
            <PromptInputTools className="@container/tools min-w-0 flex-1 gap-1.5">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    title="Attach a file, or add something from the preview"
                    className="rounded-full text-muted-foreground">
                    <PlusIcon className="size-4" />
                  </Button>
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
                  <DropdownMenuItem onSelect={() => window.tandem.browser.action('screenshot', { fullPage: true })}>
                    <CameraIcon className="size-4 text-muted-foreground" />
                    Screenshot the page
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              {agent.models.length === 0 && agent.driver?.message && (
                // Not installed is the one worth clicking: the Agent tab names
                // what to run, and there is no chat at all until it is there.
                <button
                  type="button"
                  className="px-1 text-muted-foreground text-xs underline-offset-2 hover:underline"
                  title={agent.driver.message}
                  onClick={() => window.tandemChat?.settings('agent')}>
                  {agent.driver.installed
                    ? 'no models listed'
                    : `no ${(agent.providers || []).filter((p) => !p.installed).map((p) => p.id).join(' or ')
                      || agent.provider} on your PATH`}
                </button>
              )}

              {/* The picker is always here. An endpoint that will not list its
                  models still needs a way to name one, and with no CLI at all
                  the menu is the thing that says which ones to install. */}
              <ModelPicker agent={agent} />
              <ContextPill agent={agent} />
              <ThinkingPicker agent={agent} />
            </PromptInputTools>

            <PromptInputSubmit
              className="size-9 shrink-0 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-30"
              disabled={!agent.busy && !text.trim() && !attachments.length}
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

        <UsageMeter usage={agent.usage} chat={agent.activeKey} />
      </div>
    </div>
  );
}
