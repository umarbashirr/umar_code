import { useEffect, useRef } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const SOURCE_LABEL = {
  project: 'project',
  user: 'user',
  synced: 'synced',
  plugin: 'plugin',
  builtin: 'built in',
};

// The colour starts here, at the moment of picking. A badge that arrives in
// the box in a colour the menu never showed reads as something the app did
// rather than something you chose.
const DOT = {
  skill: 'bg-[hsl(var(--token-skill))]',
  path: 'bg-[hsl(var(--token-path))]',
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

// Both lists end up in the same shape, so the menu draws one kind of row and
// the composer hands whatever was picked straight to the box.
export const skillRows = (skills, query) => matchSkills(skills, query).map((s) => ({
  key: `skill:${s.name}`,
  kind: 'skill',
  raw: `/${s.name}`,
  name: `/${s.name}`,
  hint: s.argumentHint,
  note: s.description,
  source: s.plugin || SOURCE_LABEL[s.source] || s.source,
}));

export const fileRows = (matches) => matches.map((m) => ({
  key: `path:${m.path}`,
  kind: 'path',
  raw: `@${m.path}`,
  name: m.name,
  // the folder it is in, which is the part that tells two index.js apart
  note: m.path.slice(0, Math.max(0, m.path.length - m.name.length - 1)) || '.',
  source: '',
}));

export function MentionMenu({ items, active, onActive, onPick, note }) {
  const box = useRef(null);

  // Walking with the arrow keys has to drag the list along with it.
  useEffect(() => {
    box.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!items.length) return null;

  return (
    <div
      id="composer-mentions"
      role="listbox"
      className="absolute inset-x-0 bottom-full z-20 mb-2 overflow-hidden rounded-xl border bg-popover shadow-lg">
      <div ref={box} className="max-h-[280px] overflow-y-auto py-1">
        {items.map((item, i) => (
          <Button
            key={item.key}
            id={`mention-${i}`}
            variant="ghost"
            size="sm"
            role="option"
            aria-selected={i === active}
            data-active={i === active}
            onMouseEnter={() => onActive(i)}
            onMouseDown={(e) => { e.preventDefault(); onPick(item); }}
            className={cn(
              'h-auto w-full items-baseline justify-start rounded-none px-3 py-1.5 font-normal',
              i === active && 'bg-muted',
            )}>
            <span className={cn('size-1.5 shrink-0 self-center rounded-full', DOT[item.kind])} />
            <span className="shrink-0 font-mono text-[13px]">{item.name}</span>
            {item.hint && <span className="shrink-0 font-mono text-muted-foreground text-xs">{item.hint}</span>}
            <span className="truncate text-muted-foreground text-xs">{item.note}</span>
            {item.source && (
              <span className="ml-auto shrink-0 pl-2 text-muted-foreground/70 text-[10px]">{item.source}</span>
            )}
          </Button>
        ))}
      </div>
      <div className="border-t px-3 py-1.5 text-muted-foreground text-[11px]">
        {note || '↑↓ to move · ↵ to pick · esc to dismiss'}
      </div>
    </div>
  );
}
