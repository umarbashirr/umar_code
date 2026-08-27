/* The terminal panel: a tab per shell, and the area they draw in.

   #terms stays an empty div on purpose. xterm renders into a host element it is
   handed and then owns every node under it, so React draws the strip and leaves
   the canvases alone. */
import { useSyncExternalStore } from 'react';
import { PlusIcon, SquareTerminalIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { activateShell, closeShell, getShellVersion, newShell, shells, subscribeShells } from '../../app.js';

export default function TerminalPanel() {
  useSyncExternalStore(subscribeShells, getShellVersion, getShellVersion);
  const tabs = shells();
  const active = tabs.find((t) => t.active);

  return (
    <section id="panel">
      <Tabs
        value={active?.uid || ''}
        onValueChange={activateShell}
        className="shrink-0 gap-0 border-b border-[var(--term-line)]">
        <TabsList variant="line"
          className="h-auto w-full justify-start! gap-1 rounded-none p-1.5">
          {tabs.map((tab) => (
            <TabsTrigger
              key={tab.uid}
              value={tab.uid}
              title={`${tab.title} (Ctrl+${tab.index + 1})`}
              className="group flex-none gap-1.5 text-xs text-[var(--term-dim)] data-[state=active]:bg-[var(--term-line)] data-[state=active]:text-[var(--term-fg)]">
              <SquareTerminalIcon />
              {tab.title}
              {/* A shell you can close by accident is worse than one you have to
                  aim at, so the cross only appears on the tab under the pointer
                  or the one you are in. */}
              <span
                role="button"
                tabIndex={-1}
                aria-label={`Close ${tab.title}`}
                className="-mr-1 rounded-sm opacity-0 transition-opacity group-hover:opacity-60 group-data-[state=active]:opacity-60 hover:!opacity-100 hover:text-destructive"
                onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); closeShell(tab.uid); }}>
                <XIcon className="size-3" />
              </span>
            </TabsTrigger>
          ))}

          <Button
            variant="ghost"
            size="icon-sm"
            className="text-[var(--term-dim)] hover:text-[var(--term-fg)]"
            title="New terminal (Ctrl+Shift+T)"
            onClick={newShell}>
            <PlusIcon />
          </Button>
        </TabsList>
      </Tabs>

      <div id="terms" />
    </section>
  );
}
