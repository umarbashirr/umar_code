/* Customize: what the agent is offered in this folder, and how the app itself
   behaves, on one page. It takes the chat's place rather than floating over
   it, so the preview and the terminals beside it stay where they are, and a
   server that needs signing in to can do it in a shell you can see. */
import { useEffect, useRef } from 'react';
import { XIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { CATALOG_SECTIONS, CatalogPanel } from '@/components/catalog-panel';
import { SETTINGS_SECTIONS, SettingsPanel, updatesBehind } from '@/components/settings-panel';

const IS_CATALOG = new Set(CATALOG_SECTIONS.map(([id]) => id));

function NavItem({ on, icon: Icon, label, note, onClick }) {
  return (
    <Button
      variant={on ? 'secondary' : 'ghost'}
      onClick={onClick}
      className={cn('h-8 w-full justify-start gap-2.5 font-normal', !on && 'text-muted-foreground')}>
      <Icon />
      {label}
      {note}
    </Button>
  );
}

const Label = ({ children }) => (
  <div className="px-3 pt-4 pb-1 font-medium text-muted-foreground text-xs first:pt-1">{children}</div>
);

export function CustomizePage({ section, onSection, onClose, catalog, settings, set, reset, agent, updates }) {
  const panel = useRef(null);
  const catalogSection = IS_CATALOG.has(section);

  useEffect(() => { updates.check(); }, []);
  useEffect(() => { panel.current?.scrollTo?.(0, 0); }, [section]);

  // Escape goes back to the chat, unless something inside the page is using it:
  // a menu, a select, a field being cleared.
  const onKeyDown = (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented) onClose();
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground" onKeyDown={onKeyDown}>
      <div className="flex h-[38px] flex-none items-center border-b border-border/60 pr-2 pl-4 text-sm text-foreground/90">
        <span className="truncate">Customize</span>
        <Button variant="ghost" size="icon" className="ml-auto size-7" title="Back to the chat (Esc)" onClick={onClose}>
          <XIcon />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        <nav className="flex w-52 shrink-0 flex-col gap-0.5 overflow-y-auto border-r p-2">
          <Label>This folder</Label>
          {CATALOG_SECTIONS.map(([id, label, icon, count]) => (
            <NavItem
              key={id}
              on={section === id}
              icon={icon}
              label={label}
              note={<span className="ml-auto text-muted-foreground text-xs tabular-nums">{count(catalog)}</span>}
              onClick={() => onSection(id)} />
          ))}

          <Label>Settings</Label>
          {SETTINGS_SECTIONS.map(([id, label, icon]) => (
            <NavItem
              key={id}
              on={section === id}
              icon={icon}
              label={label}
              note={id === 'updates' && updatesBehind(updates) && <span className="ml-auto size-2 rounded-full bg-primary" />}
              onClick={() => onSection(id)} />
          ))}
        </nav>

        {/* The catalog lists scroll inside themselves, under their own search
            box, so they get the height; the settings scroll as one page. */}
        <div
          ref={panel}
          className={cn('min-w-0 flex-1 px-8 py-6', catalogSection ? 'flex min-h-0 flex-col' : 'overflow-y-auto')}>
          {catalogSection
            ? <CatalogPanel catalog={catalog} section={section} />
            : <SettingsPanel section={section} settings={settings} set={set} reset={reset} agent={agent} updates={updates} />}
        </div>
      </div>
    </div>
  );
}
