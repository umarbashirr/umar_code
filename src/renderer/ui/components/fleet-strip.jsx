// Agents run in the background by default, so the row that started one scrolls
// away while the agent is still working. This strip is the answer to "what is
// still going": one chip per live agent, sitting where you are already looking.
import { useEffect, useState } from 'react';
import { XIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

const clock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `0:${String(s).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function FleetStrip({ agents, onStop, onShow }) {
  // One ticker for the whole strip rather than one per chip.
  const [, bump] = useState(0);
  useEffect(() => {
    if (!agents.length) return undefined;
    const t = setInterval(() => bump((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [agents.length]);

  if (!agents.length) return null;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-1.5 px-4 pb-1.5">
      <span className="mr-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/75">running</span>
      {agents.map((a) => (
        <button
          key={a.id}
          type="button"
          onClick={() => onShow?.(a)}
          title={a.description || a.agentType}
          className="flex items-center gap-2 rounded-full border bg-card py-1 pr-1.5 pl-2.5 text-xs hover:border-ring/35">
          <span className={cn(
            'size-1.5 shrink-0 rounded-full',
            a.waiting ? 'bg-amber-500' : 'animate-pulse bg-emerald-500',
          )} />
          <span className="max-w-40 truncate">{a.description || a.agentType}</span>
          <span className="font-mono text-[11px] text-muted-foreground/75">
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
        </button>
      ))}
    </div>
  );
}
