import { useEffect, useMemo, useState } from 'react';
import {
  CheckIcon, KeyRoundIcon, PlugZapIcon, PlusIcon, RefreshCwIcon, RotateCwIcon, Trash2Icon,
} from 'lucide-react';

import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
// The vanilla half owns the terminal and the preview pane: signing in to a
// server happens in a shell, and the pane has to move out of the way of this
// dialog while it is up.
import { parkPreview, runCommand } from '../../app.js';

const SOURCES = [
  ['project', 'This project'],
  ['user', 'Yours'],
  ['plugin', 'Plugins'],
  ['synced', 'Synced'],
  ['builtin', 'Built in'],
];

// A server's colour is its connection, and until a chat has run there is no
// connection to report: what the config says is all anyone knows.
const STATUS = {
  connected: ['bg-emerald-500', 'connected'],
  failed: ['bg-rose-500', 'failed'],
  'needs-auth': ['bg-amber-500', 'needs sign-in'],
  pending: ['bg-amber-400', 'connecting'],
  disabled: ['bg-muted-foreground/40', 'off'],
  configured: ['bg-muted-foreground/40', 'configured'],
  absent: ['bg-muted-foreground/40', 'not in this chat'],
};

function Tab({ on, count, children, ...props }) {
  return (
    <button
      type="button"
      className={cn(
        'flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-sm transition-colors',
        on ? 'border-border text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
      )}
      {...props}>
      {children}
      <span className="text-muted-foreground text-xs">{count}</span>
    </button>
  );
}

function Toggle({ on, disabled, ...props }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      className={cn(
        'flex size-5 shrink-0 items-center justify-center rounded border transition-colors',
        on ? 'border-foreground/40 text-foreground/80' : 'border-border text-transparent hover:border-foreground/25',
        disabled && 'opacity-40',
      )}
      {...props}>
      <CheckIcon className="size-3.5" />
    </button>
  );
}

