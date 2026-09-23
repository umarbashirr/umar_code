// Agents run in the background by default, so the row that started one scrolls
// away while the agent is still working. This strip is the answer to "what is
// still going": one chip per live agent, sitting where you are already looking.
import { XIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { clock, useTick } from '@/lib/clock';
import { cn } from '@/lib/utils';

const CHIP = 'tandem-in h-auto shrink-0 gap-2 rounded-full bg-card py-1 pr-1.5 pl-2.5 font-normal';

// An agent left running in the background, a dev server say, can go on for the
// whole session. A chip each for those fills the strip with timers that only
// ever count up, so they share one chip. One waiting on you keeps its own.
const parked = (a) => a.background && !a.waiting;

export function FleetStrip({ agents, onStop, onShow }) {
  // One ticker for the whole strip rather than one per chip.
  useTick(agents.length > 0);

  if (!agents.length) return null;

  const own = agents.filter((a) => !parked(a));
  const background = agents.filter(parked);

  // One line whatever the count. A strip that wraps pushes the composer up
  // every time an agent starts, and scrolling sideways costs nothing.
  return (
    <div className="tandem-rise mx-auto flex w-full max-w-3xl items-center gap-1.5 overflow-x-auto px-4 pb-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <span className="mr-0.5 shrink-0 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/75">running</span>
      {own.map((a) => (
        <Button
          key={a.id}
          variant="outline"
          size="xs"
          onClick={() => onShow?.(a)}
          title={a.description || a.agentType}
          className={CHIP}>
          <span className={cn(
            'size-1.5 shrink-0 rounded-full',
            a.waiting ? 'bg-amber-500' : 'animate-pulse bg-emerald-500',
          )} />
          <span className="max-w-40 truncate">{a.description || a.agentType}</span>
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground/75">
            {a.waiting ? 'needs you' : `${clock(a.at ? Date.now() - a.at : a.ms || 0)}${a.tools ? ` · ${a.tools}` : ''}`}
          </span>
          {a.taskId && (
            <span
              role="button"
              tabIndex={0}
              title="Stop this agent"
              onClick={(e) => { e.stopPropagation(); onStop?.(a); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onStop?.(a); } }}
              className="grid size-4 place-items-center rounded-full text-muted-foreground/75 hover:bg-secondary hover:text-foreground">
              <XIcon className="size-3" />
            </span>
          )}
        </Button>
      ))}
      {background.length > 0 && (
        <Button
          variant="outline"
          size="xs"
          onClick={() => onShow?.(background[0])}
          title={background.map((a) => a.description || a.agentType).join('\n')}
          className={cn(CHIP, 'pr-2.5')}>
          <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500" />
          <span>{background.length} in the background</span>
        </Button>
      )}
    </div>
  );
}
