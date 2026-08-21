import { useEffect, useMemo, useRef } from 'react';

import { cn } from '@/lib/utils';

const SOURCE_LABEL = {
  project: 'project',
  user: 'user',
  synced: 'synced',
  plugin: 'plugin',
  builtin: 'built in',
};

// Typing a slash in an empty box is the whole trigger. Once there is a space
// the argument is being written, so the list gets out of the way.
export const slashQuery = (text) => {
  const m = /^\/([\w:.-]*)$/.exec(text);
  return m ? m[1] : null;
};

export function matchSkills(skills, query) {
  const q = query.toLowerCase();
  const scored = [];
  for (const s of skills) {
    if (!s.enabled) continue;
    const name = s.name.toLowerCase();
    if (!q) { scored.push([2, s]); continue; }
    const at = name.indexOf(q);
    if (at === 0) scored.push([0, s]);
    else if (at > 0) scored.push([1, s]);
    else if ((s.description || '').toLowerCase().includes(q)) scored.push([3, s]);
  }
  return scored
    .sort((a, b) => a[0] - b[0] || a[1].name.length - b[1].name.length)
    .slice(0, 40)
    .map(([, s]) => s);
}

export function SlashMenu({ items, active, onActive, onPick }) {
  const box = useRef(null);

  // Walking with the arrow keys has to drag the list along with it.
  useEffect(() => {
    box.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const rows = useMemo(() => items.slice(0, 40), [items]);
  if (!rows.length) return null;

  return (
    <div className="absolute inset-x-0 bottom-full z-20 mb-2 overflow-hidden rounded-xl border bg-popover shadow-lg">
      <div ref={box} className="max-h-[280px] overflow-y-auto py-1">
        {rows.map((s, i) => (
          <button
            key={s.name}
            type="button"
            data-active={i === active}
            onMouseEnter={() => onActive(i)}
            onMouseDown={(e) => { e.preventDefault(); onPick(s); }}
            className={cn(
              'flex w-full items-baseline gap-2 px-3 py-1.5 text-left',
              i === active ? 'bg-muted text-foreground' : 'text-foreground',
            )}>
            <span className="shrink-0 font-mono text-[13px]">/{s.name}</span>
            {s.argumentHint && (
              <span className="shrink-0 font-mono text-muted-foreground text-xs">{s.argumentHint}</span>
            )}
            <span className="truncate text-muted-foreground text-xs">{s.description}</span>
            <span className="ml-auto shrink-0 text-muted-foreground/70 text-[10px]">
              {s.plugin || SOURCE_LABEL[s.source] || s.source}
            </span>
          </button>
        ))}
      </div>
      <div className="border-t px-3 py-1.5 text-muted-foreground text-[11px]">
        ↑↓ to move · ↵ to pick · esc to dismiss
      </div>
    </div>
  );
}