function Skills({ catalog }) {
  const [query, setQuery] = useState('');

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hit = (s) => !q || s.name.toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q);
    return SOURCES
      .map(([source, label]) => [label, catalog.skills.filter((s) => s.source === source && hit(s))])
      .filter(([, list]) => list.length);
  }, [catalog.skills, query]);

  const off = catalog.skills.filter((s) => !s.enabled).length;

  return (
    <>
      <div className="flex items-center gap-2 px-1 pb-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search skills and commands"
          autoFocus
          className="h-8" />
        <span className="whitespace-nowrap text-muted-foreground text-xs">
          {off ? `${off} off` : 'all on'}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {groups.length === 0 && (
          <p className="px-1 py-6 text-center text-muted-foreground text-sm">Nothing matches that.</p>
        )}
        {groups.map(([label, list]) => (
          <div key={label} className="mb-3">
            <div className="px-1 pb-1 text-muted-foreground text-xs">{label}</div>
            {list.map((s) => (
              <div
                key={s.name}
                className="flex items-baseline gap-2.5 rounded-md px-1 py-1.5 hover:bg-accent/50">
                <Toggle
                  on={s.enabled}
                  title={s.enabled ? 'Hide this from the agent' : 'Offer this to the agent again'}
                  onClick={() => catalog.setSkill(s.name, !s.enabled)} />
                <span className={cn('shrink-0 font-mono text-[13px]', !s.enabled && 'text-muted-foreground line-through')}>
                  /{s.name}
                </span>
                <span className="truncate text-muted-foreground text-xs" title={s.description}>
                  {s.description}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>

      <p className="border-t px-1 pt-2 text-muted-foreground text-xs">
        Switching a skill off hides it from the agent in this folder. The files stay where they are, and
        the Claude CLI outside this app is not affected.
      </p>
    </>
  );
}

const BLANK = { name: '', scope: 'project', type: 'stdio', command: '', url: '', env: '' };

function parsePairs(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return Object.keys(out).length ? out : undefined;
}

// A command line typed as one string. Quotes are the only nicety worth having:
// arguments with spaces in them are common enough in MCP launch lines.
function splitCommand(line) {
  const parts = line.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  return parts.map((p) => (/^["'].*["']$/.test(p) ? p.slice(1, -1) : p));
}

function AddServer({ catalog, onDone }) {
  const [form, setForm] = useState(BLANK);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const stdio = form.type === 'stdio';

  const submit = async (e) => {
    e.preventDefault();
    const [command, ...args] = splitCommand(form.command);
    const config = stdio
      ? { type: 'stdio', command, args, env: parsePairs(form.env) }
      : { type: form.type, url: form.url.trim(), headers: parsePairs(form.env) };
    await catalog.addMcp({ name: form.name.trim(), scope: form.scope, config });
    setForm(BLANK);
    onDone();
  };

  const ready = form.name.trim() && (stdio ? form.command.trim() : form.url.trim());

  return (
    <form onSubmit={submit} className="mb-3 rounded-lg border p-3">
      <div className="flex gap-2">
        <Input value={form.name} onChange={set('name')} placeholder="name" className="h-8 flex-1" autoFocus />
        <select
          value={form.type}
          onChange={set('type')}
          className="h-8 rounded-md border bg-transparent px-2 text-sm">
          <option value="stdio">stdio</option>
          <option value="http">http</option>
          <option value="sse">sse</option>
        </select>
        <select
          value={form.scope}
          onChange={set('scope')}
          className="h-8 rounded-md border bg-transparent px-2 text-sm">
          <option value="project">.mcp.json</option>
          <option value="user">yours</option>
          <option value="local">this folder</option>
        </select>
      </div>

      <Input
        value={stdio ? form.command : form.url}
        onChange={set(stdio ? 'command' : 'url')}
        placeholder={stdio ? 'npx -y @scope/server --flag' : 'https://mcp.example.com/mcp'}
        className="mt-2 h-8 font-mono text-xs" />

      <textarea
        value={form.env}
        onChange={set('env')}
        rows={2}
        placeholder={stdio ? 'API_KEY=… one per line' : 'Authorization=Bearer … one per line'}
        className="mt-2 w-full resize-none rounded-md border bg-transparent px-3 py-1.5 font-mono text-xs outline-none placeholder:text-muted-foreground" />

      <div className="mt-2 flex items-center gap-2">
        <Button type="submit" size="sm" variant="outline" className="h-7" disabled={!ready}>Add</Button>
        <Button type="button" size="sm" variant="ghost" className="h-7" onClick={onDone}>Cancel</Button>
        <span className="ml-auto text-muted-foreground text-xs">
          {form.scope === 'project' ? 'written to .mcp.json, shared with the repo'
            : form.scope === 'user' ? 'written to ~/.claude.json, every folder'
              : 'written to ~/.claude.json, this folder only'}
        </span>
      </div>
    </form>
  );
}

function Servers({ catalog }) {
  const [adding, setAdding] = useState(false);

  return (
    <>
      <div className="flex items-center gap-2 px-1 pb-2">
        <Button size="sm" variant="outline" className="h-7 gap-1.5" onClick={() => setAdding((a) => !a)}>
          <PlusIcon className="size-3.5" /> Add server
        </Button>
        <Button size="sm" variant="ghost" className="h-7 gap-1.5" onClick={catalog.refresh}>
          <RefreshCwIcon className="size-3.5" /> Refresh
        </Button>
        {!catalog.live && (
          <span className="ml-auto text-muted-foreground text-xs">
            statuses appear once a chat is running
          </span>
        )}
      </div>

      {/* The CLI fetches the connectors switched on in the Claude account and
          connects them itself. They are handy and they are also the reason a
          local server offering the same thing can end up unused, so the switch
          lives where the servers are. */}
      <label className="mb-2 flex cursor-pointer items-center gap-2.5 rounded-md border px-2.5 py-2">
        <Toggle
          on={catalog.connectors}
          onClick={() => catalog.setConnectors(!catalog.connectors)} />
        <span className="text-[13px]">Use the connectors from your Claude account</span>
        <span className="truncate text-muted-foreground text-xs">
          {catalog.connectors
            ? 'Gmail, Drive, Slack and the rest, fetched and connected by the CLI'
            : 'off for this folder, so only the servers configured here are used'}
        </span>
      </label>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {adding && <AddServer catalog={catalog} onDone={() => setAdding(false)} />}

        {catalog.mcp.length === 0 && !adding && (
          <p className="px-1 py-6 text-center text-muted-foreground text-sm">
            No MCP servers are configured for this folder yet.
          </p>
        )}

        {catalog.mcp.map((s) => {
          const [dot, label] = STATUS[s.status] || STATUS.configured;
          return (
            <div key={s.name} className="group flex items-center gap-2.5 rounded-md px-1 py-2 hover:bg-accent/50">
              <Toggle
                on={s.enabled}
                disabled={!s.editable}
                title={!s.editable ? 'The browser tools this app provides'
                  : s.enabled ? 'Stop using this server' : 'Use this server again'}
                onClick={() => catalog.toggleMcp(s.name, !s.enabled)} />
              <span className={cn('size-2 shrink-0 rounded-full', dot)} title={s.error || label} />

              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="font-medium text-[13px]">{s.name}</span>
                  <span className="text-muted-foreground text-xs">{s.scope}</span>
                  <span className="text-muted-foreground text-xs">{s.type}</span>
                  {s.tools != null && <span className="text-muted-foreground text-xs">{s.tools} tools</span>}
                  <span className="text-muted-foreground/70 text-xs">{label}</span>
                </div>
                <div className="truncate font-mono text-muted-foreground text-xs" title={s.target}>
                  {s.error || s.target}
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                {s.status === 'needs-auth' && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1.5 opacity-100"
                    title="Open a shell and run the CLI's sign-in for this server"
                    onClick={async () => {
                      const command = await catalog.loginMcp(s.name);
                      if (command) runCommand('runInTerminal', command);
                    }}>
                    <KeyRoundIcon className="size-3.5" /> Sign in
                  </Button>
                )}
                {/* Reconnect only where there is something to reconnect to. A
                    server the session never loaded answers "not found", and one
                    waiting on sign-in answers "needs-auth". */}
                <Button
                  size="sm"
                  variant="ghost"
                  className="size-7 p-0"
                  title={s.status === 'absent' ? 'This chat did not load this server; a new chat will'
                    : s.status === 'needs-auth' ? 'Sign in first'
                      : 'Reconnect'}
                  disabled={s.status === 'absent' || s.status === 'needs-auth' || s.status === 'configured'}
                  onClick={() => catalog.reconnectMcp(s.name)}>
                  <RotateCwIcon className="size-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="size-7 p-0 text-muted-foreground hover:text-destructive"
                  title={s.removable ? 'Remove from the config' : `${s.scope} servers are not configured here`}
                  disabled={!s.removable}
                  onClick={() => catalog.removeMcp(s.name, s.scope)}>
                  <Trash2Icon className="size-3.5" />
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      <p className="border-t px-1 pt-2 text-muted-foreground text-xs">
        Servers come from .mcp.json here, from ~/.claude.json, and from the plugins you have on. A server
        added mid-chat joins that chat straight away. Sign-in runs the Claude CLI in a shell here, because
        the browser step needs somewhere to happen; the token it saves is the one the next chat reads.
      </p>
    </>
  );
}

// The subagents this folder can call on. Read only: nothing in the CLI's
// settings turns an agent off, so this says what is there rather than
// pretending to a control it does not have.
function Agents({ catalog }) {
  const [query, setQuery] = useState('');
  const list = catalog.agents || [];

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hit = (a) => !q || a.name.toLowerCase().includes(q) || (a.description || '').toLowerCase().includes(q);
    return SOURCES
      .map(([source, label]) => [label, list.filter((a) => a.source === source && hit(a))])
      .filter(([, group]) => group.length);
  }, [list, query]);

  return (
    <>
      <div className="flex items-center gap-2 px-1 pb-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search agents"
          autoFocus
          className="h-8" />
        <span className="whitespace-nowrap text-muted-foreground text-xs">{list.length} on disk</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {groups.length === 0 && (
          <p className="px-1 py-6 text-center text-muted-foreground text-sm">
            {list.length ? 'Nothing matches that.' : 'No agents in this folder or your home directory yet.'}
          </p>
        )}
        {groups.map(([label, group]) => (
          <div key={label} className="mb-3">
            <div className="px-1 pb-1 text-muted-foreground text-xs">{label}</div>
            {group.map((a) => (
              <div key={a.name} className="flex items-baseline gap-2.5 rounded-md px-1 py-1.5 hover:bg-accent/50">
                <span className="shrink-0 font-mono text-[13px]">{a.name}</span>
                <span className="truncate text-muted-foreground text-xs" title={a.description}>
                  {a.description}
                </span>
                <span className="ml-auto shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                  {a.model || 'inherit'}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>

      <p className="border-t px-1 pt-2 text-muted-foreground text-xs">
        Agents come from .claude/agents here, ~/.claude/agents, and the plugins you have on. The agent
        picks one for itself; ask for a named agent in a message and it will use that one.
      </p>
    </>
  );
}

export function CatalogDialog({ catalog, open, onOpenChange }) {
  const [tab, setTab] = useState('skills');

  useEffect(() => {
    parkPreview(open);
    return () => parkPreview(false);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[70vh] max-w-3xl flex-col gap-3 p-4 sm:max-w-3xl">
        <DialogHeader className="space-y-0">
          <DialogTitle className="sr-only">Skills and MCP servers</DialogTitle>
          <DialogDescription className="sr-only">
            What this folder offers the agent, and which of it is switched on.
          </DialogDescription>
          <div className="flex items-center gap-1">
            <PlugZapIcon className="mr-1 size-4 text-muted-foreground" />
            <Tab on={tab === 'skills'} count={catalog.skills.length} onClick={() => setTab('skills')}>
              Skills
            </Tab>
            <Tab on={tab === 'agents'} count={(catalog.agents || []).length} onClick={() => setTab('agents')}>
              Agents
            </Tab>
            <Tab on={tab === 'mcp'} count={catalog.mcp.length} onClick={() => setTab('mcp')}>
              MCP servers
            </Tab>
          </div>
        </DialogHeader>

        {catalog.error && (
          <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-destructive text-xs">
            {catalog.error}
          </p>
        )}

        {tab === 'skills' ? <Skills catalog={catalog} />
          : tab === 'agents' ? <Agents catalog={catalog} />
            : <Servers catalog={catalog} />}
      </DialogContent>
    </Dialog>
  );
}
