// A tool call is one line until you want more. The ai-elements Tool card puts a
// border, a badge and a wrench around every step, which turns a transcript into
// a stack of boxes.
import { useEffect, useRef, useState } from 'react';
import {
  ChevronRightIcon, CircleAlertIcon, FilePenIcon, FilePlusIcon, FolderSearchIcon,
  GlobeIcon, LoaderIcon, MousePointerClickIcon, SearchIcon, SquareIcon, SquareTerminalIcon,
  TextCursorInputIcon, UsersIcon, WrenchIcon,
} from 'lucide-react';

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

export function toolSummary(name, input) {
  const fn = SUMMARY[name];
  const raw = fn ? fn(input || {}) : Object.values(input || {})[0];
  if (raw == null || typeof raw === 'object') return '';
  return String(raw).replace(/\s+/g, ' ').slice(0, 120);
}

export function ToolRow({ name, input, state, right, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  // The input arrives after the row does, so a row can turn into a diff a beat
  // later. Follow defaultOpen until the reader takes over.
  const touched = useRef(false);
  useEffect(() => { if (!touched.current) setOpen(defaultOpen); }, [defaultOpen]);
  const Icon = ICONS[name] || WrenchIcon;
  const running = state === 'input-available' || state === 'input-streaming';
  const failed = state === 'output-error';
  const summary = toolSummary(name, input);

  return (
    <div className={cn('rounded-md', failed && 'bg-destructive/5')}>
      <button
        type="button"
        onClick={() => { touched.current = true; setOpen((v) => !v); }}
        className="group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-muted/60">
        <ChevronRightIcon
          className={cn('size-3 shrink-0 text-muted-foreground/50 transition-transform', open && 'rotate-90')} />
        {running
          ? <LoaderIcon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
          : failed
            ? <CircleAlertIcon className="size-3.5 shrink-0 text-destructive" />
            : <Icon className="size-3.5 shrink-0 text-muted-foreground" />}
        <span className={cn('shrink-0 text-[13px]', failed ? 'text-destructive' : 'text-foreground/90')}>{name}</span>
        {summary && (
          <span className="truncate font-mono text-muted-foreground text-xs">{summary}</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2 pl-2">{right}</span>
      </button>
      {open && <div className="px-2 pt-1 pb-2">{children}</div>}
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
