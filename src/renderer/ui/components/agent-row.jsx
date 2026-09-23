// A subagent is a conversation inside a conversation. In the chat it is two
// lines against a dot: what it was asked, and what it is doing about it. Its
// transcript used to open under the row, and three running at once buried the
// chat in three growing logs, so clicking the row now opens it in the Agents
// tab instead.
import { BotIcon, PanelBottomIcon, SquareIcon } from 'lucide-react';

import { Shimmer } from '@/components/ai-elements/shimmer';
import { Button } from '@/components/ui/button';
import { toolLabel, toolSummary } from '@/components/tool-row';
import { clock, useTick } from '@/lib/clock';
import { cn } from '@/lib/utils';

// Elapsed while it runs, final duration once it has stopped. The tick is one
// second and only while something is actually running.
function useElapsed(item) {
  const live = item.status === 'running' || item.status === 'stopping';
  useTick(live);
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

export const isLive = (item) => item.status === 'running' || item.status === 'stopping';

// The row's status light. It was one grey dot in every state, which meant the
// one row on screen with its own life in it looked the same finished as it did
// halfway through. Live is the same green the fleet strip uses for the same
// agent.
export function AgentDot({ item, className }) {
  return (
    <span className={cn(
      'size-[5px] shrink-0 rounded-full',
      item.status === 'failed' ? 'bg-destructive'
        : item.waiting ? 'bg-amber-500'
          : isLive(item) ? 'animate-pulse bg-emerald-500'
            : 'bg-muted-foreground/45',
      className,
    )} />
  );
}

// While it runs, the second line is what it is doing; once it has stopped it
// is what it did. An agent that has not opened its first call yet still gets
// a line, because a running row with nothing moving on it looks stalled.
export function agentLine(item) {
  return isLive(item)
    ? doing(item.children || []) || 'Working'
    : stats(item.stats).join(' · ');
}

// Stop and background, for the row here and the header in the Agents tab.
// Spans rather than buttons, because both sit inside a button.
export function AgentActions({ item, onStop, onBackground }) {
  const running = isLive(item);
  const act = (fn) => ({
    role: 'button',
    tabIndex: 0,
    onClick: (e) => { e.stopPropagation(); fn?.(item); },
    onKeyDown: (e) => { if (e.key === 'Enter') { e.stopPropagation(); fn?.(item); } },
    className: 'grid size-5 place-items-center rounded hover:bg-secondary hover:text-foreground',
  });
  return (
    <>
      {running && !item.background && (
        <span title="Let the turn carry on without waiting for this" {...act(onBackground)}>
          <PanelBottomIcon className="size-3.5" />
        </span>
      )}
      {running && item.taskId && (
        <span title="Stop this agent, leave the rest running" {...act(onStop)}>
          <SquareIcon className="size-3" />
        </span>
      )}
    </>
  );
}

export function AgentMeta({ item }) {
  const elapsed = useElapsed(item);
  const running = isLive(item);
  return (
    <>
      {item.waiting && <span className="text-amber-600 dark:text-amber-500">needs you</span>}
      {item.background && running && !item.waiting && <span>background</span>}
      {item.status === 'stopped' && <span>stopped</span>}
      {!!item.tools && <span>{plural(item.tools, 'tool', 'tools')}</span>}
      {elapsed && <span className="tabular-nums">{elapsed}</span>}
    </>
  );
}

// The dot sits where a tool row has its chevron and the bot where it has its
// icon, so the description starts at the same edge as every tool name.
export function AgentRow({ item, onStop, onBackground, onShow }) {
  const running = isLive(item);
  const failed = item.status === 'failed';
  const what = item.description || item.input?.description || 'Agent';
  const under = agentLine(item);

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => onShow?.(item)}
      title="Open in the Agents tab"
      className="h-auto w-full items-start justify-start gap-2 px-2 py-1 text-left font-normal">
      <span className="grid h-5 w-3 shrink-0 place-items-center"><AgentDot item={item} /></span>
      <BotIcon className="mt-[3px] size-3.5 shrink-0 text-muted-foreground" />

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
        <AgentMeta item={item} />
        <AgentActions item={item} onStop={onStop} onBackground={onBackground} />
      </span>
    </Button>
  );
}
