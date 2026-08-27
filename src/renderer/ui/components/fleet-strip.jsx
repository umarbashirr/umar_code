// Agents run in the background by default, so the row that started one scrolls
// away while the agent is still working. This strip is the answer to "what is
// still going": one chip per live agent, sitting where you are already looking.
import { XIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { clock, useTick } from '@/lib/clock';
import { cn } from '@/lib/utils';

export function FleetStrip({ agents, onStop, onShow }) {
  // One ticker for the whole strip rather than one per chip.
  useTick(agents.length > 0);

  if (!agents.length) return null;

  return (
    <div className="tandem-rise mx-auto flex w-full max-w-3xl flex-wrap items-center gap-1.5 px-4 pb-1.5">
      <span className="mr-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/75">running</span>
      {agents.map((a) => (
        <Button
          key={a.id}
          variant="outline"
          size="xs"
          onClick={() => onShow?.(a)}
          title={a.description || a.agentType}
          className="tandem-in h-auto gap-2 rounded-full bg-card py-1 pr-1.5 pl-2.5 font-normal">
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
    </div>
  );
}
