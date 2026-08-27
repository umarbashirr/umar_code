// A tool call is one line until you want more. The ai-elements Tool card puts a
// border, a badge and a wrench around every step, which turns a transcript into
// a stack of boxes.
import { useEffect, useRef, useState } from 'react';
import {
  ChevronRightIcon, CircleAlertIcon, FilePenIcon, FilePlusIcon, FolderSearchIcon,
  GlobeIcon, MousePointerClickIcon, SearchIcon, SquareIcon, SquareTerminalIcon,
  TextCursorInputIcon, UsersIcon, WrenchIcon,
} from 'lucide-react';

import { Shimmer } from '@/components/ai-elements/shimmer';
import { Fold } from '@/components/fold';
import { Button } from '@/components/ui/button';
import { clock, useTick } from '@/lib/clock';
import { cn } from '@/lib/utils';

const ICONS = {
  Bash: SquareTerminalIcon,
  Read: FolderSearchIcon,
  Glob: FolderSearchIcon,
  Grep: SearchIcon,
  Edit: FilePenIcon,
  MultiEdit: FilePenIcon,
  NotebookEdit: FilePenIcon,
  Write: FilePlusIcon,
  WebFetch: GlobeIcon,
  WebSearch: SearchIcon,
  browser_navigate: GlobeIcon,
  browser_click: MousePointerClickIcon,
  browser_fill: TextCursorInputIcon,
  browser_type: TextCursorInputIcon,
  browser_snapshot: SearchIcon,
  // An Agent call draws as its own container, but the tools for looking in on
  // one still land here.
  Agent: UsersIcon,
  Task: UsersIcon,
  TaskOutput: UsersIcon,
  TaskStop: SquareIcon,
};

// One short line of context, so a collapsed row still says what it did.
const SUMMARY = {
  Bash: (i) => i.command,
  Read: (i) => tail(i.file_path),
  Write: (i) => tail(i.file_path),
  Edit: (i) => tail(i.file_path),
  MultiEdit: (i) => tail(i.file_path),
  Glob: (i) => i.pattern,
  Grep: (i) => i.pattern,
  WebFetch: (i) => i.url,
  Agent: (i) => i.description,
  Task: (i) => i.description,
  browser_navigate: (i) => i.url,
  browser_click: (i) => i.target,
  browser_fill: (i) => `${i.target} = ${JSON.stringify(i.value ?? '')}`,
  browser_evaluate: (i) => i.code,
  browser_press: (i) => i.key,
};

const tail = (p) => String(p || '').split('/').slice(-2).join('/');

// The name to show. An MCP tool arrives as mcp__server__thing, which says more
// about the plumbing than about what ran.
export const toolLabel = (name) =>
  String(name || '').replace(/^mcp__preview__/, '').replace(/^mcp__[^_]+__/, '');

export function toolSummary(name, input) {
  const fn = SUMMARY[name];
  const raw = fn ? fn(input || {}) : Object.values(input || {})[0];
  if (raw == null || typeof raw === 'object') return '';
  return String(raw).replace(/\s+/g, ' ').slice(0, 120);
}

