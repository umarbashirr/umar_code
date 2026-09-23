import { useMemo, useState } from 'react';

import { Checkbox } from '@/components/ui/checkbox';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { ROW, RowList, SearchBox, TabHeader, matches } from '@/components/catalog-layout';
import { Servers } from '@/components/mcp-servers';

const SOURCES = [
  ['project', 'This project'],
  ['user', 'Yours'],
  ['plugin', 'Plugins'],
  ['synced', 'Synced'],
  ['builtin', 'Built in'],
];

const bySource = (list, query) => SOURCES
  .map(([source, label]) => [label, list.filter((x) => x.source === source && matches(query, x.name, x.description))])
  .filter(([, group]) => group.length);

function Groups({ groups, empty, row }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {groups.length === 0 && <p className="px-1 py-6 text-center text-muted-foreground text-sm">{empty}</p>}
      {groups.map(([label, list]) => (
        <div key={label} className="mb-4">
          <div className="px-1 pb-1.5 text-muted-foreground text-xs">
            {label} <span className="tabular-nums opacity-70">{list.length}</span>
          </div>
          <RowList>{list.map(row)}</RowList>
        </div>
      ))}
    </div>
  );
}

function Skills({ catalog, query, setQuery }) {
  const groups = useMemo(() => bySource(catalog.skills, query), [catalog.skills, query]);
  const off = catalog.skills.filter((s) => !s.enabled).length;

  return (
    <>
      <TabHeader
        title="Skills"
        subtitle={`${catalog.skills.length - off} of ${catalog.skills.length} on. Skills and commands the agent can use in this folder.`}>
        <SearchBox value={query} onChange={setQuery} placeholder="Search skills and commands" />
      </TabHeader>

      <Groups
        groups={groups}
        empty="Nothing matches that."
        row={(s) => (
          <div key={s.name} className={cn(ROW, 'py-2.5')}>
            <Checkbox
              checked={s.enabled}
              title={s.enabled ? 'Hide this from the agent' : 'Offer this to the agent again'}
              onCheckedChange={(enabled) => catalog.setSkill(s.name, enabled === true)} />
            <span className={cn('shrink-0 font-mono text-[13px]', !s.enabled && 'text-muted-foreground line-through')}>
              /{s.name}
            </span>
            <span className="truncate text-muted-foreground text-xs" title={s.description}>{s.description}</span>
          </div>
        )} />

      <p className="border-t px-1 pt-2 text-muted-foreground text-xs">
        Switching a skill off hides it from the agent in this folder. The files stay where they are, and
        the Claude CLI outside this app is not affected.
      </p>
    </>
  );
}

// The subagents this folder can call on. Read only: nothing in the CLI's
// settings turns an agent off, so this says what is there rather than
// pretending to a control it does not have.
function Agents({ catalog, query, setQuery }) {
  const list = catalog.agents || [];
  const groups = useMemo(() => bySource(list, query), [list, query]);

  return (
    <>
      <TabHeader title="Agents" subtitle={`${list.length} on disk. Helpers the agent can hand part of a task to.`}>
        <SearchBox value={query} onChange={setQuery} placeholder="Search agents" />
      </TabHeader>

      <Groups
        groups={groups}
        empty={list.length ? 'Nothing matches that.' : 'No agents in this folder or your home directory yet.'}
        row={(a) => (
          <div key={a.name} className={cn(ROW, 'py-2.5')}>
            <span className="shrink-0 font-mono text-[13px]">{a.name}</span>
            <span className="truncate text-muted-foreground text-xs" title={a.description}>{a.description}</span>
            <span className="ml-auto shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {a.model || 'inherit'}
            </span>
          </div>
        )} />

      <p className="border-t px-1 pt-2 text-muted-foreground text-xs">
        Agents come from .claude/agents here, ~/.claude/agents, and the plugins you have on. The agent
        picks one for itself; ask for a named agent in a message and it will use that one.
      </p>
    </>
  );
}

// The marketplace tabs. Their ids are the sections Customize can be opened at.
const TABS = [
  ['skills', 'Skills', Skills],
  ['agents', 'Agents', Agents],
  ['mcp', 'MCP servers', Servers],
];
export const CATALOG_SECTIONS = TABS.map(([id]) => id);

// One search text for every tab, so switching tabs keeps what was typed.
export function CatalogPanel({ catalog, section, onSection }) {
  const [query, setQuery] = useState('');

  return (
    <Tabs value={section} onValueChange={onSection} className="h-full min-h-0 gap-4">
      <TabsList>
        {TABS.map(([id, label]) => <TabsTrigger key={id} value={id} className="px-3">{label}</TabsTrigger>)}
      </TabsList>

      {catalog.error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-destructive text-xs">
          {catalog.error}
        </p>
      )}

      {TABS.map(([id, , Tab]) => (
        <TabsContent key={id} value={id} className="flex min-h-0 flex-col">
          <Tab catalog={catalog} query={query} setQuery={setQuery} />
        </TabsContent>
      ))}
    </Tabs>
  );
}
