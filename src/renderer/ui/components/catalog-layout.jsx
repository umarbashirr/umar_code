/* The pieces every Customize marketplace tab is built from: a header with the
   tab's controls under it, and one bordered list with a divider between rows. */
import { SearchIcon } from 'lucide-react';

import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';

export function TabHeader({ title, subtitle, children }) {
  return (
    <div className="flex flex-none flex-col gap-3 pb-4">
      <div>
        <h2 className="text-base">{title}</h2>
        <p className="text-muted-foreground text-sm">{subtitle}</p>
      </div>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

export function Pills({ value, onChange, options }) {
  return (
    <ToggleGroup type="single" size="sm" spacing={1} value={value} onValueChange={(v) => v && onChange(v)}>
      {options.map(([id, label, count]) => (
        <ToggleGroupItem key={id} value={id} className="h-7 gap-1.5 rounded-full px-3 text-xs">
          {label}
          {count != null && <span className="text-muted-foreground tabular-nums">{count}</span>}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

export function SearchBox({ value, onChange, placeholder }) {
  return (
    <InputGroup className="ml-auto h-8 w-64">
      <InputGroupAddon><SearchIcon /></InputGroupAddon>
      <InputGroupInput value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} autoFocus />
    </InputGroup>
  );
}

export function RowList({ className, children }) {
  return <div className={cn('divide-y overflow-hidden rounded-lg border', className)}>{children}</div>;
}

export function Empty({ children }) {
  return <p className="px-1 py-6 text-center text-muted-foreground text-sm">{children}</p>;
}

export const ROW = 'group flex items-center gap-3 px-3 py-3 hover:bg-accent/50';

export const matches = (query, ...fields) => {
  const q = query.trim().toLowerCase();
  return !q || fields.some((f) => (f || '').toLowerCase().includes(q));
};
