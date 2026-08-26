// A subagent is a conversation inside a conversation. It used to get a card to
// say so, but three running agents then cost three bordered boxes stacked down
// the transcript, and the border was doing nothing the indent underneath did
// not already do. So it is two lines against a dot: what it was asked, and
// what it is doing about it. Opened, it is its own transcript under a rule.
import { useEffect, useRef, useState } from 'react';
import { ChevronRightIcon, PanelBottomIcon, SquareIcon } from 'lucide-react';

import { Shimmer } from '@/components/ai-elements/shimmer';
import { toolLabel, toolSummary } from '@/components/tool-row';
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

// What a running agent is doing, said as it is happening. Nothing on the wire
// carries a status string, so the newest call it has open is the closest thing
// to one: "Reading agent-row.jsx" rather than a timer counting up.
const DOING = {
  Read: 'Reading',
  NotebookRead: 'Reading',
  Glob: 'Searching',
  Grep: 'Searching',
  WebSearch: 'Searching',
  WebFetch: 'Fetching',
  Bash: 'Running',
  Edit: 'Editing',
  MultiEdit: 'Editing',
  NotebookEdit: 'Editing',
  Write: 'Writing',
};

function doing(kids) {
  for (let i = kids.length - 1; i >= 0; i -= 1) {
    if (kids[i].kind !== 'tool') continue;
    const name = toolLabel(kids[i].name);
    return [DOING[name] || name, toolSummary(name, kids[i].input)].filter(Boolean).join(' ');
  }
  return null;
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

  const what = item.description || item.input?.description || 'Agent';
  // While it runs, the second line is what it is doing; once it has stopped it
  // is what it did. Either way the row is two lines and never a box. An agent
  // that has not opened its first call yet still gets a line, because a
  // running row with nothing moving on it looks like a stalled one.
  const under = running
    ? doing(item.children || []) || 'Working'
    : counts.join(' · ');

  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-start gap-2 rounded-md px-2 py-1 text-left hover:bg-muted/40">
        <ChevronRightIcon
          className={cn('mt-[3px] size-3 shrink-0 text-muted-foreground/50 transition-transform', open && 'rotate-90')} />
        <span className={cn(
          'mt-[7px] size-[5px] shrink-0 rounded-full',
          failed ? 'bg-destructive' : item.waiting ? 'bg-amber-500' : 'bg-muted-foreground/45',
        )} />

        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className={cn('truncate text-[13px]', failed ? 'text-destructive' : 'text-foreground/90')}>
              {what}
            </span>
            <span className="shrink-0 text-muted-foreground text-xs">{item.agentType || 'agent'}</span>
          </span>
          {under && (
            <span className="truncate text-muted-foreground text-xs">
              {running ? <Shimmer as="span" className="truncate">{under}</Shimmer> : under}
            </span>
          )}
        </span>

        <span className="flex shrink-0 items-center gap-2 pl-2 font-mono text-[11px] text-muted-foreground/75">
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
        <div className="ml-[13px] flex flex-col gap-px border-l pr-2 pb-2 pl-3">
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
    </div>
  );
}
