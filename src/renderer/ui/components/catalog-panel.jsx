import { useState } from 'react';
import { BotIcon, SquareSlashIcon, ZapIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { GlyphTile, HUES } from '@/components/brand-tile';
import { Empty, Pills, ROW, RowList, SearchBox, TabHeader, matches } from '@/components/catalog-layout';
import { Servers } from '@/components/mcp-servers';

const SOURCES = [
  ['project', 'This project'],
  ['user', 'Yours'],
  ['plugin', 'Plugins'],
  ['synced', 'Synced'],
  ['builtin', 'Built in'],
];

const SOURCE_HUE = { project: 'green', user: 'blue', synced: 'cyan', builtin: 'slate' };
// Kept apart from the source hues, so a plugin's items never pass for yours.
const PLUGIN_HUES = ['purple', 'orange', 'pink', 'teal', 'indigo', 'yellow', 'red'];

// Every item from one plugin shares a hue, and it is the same one on every run.
function hueOf(item) {
  if (HUES[item.color]) return item.color;
  if (item.plugin) {
    const sum = [...item.plugin].reduce((n, ch) => n + ch.charCodeAt(0), 0);
    return PLUGIN_HUES[sum % PLUGIN_HUES.length];
  }
  return SOURCE_HUE[item.source] || 'slate';
}

const bare = (item) => (item.plugin ? item.name.slice(item.plugin.length + 1) : item.name);

function titleOf(item) {
  const words = bare(item).split(/[-_:]+/).filter(Boolean).join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// The pills are the sources the list has at all, so they hold still while a
// search narrows it. Their counts follow the search.
function useSources(list, query) {
  const [source, setSource] = useState('all');
  const found = list.filter((x) => matches(query, x.name, x.description));
  const pills = [
    ['all', 'All', found.length],
    ...SOURCES
      .filter(([id]) => list.some((x) => x.source === id))
      .map(([id, label]) => [id, label, found.filter((x) => x.source === id).length]),
  ];
  const shown = source === 'all' ? found : found.filter((x) => x.source === source);
  return { pills, source, setSource, shown };
}

function Item({ item, icon, slug, dim, children }) {
  return (
    <div className={ROW}>
      <GlyphTile icon={icon} hue={hueOf(item)} className={cn(dim && 'opacity-50')} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={cn('truncate text-sm', dim && 'opacity-50')}>{titleOf(item)}</span>
          {slug && <span className="shrink-0 font-mono text-muted-foreground text-xs">/{bare(item)}</span>}
          {item.plugin && <Badge variant="outline" className="h-4 px-1.5 py-0 font-normal text-[10px] text-muted-foreground">{item.plugin}</Badge>}
        </div>
        <div className="truncate text-muted-foreground text-xs" title={item.description}>{item.description}</div>
      </div>
      {children}
    </div>
  );
}

function Skills({ catalog, query, setQuery }) {
  const { pills, source, setSource, shown } = useSources(catalog.skills, query);
  const off = catalog.skills.filter((s) => !s.enabled).length;

  return (
    <>
      <TabHeader
        title="Skills"
        subtitle={`${catalog.skills.length - off} of ${catalog.skills.length} on. Skills and commands the agent can use in this folder.`}>
        <Pills value={source} onChange={setSource} options={pills} />
        <SearchBox value={query} onChange={setQuery} placeholder="Search skills and commands" />
      </TabHeader>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 ? (
          <Empty>{catalog.skills.length ? 'Nothing matches that.' : 'No skills in this folder or your home directory yet.'}</Empty>
        ) : (
          <RowList>
            {shown.map((s) => (
              <Item key={s.name} item={s} icon={s.kind === 'command' ? SquareSlashIcon : ZapIcon} slug dim={!s.enabled}>
                <Switch
                  checked={s.enabled}
                  title={s.enabled ? 'Hide this from the agent' : 'Offer this to the agent again'}
                  onCheckedChange={(enabled) => catalog.setSkill(s.name, enabled)} />
              </Item>
            ))}
          </RowList>
        )}
      </div>

      <p className="border-t px-1 pt-2 text-muted-foreground text-xs">
        Switching a skill off hides it from the agent in this folder. The files stay where they are, and
        the Claude CLI outside this app is not affected.
      </p>
    </>
  );
}

const MODELS = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };
const modelLabel = (model) => (!model || model === 'inherit' ? "Chat's model" : MODELS[model] || model);

// The subagents this folder can call on. Read only: nothing in the CLI's
// settings turns an agent off, so this says what is there rather than
// pretending to a control it does not have.
function Agents({ catalog, query, setQuery }) {
  const list = catalog.agents || [];
  const { pills, source, setSource, shown } = useSources(list, query);

  return (
    <>
      <TabHeader title="Agents" subtitle={`${list.length} on disk. Helpers the agent can hand part of a task to.`}>
        <Pills value={source} onChange={setSource} options={pills} />
        <SearchBox value={query} onChange={setQuery} placeholder="Search agents" />
      </TabHeader>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 ? (
          <Empty>{list.length ? 'Nothing matches that.' : 'No agents in this folder or your home directory yet.'}</Empty>
        ) : (
          <RowList>
            {shown.map((a) => (
              <Item key={a.name} item={a} icon={BotIcon}>
                <span className="shrink-0 text-muted-foreground text-xs">{modelLabel(a.model)}</span>
              </Item>
            ))}
          </RowList>
        )}
      </div>

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
