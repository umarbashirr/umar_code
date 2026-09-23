/* The MCP servers tab: the servers anyone can add in one click, and the ones
   already set up here, in one list. */
import { useState } from 'react';
import { CheckIcon, KeyRoundIcon, PlusIcon, RefreshCwIcon, RotateCwIcon, XIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';
import { BrandTile } from '@/components/brand-tile';
import { ROW, RowList, SearchBox, TabHeader, matches } from '@/components/catalog-layout';
import { MCP_GALLERY } from '../../../shared/mcp-gallery';
// Signing in to a CLI's own server happens in a shell, and the shells are the
// vanilla half's.
import { runCommand } from '../../app.js';

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

const BLANK = { name: '', scope: 'tandem', type: 'stdio', command: '', url: '', env: '' };

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
  // Select hands back the value on its own rather than an event.
  const pick = (k) => (value) => setForm({ ...form, [k]: value });
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
        <Select value={form.type} onValueChange={pick('type')}>
          <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="stdio">stdio</SelectItem>
              <SelectItem value="http">http</SelectItem>
              <SelectItem value="sse">sse</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <Select value={form.scope} onValueChange={pick('scope')}>
          <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="tandem">Tandem, every agent</SelectItem>
              <SelectItem value="project">.mcp.json</SelectItem>
              <SelectItem value="user">yours</SelectItem>
              <SelectItem value="local">this folder</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      <Input
        value={stdio ? form.command : form.url}
        onChange={set(stdio ? 'command' : 'url')}
        placeholder={stdio ? 'npx -y @scope/server --flag' : 'https://mcp.example.com/mcp'}
        className="mt-2 h-8 font-mono text-xs" />

      <Textarea
        value={form.env}
        onChange={set('env')}
        rows={2}
        placeholder={stdio ? 'API_KEY=… one per line' : 'Authorization=Bearer … one per line'}
        className="mt-2 min-h-0 resize-none py-1.5 font-mono text-xs" />

      <div className="mt-2 flex items-center gap-2">
        <Button type="submit" size="sm" variant="outline" className="h-7" disabled={!ready}>Add</Button>
        <Button type="button" size="sm" variant="ghost" className="h-7" onClick={onDone}>Cancel</Button>
        <span className="ml-auto text-muted-foreground text-xs">
          {form.scope === 'tandem' ? 'every agent Tandem runs; a Claude chat gets it now, others on the next chat'
            : form.scope === 'project' ? 'written to .mcp.json, shared with the repo'
            : form.scope === 'user' ? 'written to ~/.claude.json, every folder'
              : 'written to ~/.claude.json, this folder only'}
        </span>
      </div>
    </form>
  );
}

// Where a gallery server stands. An add or a sign-in in flight comes first,
// since the listing only changes once it finishes.
function galleryState(entry, row, pending) {
  if (pending?.busy) return row ? 'signing-in' : 'adding';
  if (!row) return 'available';
  if (entry.auth === 'oauth' && !row.signedIn) return 'needs-sign-in';
  return 'connected';
}

function RemoveButton({ onClick }) {
  return (
    <Button
      size="sm"
      variant="ghost"
      className="size-7 p-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
      title="Remove"
      onClick={onClick}>
      <XIcon className="size-3.5" />
    </Button>
  );
}

const SigningIn = () => (
  <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
    <Spinner className="size-3.5" /> Finish in your browser
  </span>
);

function GalleryRow({ entry, row, pending, catalog }) {
  const state = galleryState(entry, row, pending);
  const remove = () => catalog.removeMcp(entry.id, 'tandem');
  return (
    <div className={ROW}>
      <BrandTile icon={entry.icon} name={entry.name} />
      <div className="min-w-0 flex-1">
        <div className="text-sm">{entry.name}</div>
        <div className={cn('truncate text-xs', pending?.error ? 'text-destructive' : 'text-muted-foreground')} title={pending?.error || entry.description}>
          {pending?.error || entry.description}
        </div>
      </div>
      {state === 'available' && (
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          onClick={() => catalog.addGalleryMcp(entry.id, { type: entry.type || 'http', url: entry.url })}>
          Add
        </Button>
      )}
      {state === 'adding' && (
        <Button size="sm" variant="outline" className="h-7" disabled><Spinner className="size-3.5" /> Add</Button>
      )}
      {state === 'needs-sign-in' && (
        <>
          <RemoveButton onClick={remove} />
          <Button size="sm" className="h-7" onClick={() => catalog.authMcp(entry.id)}>Authenticate</Button>
        </>
      )}
      {state === 'signing-in' && <SigningIn />}
      {state === 'connected' && (
        <>
          <RemoveButton onClick={remove} />
          <span className="flex items-center gap-1 text-muted-foreground text-xs"><CheckIcon className="size-3.5" /> Connected</span>
        </>
      )}
    </div>
  );
}