export function ToolRow({ name, input, state, at, right, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  // The input arrives after the row does, so a row can turn into a diff a beat
  // later. Follow defaultOpen until the reader takes over.
  const touched = useRef(false);
  useEffect(() => { if (!touched.current) setOpen(defaultOpen); }, [defaultOpen]);
  const Icon = ICONS[name] || WrenchIcon;
  const running = state === 'input-available' || state === 'input-streaming';
  const failed = state === 'output-error';
  const summary = toolSummary(name, input);

  // A shimmering word is a state, not a clock: it sweeps at the same rate
  // whether the call has been out for two seconds or ninety, and a build that
  // takes a minute reads exactly like a call that will never come back. So a
  // running row counts. Not straight away — most calls are done inside a
  // second and a timer that flashes up and vanishes on every one of them is
  // its own kind of noise.
  useTick(running);
  const held = running && at ? Date.now() - at : 0;

  return (
    <div className={cn('rounded-md', failed && 'bg-destructive/5')}>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => { touched.current = true; setOpen((v) => !v); }}
        className="group h-auto w-full justify-start gap-2 px-2 py-1 font-normal">
        <ChevronRightIcon
          className={cn('size-3 shrink-0 text-muted-foreground/50 transition-transform', open && 'rotate-90')} />
        {failed
          ? <CircleAlertIcon className="size-3.5 shrink-0 text-destructive" />
          : <Icon className="size-3.5 shrink-0 text-muted-foreground" />}
        {running
          ? <Shimmer as="span" className="shrink-0 text-[13px]">{name}</Shimmer>
          : <span className={cn('shrink-0 text-[13px]', failed ? 'text-destructive' : 'text-foreground/90')}>{name}</span>}
        {summary && (
          <span className="truncate font-mono text-muted-foreground text-xs">{summary}</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2 pl-2">
          {held >= 2000 && (
            <span className="tandem-in font-mono text-[11px] tabular-nums text-muted-foreground/70">
              {clock(held)}
            </span>
          )}
          {right}
        </span>
      </Button>
      <Fold open={open} className="px-2 pt-1 pb-2">{children}</Fold>
    </div>
  );
}

// What a run is made of. Anything without a word of its own is a step,
// because "3 browser_click calls" is not a sentence.
const BUCKET = {
  Bash: 'command',
  Read: 'file',
  NotebookRead: 'file',
  Glob: 'search',
  Grep: 'search',
  WebSearch: 'search',
  WebFetch: 'fetch',
};

const PLURAL = {
  command: 'commands', file: 'files', search: 'searches', fetch: 'fetches', step: 'steps',
};

// The three that are looking for something, which is what earns the run a
// verb. Running a command is its own kind of work and gets its own clause.
const LOOKED = ['file', 'search', 'fetch'];

// "Explored 20 files, 5 searches" carries the same three numbers as "20 reads,
// 5 searches" with a verb in front, and the verb is the part that gets read.
// Counting calls describes the transcript; naming the act describes the work.
function summarise(items) {
  const counts = new Map();
  for (const it of items) {
    const key = BUCKET[toolLabel(it.name)] || 'step';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const say = (k) => `${counts.get(k)} ${counts.get(k) === 1 ? k : PLURAL[k]}`;

  const looked = LOOKED.filter((k) => counts.has(k));
  const parts = looked.map(say);
  if (counts.has('command')) parts.push(looked.length ? `ran ${say('command')}` : say('command'));
  if (counts.has('step')) parts.push(say('step'));

  const verb = looked.length ? 'Explored ' : counts.has('command') ? 'Ran ' : '';
  return verb + parts.join(', ');
}

// Nineteen commands in a row were nineteen lines of transcript, and reading
// them cost more than the answer they added up to. What is running stays a row
// you can read; everything it already did collapses to one line saying how
// much of what, one click from being rows again. The summary line itself never
// animates: it is rewritten every time a call lands, and a line that fades on
// each rewrite is a line that never sits still. Opening it is a different
// matter, because that is the reader's own doing and they should see where the
// rows came from.
export function ToolStrip({ items, children }) {
  const [open, setOpen] = useState(false);
  const failed = items.filter((i) => i.state === 'output-error').length;

  return (
    <div className="rounded-md">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        title={open ? 'Fold these back into one line' : 'Show each call'}
        className="h-auto w-full justify-start gap-2 px-2 py-1 font-normal">
        <ChevronRightIcon
          className={cn('size-3 shrink-0 text-muted-foreground/50 transition-transform', open && 'rotate-90')} />
        <span className="truncate text-[13px] text-muted-foreground">
          {open ? `${items.length} before this` : summarise(items)}
        </span>
        {failed > 0 && (
          <span className="shrink-0 font-mono text-[11px] text-destructive">
            {failed} failed
          </span>
        )}
      </Button>

      <Fold open={open} className="ml-3 flex flex-col gap-px border-l pl-1.5">{children}</Fold>
    </div>
  );
}

export function Pre({ children, className }) {
  return (
    <pre className={cn(
      'max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground',
      className,
    )}>
      {children}
    </pre>
  );
}
