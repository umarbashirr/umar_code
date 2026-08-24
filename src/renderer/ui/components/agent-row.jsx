// A subagent is a conversation inside a conversation, so it gets a container
// rather than a row: the work it does belongs to it, not to the transcript it
// was started from. Folded it is one line saying what it was asked and how far
// it has got; opened it is its own transcript, indented under a rule.
import { useEffect, useRef, useState } from 'react';
import {
  ChevronRightIcon, LoaderIcon, PanelBottomIcon, SquareIcon, UsersIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';

const clock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `0:${String(s).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// Elapsed while it runs, final duration once it has stopped. The tick is one
// second and only while something is actually running.
function useElapsed(item) {
  const [, bump] = useState(0);
  const live = item.status === 'running' || item.status === 'stopping';
  useEffect(() => {
    if (!live) return undefined;
    const t = setInterval(() => bump((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [live]);
  if (!live) return item.ms ? clock(item.ms) : null;
  return clock(item.at ? Date.now() - item.at : item.ms || 0);
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// The counts an agent's own result reports, in the order they say most about
// what it actually did.
function stats(s) {
  if (!s) return [];
  const out = [];
  if (s.readCount) out.push(plural(s.readCount, 'read', 'reads'));
  if (s.searchCount) out.push(plural(s.searchCount, 'search', 'searches'));
  if (s.bashCount) out.push(plural(s.bashCount, 'command', 'commands'));
  if (s.editFileCount) out.push(plural(s.editFileCount, 'edit', 'edits'));
  if (s.linesAdded || s.linesRemoved) out.push(`+${s.linesAdded || 0} −${s.linesRemoved || 0}`);
  return out;
}

export function AgentRow({ item, onStop, onBackground, onOpen, children }) {
  const running = item.status === 'running' || item.status === 'stopping';
  // Open while it is the thing happening, folded once it is history. Whoever
  // touches the chevron owns it after that.
  const touched = useRef(false);
  const [open, setOpen] = useState(running);
  useEffect(() => {
    if (touched.current) return;
    if (!running && open) setOpen(false);
  }, [running]); // eslint-disable-line react-hooks/exhaustive-deps

  const elapsed = useElapsed(item);
  const counts = stats(item.stats);
  const failed = item.status === 'failed';

  const toggle = () => {
    touched.current = true;
    const next = !open;
    setOpen(next);
    if (next && item.loaded === false) onOpen?.(item);
  };

  return (
    <div className={cn(
      'rounded-lg border bg-card/40',
      running && 'border-ring/25',
      item.waiting && 'border-amber-500/40',
      failed && 'border-destructive/30',
    )}>
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-muted/40">
        <ChevronRightIcon
          className={cn('size-3 shrink-0 text-muted-foreground/50 transition-transform', open && 'rotate-90')} />
        {running
          ? <LoaderIcon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
          : <UsersIcon className={cn('size-3.5 shrink-0', failed ? 'text-destructive' : 'text-muted-foreground')} />}
        <span className="shrink-0 text-[13px] text-foreground/90">Agent</span>
        <span className={cn(
          'shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] leading-none',
          running ? 'border-ring/35 text-foreground' : 'text-muted-foreground',
        )}>
          {item.agentType || 'agent'}
        </span>
        <span className="truncate font-mono text-muted-foreground text-xs">
          {item.description || item.input?.description || ''}
        </span>

        <span className="ml-auto flex shrink-0 items-center gap-2 pl-2 font-mono text-[11px] text-muted-foreground/75">
          {item.waiting && <span className="text-amber-600 dark:text-amber-500">needs you</span>}
          {item.background && running && !item.waiting && <span>background</span>}
          {item.status === 'stopped' && <span>stopped</span>}
          {!!item.tools && <span>{plural(item.tools, 'tool', 'tools')}</span>}
          {elapsed && <span>{elapsed}</span>}
          {running && !item.background && (
            <span
              role="button"
              tabIndex={0}
              title="Let the turn carry on without waiting for this"
              onClick={(e) => { e.stopPropagation(); onBackground?.(item); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onBackground?.(item); } }}
              className="grid size-5 place-items-center rounded hover:bg-secondary hover:text-foreground">
              <PanelBottomIcon className="size-3.5" />
            </span>
          )}
          {running && item.taskId && (
            <span
              role="button"
              tabIndex={0}
              title="Stop this agent, leave the rest running"
              onClick={(e) => { e.stopPropagation(); onStop?.(item); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onStop?.(item); } }}
              className="grid size-5 place-items-center rounded hover:bg-secondary hover:text-foreground">
              <SquareIcon className="size-3" />
            </span>
          )}
        </span>
      </button>

      {open && (
        <div className="ml-5 flex flex-col gap-px border-l pr-2 pb-2 pl-2.5">
          {item.loaded === 'loading' && (
            <div className="px-2 py-1 font-mono text-[11px] text-muted-foreground/75">reading its transcript…</div>
          )}
          {children}
          {item.report && (
            <div className="mt-1.5 rounded-md bg-muted/45 px-2.5 py-2 text-[12.5px] leading-relaxed">
              <span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground/75">
                what it came back with
              </span>
              {item.report}
            </div>
          )}
        </div>
      )}

      {!open && !!counts.length && (
        <div className="flex gap-2.5 px-2.5 pb-1.5 pl-[38px] font-mono text-[11px] text-muted-foreground/75">
          {counts.map((c) => <span key={c}>{c}</span>)}
        </div>
      )}
    </div>
  );
}