// A server set up some other way: from .mcp.json, ~/.claude.json, a plugin, or
// by hand into Tandem's own list.
function ConfiguredRow({ s, pending, catalog }) {
  const [dot, label] = STATUS[s.status] || STATUS.configured;
  const error = pending?.error || s.error;
  // Tandem's remote servers run behind a local proxy, so the session reports
  // them as plain processes and never says they need a sign-in. The button is
  // there for them until a token is.
  const signIn = s.status === 'needs-auth' || (s.scope === 'tandem' && s.type !== 'stdio' && !s.signedIn);
  return (
    <div className={ROW}>
      <BrandTile name={s.name} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm">{s.name}</span>
          <span className="text-muted-foreground text-xs">{s.scope} · {s.type}{s.tools != null && ` · ${s.tools} tools`}</span>
        </div>
        <div className={cn('truncate text-xs', error ? 'text-destructive' : 'font-mono text-muted-foreground')} title={error || s.target}>
          {error || s.target}
        </div>
      </div>

      {pending?.busy ? <SigningIn /> : (
        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          {signIn && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1.5"
              title={s.scope === 'tandem' ? 'Sign in to this server in your browser' : "Open a shell and run the CLI's sign-in for this server"}
              onClick={async () => {
                if (s.scope === 'tandem') return catalog.authMcp(s.name);
                const command = await catalog.loginMcp(s.name);
                if (command) runCommand('runInTerminal', command);
              }}>
              <KeyRoundIcon className="size-3.5" /> Sign in
            </Button>
          )}
          {/* Reconnect only where there is something to reconnect to. A server
              the session never loaded answers "not found", and one waiting on
              sign-in answers "needs-auth". */}
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
            <XIcon className="size-3.5" />
          </Button>
        </div>
      )}

      <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground text-xs" title={s.error || label}>
        <span className={cn('size-2 rounded-full', dot)} /> {label}
      </span>
      <Checkbox
        checked={s.enabled}
        disabled={!s.editable}
        title={s.scope === 'tandem' ? 'Tandem starts every chat with this server'
          : !s.editable ? 'The browser tools this app provides'
            : s.enabled ? 'Stop using this server' : 'Use this server again'}
        onCheckedChange={(enabled) => catalog.toggleMcp(s.name, enabled === true)} />
    </div>
  );
}

const FILTERS = [['all', 'All'], ['added', 'Added'], ['available', 'Not added']];
const GALLERY_IDS = new Set(MCP_GALLERY.map((g) => g.id));

export function Servers({ catalog, query, setQuery }) {
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState('all');

  const ours = new Map(catalog.mcp.filter((s) => s.scope === 'tandem').map((s) => [s.name, s]));
  const gallery = MCP_GALLERY
    .filter((g) => matches(query, g.name, g.description))
    .map((g) => ({ entry: g, row: ours.get(g.id) || null }));
  const added = gallery.filter((g) => g.row);
  const available = gallery.filter((g) => !g.row);
  const configured = catalog.mcp
    .filter((s) => !(s.scope === 'tandem' && GALLERY_IDS.has(s.name)))
    .filter((s) => matches(query, s.name, s.target));

  const shown = [
    ...(filter === 'available' ? [] : [...added, ...configured]),
    ...(filter === 'added' ? [] : available),
  ];

  return (
    <>
      <TabHeader
        title="MCP servers"
        subtitle="Connect your agents to the apps you use. Every agent Tandem runs gets them.">
        <ToggleGroup type="single" size="sm" spacing={1} value={filter} onValueChange={(v) => v && setFilter(v)}>
          {FILTERS.map(([id, label]) => (
            <ToggleGroupItem key={id} value={id} className="h-7 rounded-full px-3 text-xs">{label}</ToggleGroupItem>
          ))}
        </ToggleGroup>
        <SearchBox value={query} onChange={setQuery} placeholder="Search servers" />
        <Button
          size="sm"
          variant="outline"
          className="h-8 gap-1.5"
          title="Add a server of your own by its command or URL"
          onClick={() => setAdding((a) => !a)}>
          <PlusIcon className="size-3.5" /> Add
        </Button>
        <Button size="sm" variant="ghost" className="size-8 p-0" title="Refresh the statuses" onClick={catalog.refresh}>
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </TabHeader>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {adding && <AddServer catalog={catalog} onDone={() => setAdding(false)} />}

        {shown.length === 0 ? (
          <p className="px-1 py-6 text-center text-muted-foreground text-sm">
            {query.trim() ? 'Nothing matches that.' : 'Nothing is set up yet. Add a server from the list.'}
          </p>
        ) : (
          <RowList>
            {shown.map((item) => (item.entry
              ? <GalleryRow key={item.entry.id} entry={item.entry} row={item.row} pending={catalog.pending[item.entry.id]} catalog={catalog} />
              : <ConfiguredRow key={`${item.scope}:${item.name}`} s={item} pending={catalog.pending[item.name]} catalog={catalog} />))}
          </RowList>
        )}

        {/* The CLI fetches the connectors switched on in the Claude account and
            connects them itself. They are handy and they are also the reason a
            local server offering the same thing can end up unused, so the switch
            lives where the servers are. */}
        <label className="mt-3 flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2.5">
          <Checkbox
            checked={catalog.connectors}
            onCheckedChange={(on) => catalog.setConnectors(on === true)} />
          <span className="text-[13px]">Use the connectors from your Claude account</span>
          <span className="truncate text-muted-foreground text-xs">
            {catalog.connectors
              ? 'Gmail, Drive, Slack and the rest, fetched and connected by the CLI'
              : 'off for this folder, so only the servers configured here are used'}
          </span>
        </label>
      </div>

      <p className="border-t px-1 pt-2 text-muted-foreground text-xs">
        Servers come from Tandem's own list, from .mcp.json here, from ~/.claude.json, and from the plugins you have on. A
        server added mid-chat joins that chat straight away. Authenticate opens your browser to sign in, and every agent
        uses that one sign-in.
      </p>
    </>
  );
}
