import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckIcon, CircleAlertIcon, DownloadIcon, ExternalLinkIcon, FolderOpenIcon,
  InfoIcon, MessageSquareIcon, MonitorIcon, MoonIcon, PaletteIcon, PowerIcon,
  RefreshCwIcon, SparklesIcon, SquareTerminalIcon, SunIcon,
} from 'lucide-react';

import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Field, FieldContent, FieldDescription, FieldGroup, FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useTheme } from '@/hooks/use-theme';
import { sizeLabel } from '@/lib/attachments';
import { DEFAULT_SCHEME, SCHEMES } from '@/lib/themes';
import { cn } from '@/lib/utils';
import { MODES } from '@/components/composer';
// The vanilla half owns the preview pane, which has to move out of the way of
// any dialog that opens over it.
import { CHAT_SIZES, parkPreview, toast, ZOOM_STEPS } from '../../app.js';

const SECTIONS = [
  ['appearance', 'Appearance', PaletteIcon],
  ['agent', 'Agent', SparklesIcon],
  ['chat', 'Chat', MessageSquareIcon],
  ['terminal', 'Terminal', SquareTerminalIcon],
  ['updates', 'Updates', DownloadIcon],
  ['startup', 'Startup', PowerIcon],
  ['about', 'About', InfoIcon],
];

const THEMES = [
  ['system', 'System', MonitorIcon],
  ['light', 'Light', SunIcon],
  ['dark', 'Dark', MoonIcon],
];

// What each install can actually do with a downloaded file, said plainly rather
// than left for the person to find out.
const HANDOFF = {
  deb: 'Opens in your package installer, which will ask for your password.',
  tree: 'Unpacks over /opt/tandem after asking for your password.',
  appimage: 'Lands in Downloads and is made executable. Swap it for the one you run.',
  dmg: 'Opens the disk image. Drag Tandem across to replace it.',
  nsis: 'Opens the installer.',
  dev: 'This is a checkout, not an install. Pull and rebuild instead.',
};

function Row({ label, hint, children }) {
  return (
    <Field orientation="horizontal" className="gap-6 py-4">
      <FieldContent className="min-w-0">
        <FieldLabel>{label}</FieldLabel>
        {hint && <FieldDescription>{hint}</FieldDescription>}
      </FieldContent>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </Field>
  );
}

function Section({ title, note, children }) {
  return (
    <div className="mb-9">
      <h3 className="font-medium text-base">{title}</h3>
      {note && <p className="mt-1.5 text-[13px] text-muted-foreground leading-relaxed">{note}</p>}
      <FieldGroup className="mt-2 gap-0 divide-y divide-border/60">{children}</FieldGroup>
    </div>
  );
}

function Segmented({ value, options, onChange }) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      value={value}
      // Pressing the item that is already on hands back an empty string. None of
      // these settings has an off position, so an empty answer is not a change.
      onValueChange={(next) => { if (next) onChange(next); }}>
      {options.map(([v, label, Icon]) => (
        <ToggleGroupItem key={v} value={v}>
          {Icon && <Icon />}
          {label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

const Mono = ({ children, title }) => (
  <span className="truncate font-mono text-[13px] text-muted-foreground" title={title || children}>{children}</span>
);

// A theme swatch is the theme. Both attributes are set on the tile, which is
// all the stylesheet needs to paint its subtree in that palette, so what you
// click is a small picture of the window you are about to get rather than an
// approximation somebody has to keep in step.
function SchemeTile({ id, label, note, mode, active, onPick }) {
  return (
    <button
      type="button"
      data-scheme={id}
      data-theme={mode}
      title={note}
      aria-pressed={active}
      onClick={() => onPick(id)}
      className={cn(
        'overflow-hidden rounded-lg border bg-background text-left shadow-sm transition',
        active ? 'border-primary ring-2 ring-primary/40' : 'hover:ring-2 hover:ring-primary/20',
      )}>
      {/* The window in miniature: rail, a couple of lines of transcript, the
          button you press most, and the terminal along the bottom. */}
      <div className="flex h-20">
        <div className="w-6 border-r bg-muted" />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-1 flex-col gap-1 p-2">
            <div className="h-1.5 rounded-full bg-foreground/20" />
            <div className="h-1.5 w-2/3 rounded-full bg-foreground/15" />
            <div className="mt-auto h-3 w-9 rounded-[3px] bg-primary" />
          </div>
          <div className="flex h-4 items-center gap-1 bg-[var(--term-bg)] px-1.5">
            <span className="size-1 rounded-full bg-[var(--term-cursor)]" />
            <span className="h-1 w-8 rounded-full bg-[var(--term-dim)]" />
          </div>
        </div>
      </div>
      <div className="flex items-center border-t px-2 py-1.5 text-[13px] text-foreground">
        {label}
        {active && <CheckIcon className="ml-auto size-3.5 text-primary" />}
      </div>
    </button>
  );
}

function Appearance({ settings, set }) {
  const a = settings.appearance;
  // 'system' is a preference, not a colour, and the swatches have to be painted
  // in the one it currently means.
  const { resolved } = useTheme();

  return (
    <Section title="Appearance">
      <Row label="Theme" hint="System follows the desktop while the window is open.">
        <Segmented
          value={a.theme}
          options={THEMES}
          onChange={(theme) => set({ appearance: { theme } })} />
      </Row>
      <Field className="gap-3 py-4">
        <FieldContent>
          <FieldLabel>Style</FieldLabel>
          <FieldDescription>
            The whole window: chat, rail, panels, dialogs and the terminal. Each one has a light
            and a dark version, and the switch above picks between them. The last two change more
            than the colours. Brutalist squares every corner, Glass makes the panels see-through.
          </FieldDescription>
        </FieldContent>
        <div className="grid grid-cols-3 gap-3">
          {SCHEMES.map(([id, label, note]) => (
            <SchemeTile
              key={id}
              id={id}
              label={label}
              note={note}
              mode={resolved}
              active={(a.scheme || DEFAULT_SCHEME) === id}
              onPick={(scheme) => set({ appearance: { scheme } })} />
          ))}
        </div>
      </Field>
      <Row
        label="Interface size"
        hint="Scales the whole shell. The preview keeps the page's own zoom.">
        <Select
          value={String(a.zoom)}
          onValueChange={(z) => set({ appearance: { zoom: Number(z) } })}>
          <SelectTrigger className="min-w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {ZOOM_STEPS.map((z) => (
                <SelectItem key={z} value={String(z)}>{Math.round(z * 100)}%</SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Row>
    </Section>
  );
}

// A model row that can also take a name nobody offered. Proxies route whatever
// their owner configured, so the list is a suggestion rather than the limit.
function ModelRow({ agent }) {
  const [draft, setDraft] = useState('');
  const custom = agent.models.find((m) => m.value === agent.model)?.custom;

  const add = () => {
    const value = draft.trim();
    setDraft('');
    if (value) agent.changeModel(value);
  };

  return (
    <>
      <Row label="Model">
        {agent.models.length === 0
          ? <Mono>{agent.driver?.installed ? 'no models offered' : 'CLI not installed'}</Mono>
          : (
            // An empty value is what Radix reads as "nothing picked yet", so a
            // model this app has not been told about leaves the placeholder up
            // rather than blanking the trigger.
            <Select value={agent.model || ''} onValueChange={agent.changeModel}>
              <SelectTrigger className="min-w-36">
                <SelectValue placeholder="Pick a model" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {agent.models.map((m) => (
                    <SelectItem key={m.value} value={m.value}>{m.displayName || m.value}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          )}
        {custom && (
          <Button variant="outline" onClick={() => agent.forgetModel(agent.model)}>Forget</Button>
        )}
      </Row>
      <Row
        label="Another model name"
        hint={agent.driver?.endpoint && agent.driver.endpoint !== 'anthropic'
          ? `${agent.driver.endpoint} decides which names work. Type one it routes.`
          : 'For a name this app has not been told about. It is kept for next time.'}>
        <Input
          value={draft}
          placeholder="e.g. claude-sonnet-4-5"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          className="w-56" />
        <Button variant="outline" disabled={!draft.trim()} onClick={add}>Use it</Button>
      </Row>
    </>
  );
}

/* The two CLIs the panel can drive. Neither ships with Tandem, so for each one
   this is the name, where to get it, and what the box on the settings page
   should suggest when someone has it somewhere odd. */
const PROVIDERS = {
  claude: {
    label: 'Claude',
    cli: 'claude',
    install: 'npm install -g @anthropic-ai/claude-code',
    where: '/usr/local/bin/claude',
    missing: 'Nothing named claude on your PATH. Install it, check that claude --version answers in a terminal, then restart Tandem.',
  },
  codex: {
    label: 'Codex',
    cli: 'codex',
    install: 'npm install -g @openai/codex',
    where: '/usr/local/bin/codex',
    missing: 'Nothing named codex on your PATH. Install it, run codex login once, then restart Tandem. If your only copy is the one inside the ChatGPT app, give its full path below.',
  },
};

// The CLI updates itself whichever way it was installed, so one command covers
// the npm copy and the one the native installer put down.
const CLAUDE_UPDATE = 'claude update';
// codex has a `codex update`, but it only works for the native install and
// refuses on an npm one, which is how most people have it.
const CODEX_UPDATE = 'npm install -g @openai/codex';

// Copying in silence looks like a button that did nothing.
const copy = (text) => {
  navigator.clipboard?.writeText(text);
  toast('Copied', text);
};

function Agent({ settings, set, agent, updates }) {
  const provider = agent.provider === 'codex' ? 'codex' : 'claude';
  const p = PROVIDERS[provider];
  // The driver knows first: it probes on every launch, while the update check
  // is a network call someone can switch off. Only the version comes from the
  // update cache, and only when the driver has not reported one yet, and only
  // for claude, which is the only one that check asks about.
  const claude = updates.claude || {};
  const running = agent.driver?.installed
    ? {
      path: agent.driver.binaryPath,
      version: agent.driver.version || (provider === 'claude' ? claude.running?.version : null),
    }
    : null;
  const saved = settings[provider].binary || '';
  const [draft, setDraft] = useState(saved);
  // Two things move this box: switching provider, and a settings reset. Either
  // way a stale path would be written back on the next blur.
  useEffect(() => { setDraft(saved); }, [saved]);

  return (
    <>
      <Section title="New chats" note="What a chat starts on. Changing it here changes the chats already open too.">
        <Row
          label="Agent"
          hint="Which CLI the panel drives. Chats already open keep the one they started on; the next message starts a new one.">
          <Select value={provider} onValueChange={agent.changeProvider}>
            <SelectTrigger className="min-w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {Object.entries(PROVIDERS).map(([id, v]) => (
                  <SelectItem key={id} value={id}>{v.label}</SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Row>
        <ModelRow agent={agent} />
        <Row label="Permission mode" hint={MODES.find(([v]) => v === settings.agent.mode)?.[2]}>
          <Select value={settings.agent.mode} onValueChange={(mode) => set({ agent: { mode } })}>
            <SelectTrigger className="min-w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {MODES.map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Row>
      </Section>

      <Section
        title={`${p.label} CLI`}
        note={`Tandem runs the ${p.cli} you installed. A chat already running keeps the one it started with.`}>
        <Row label={running ? 'Found' : 'Not found'} hint={running?.path || p.missing}>
          <Mono>{running?.version || '—'}</Mono>
          {!running && <Button variant="outline" onClick={() => copy(p.install)}>Copy command</Button>}
        </Row>
        <Row
          label="Somewhere else"
          hint={`Leave this empty unless ${p.cli} lives where PATH cannot reach it. A full path to the binary.`}>
          <Input
            className="w-72 font-mono text-xs"
            value={draft}
            placeholder={p.where}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => set({ [provider]: { binary: draft.trim() } })}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
        </Row>
      </Section>
    </>
  );
}

const DEFAULT_STACK = 'ui-monospace, SFMono-Regular, Menlo, "Cascadia Code", monospace';
const DEFAULT_SANS = 'ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif';

// Faces worth offering if the machine has them. Listing a font nobody has
// installed gets you a dropdown of choices that all render identically, so
// these are only the candidate sets; what survives detection is the menu.
const MONO = [
  'JetBrains Mono', 'JetBrainsMono Nerd Font Mono', 'Fira Code', 'FiraCode Nerd Font Mono',
  'Cascadia Code', 'Cascadia Mono', 'Source Code Pro', 'IBM Plex Mono', 'Hack', 'Hack Nerd Font Mono',
  'Iosevka', 'Inconsolata', 'Roboto Mono', 'Noto Sans Mono', 'DejaVu Sans Mono', 'Liberation Mono',
  'Ubuntu Mono', 'Ubuntu Sans Mono', 'Menlo', 'Monaco', 'SF Mono', 'Consolas', 'Courier New',
];

// Atkinson Hyperlegible is in here for the same reason the size control is:
// somebody reading a long transcript all day gets to pick the face that is
// easiest on their eyes, not the one that looks best in a screenshot.
const SANS = [
  'Inter', 'Inter Display', 'IBM Plex Sans', 'Source Sans 3', 'Source Sans Pro',
  'Atkinson Hyperlegible', 'Public Sans', 'Work Sans', 'Fira Sans', 'Lato', 'Nunito Sans',
  'Open Sans', 'Roboto', 'Noto Sans', 'Cantarell', 'Ubuntu', 'Ubuntu Sans', 'DejaVu Sans',
  'Liberation Sans', 'Segoe UI', 'SF Pro Text', 'Helvetica Neue', 'Arial',
];

// document.fonts.check answers true for everything in Electron, fake names
// included, so it cannot be used here. Measuring instead does work: a string
// drawn in an installed font comes out a different width from the generic it
// would otherwise fall back to. Three generics, because a font that happens to
// be the machine's default for one of them matches that baseline exactly.
function installed(candidates) {
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    const probe = 'mmmmmmmmmmlliWWW0O';
    const width = (font) => { ctx.font = font; return ctx.measureText(probe).width; };
    const bases = ['monospace', 'serif', 'sans-serif'];
    const baseline = Object.fromEntries(bases.map((b) => [b, width(`72px ${b}`)]));
    return candidates.filter((f) => bases.some((b) => width(`72px "${f}", ${b}`) !== baseline[b]));
  } catch {
    return [];
  }
}

// The transcript and the composer, and nothing else in the window. Someone who
// wants bigger chat text does not necessarily want a bigger rail, and the
// terminal already has a size of its own.
function ChatPrefs({ settings, set }) {
  const c = settings.chat;
  const sans = useMemo(() => installed(SANS), []);
  const mono = useMemo(() => installed(MONO), []);
  const known = [DEFAULT_SANS, DEFAULT_STACK,
    ...sans.map((f) => `"${f}", ${DEFAULT_SANS}`), ...mono.map((f) => `"${f}", ${DEFAULT_STACK}`)];
  const custom = known.includes(c.fontFamily) ? null : c.fontFamily;

  return (
    <Section
      title="Chat"
      note="The transcript and the composer. The rail, the toolbar and the terminal keep their own sizes.">
      <Row label="Text size" hint="What the body text is drawn at. Everything in the pane scales with it.">
        <Select
          value={String(c.fontSize)}
          onValueChange={(v) => set({ chat: { fontSize: Number(v) } })}>
          <SelectTrigger className="min-w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {CHAT_SIZES.map((n) => (
                <SelectItem key={n} value={String(n)}>{n}px</SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Row>
      <Row
        label="Font family"
        hint={sans.length
          ? `${sans.length} of these are on this machine. Code and file paths stay monospace either way.`
          : 'No named faces found beyond the system stack. Code and file paths stay monospace either way.'}>
        <Select
          value={custom || c.fontFamily}
          onValueChange={(fontFamily) => set({ chat: { fontFamily } })}>
          <SelectTrigger className="w-64"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={DEFAULT_SANS}>System default</SelectItem>
              {sans.map((f) => (
                <SelectItem key={f} value={`"${f}", ${DEFAULT_SANS}`}>{f}</SelectItem>
              ))}
            </SelectGroup>
            {mono.length > 0 && (
              <SelectGroup>
                <SelectLabel>Monospace</SelectLabel>
                {mono.map((f) => (
                  <SelectItem key={f} value={`"${f}", ${DEFAULT_STACK}`}>{f}</SelectItem>
                ))}
              </SelectGroup>
            )}
            {custom && <SelectItem value={custom}>Custom (from settings.json)</SelectItem>}
          </SelectContent>
        </Select>
      </Row>
    </Section>
  );
}

function TerminalPrefs({ settings, set }) {
  const t = settings.terminal;
  const fonts = useMemo(() => installed(MONO), []);
  // A stack typed into settings.json by hand still has to be selectable, or
  // opening this page would silently reset it to whatever sits at the top.
  const known = [DEFAULT_STACK, ...fonts.map((f) => `"${f}", ${DEFAULT_STACK}`)];
  const custom = known.includes(t.fontFamily) ? null : t.fontFamily;

  return (
    <Section title="Terminal" note="Applies to the tabs already open as well as new ones.">
      <Row label="Font size">
        <Select
          value={String(t.fontSize)}
          onValueChange={(v) => set({ terminal: { fontSize: Number(v) } })}>
          <SelectTrigger className="min-w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {[10, 11, 12, 13, 14, 15, 16, 18, 20].map((n) => (
                <SelectItem key={n} value={String(n)}>{n}px</SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Row>
      <Row
        label="Font family"
        hint={fonts.length
          ? `${fonts.length} monospace faces found on this machine.`
          : 'No named monospace faces found, so this falls back to the system stack.'}>
        <Select
          value={custom || t.fontFamily}
          onValueChange={(fontFamily) => set({ terminal: { fontFamily } })}>
          <SelectTrigger className="w-64"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={DEFAULT_STACK}>System default</SelectItem>
              {fonts.map((f) => (
                <SelectItem key={f} value={`"${f}", ${DEFAULT_STACK}`}>{f}</SelectItem>
              ))}
              {custom && <SelectItem value={custom}>Custom (from settings.json)</SelectItem>}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Row>
    </Section>
  );
}

// A download the user did not start and cannot hurry, so the bar is there to
// say it is still moving rather than to be watched.
function Downloading({ received, total }) {
  const pct = total ? Math.min(100, Math.round((received / total) * 100)) : 0;
  return (
    <div className="flex w-56 flex-col gap-1.5">
      <Progress value={pct} className="h-1.5" />
      <div className="text-right text-[13px] text-muted-foreground">
        {sizeLabel(received)} of {sizeLabel(total)}
      </div>
    </div>
  );
}

// Both CLIs answer the same three questions, so they get the same row: which
// version is running, whether a newer one is out, and what to type for it.
function CliSection({ title, note, state, update, absent }) {
  const cli = state || {};
  return (
    <Section title={title} note={note}>
      <Row
        label={cli.missing ? 'Not found' : cli.behind ? `${cli.latest} is out` : 'Up to date'}
        hint={cli.missing
          ? absent
          : cli.running?.version
            ? `Running ${cli.running.version}${cli.latest ? `, latest is ${cli.latest}` : ''}.`
            : 'No version reported yet.'}>
        {cli.behind && (
          <Button variant="outline" onClick={() => copy(update)}>Copy update command</Button>
        )}
      </Row>
    </Section>
  );
}

function Updates({ settings, set, updates }) {
  const { app, claude, codex, kind, progress, file, checking } = updates;
  const behind = app.behind;

  return (
    <>
      <Section title="Tandem">
        <Row
          label={behind ? `${app.latest} is out` : `You are on ${app.current}`}
          hint={behind
            ? `You have ${app.current}. ${HANDOFF[kind] || ''}`
            : updates.checkedAt
              ? `Checked ${new Date(updates.checkedAt).toLocaleString()}.`
              : 'Not checked yet.'}>
          {progress && !progress.done
            ? <Downloading received={progress.received} total={progress.total} />
            : (
              <>
                <Button
                  variant="outline"
                  disabled={checking}
                  onClick={updates.check}>
                  <RefreshCwIcon className={cn('size-4', checking && 'animate-spin')} />
                  Check
                </Button>
                {behind && app.asset && kind !== 'dev' && (
                  file
                    ? (
                      <Button
                        disabled={updates.installing || updates.installed}
                        onClick={() => updates.install()}>
                        {updates.installing
                          ? <RefreshCwIcon className="size-4 animate-spin" />
                          : <CheckIcon className="size-4" />}
                        {updates.installed ? 'Installed' : updates.installing ? 'Installing' : 'Install'}
                      </Button>
                    )
                    : (
                      <Button onClick={updates.download}>
                        <DownloadIcon className="size-4" />
                        Download {app.asset.size ? sizeLabel(app.asset.size) : ''}
                      </Button>
                    )
                )}
                {behind && app.page && (
                  <Button variant="ghost" onClick={updates.openPage}>
                    <ExternalLinkIcon className="size-4" /> Notes
                  </Button>
                )}
              </>
            )}
        </Row>

        {file && (
          <Row
            label="Downloaded"
            hint={updates.installed
              ? 'Installed. Restart Tandem to run the new version.'
              : file}>
            <Button
              disabled={updates.installing || updates.installed}
              onClick={() => updates.install()}>
              {updates.installing && <RefreshCwIcon className="size-4 animate-spin" />}
              {kind === 'appimage'
                ? 'Show in folder'
                : updates.installed ? 'Installed' : updates.installing ? 'Installing' : 'Install'}
            </Button>
          </Row>
        )}

        {behind && !app.asset && kind !== 'dev' && (
          <Row
            label="No file for this install"
            hint={`Release ${app.latest} ships nothing matching a ${kind} on this hardware.`}>
            <Button variant="outline" onClick={updates.openPage}>Open release</Button>
          </Row>
        )}

        <Row label="Check on launch" hint="One request to GitHub, cached for six hours.">
          <Switch
            checked={settings.startup.checkUpdates}
            onCheckedChange={(checkUpdates) => set({ startup: { checkUpdates } })} />
        </Row>
      </Section>

      <CliSection
        title="Claude CLI"
        note="Yours to update. Tandem only reads the version, so it never replaces the binary under you."
        state={claude}
        update={CLAUDE_UPDATE}
        absent="No claude on your PATH, so Claude chats cannot start. See the Agent tab." />

      <CliSection
        title="Codex CLI"
        note="Only needed if you drive codex. Same deal: Tandem reads the version and nothing else."
        state={codex}
        update={CODEX_UPDATE}
        absent="No codex on your PATH. Install it if you want to drive codex from the Agent tab." />

      {updates.error && (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertDescription>{updates.error}</AlertDescription>
        </Alert>
      )}
    </>
  );
}

function Startup({ settings, set }) {
  const s = settings.startup;
  return (
    <Section title="Startup">
      <Row
        label="Reopen the last folder"
        hint="Off, a bare launch opens with no folder chosen. Launching from a terminal still uses that folder.">
        <Switch
          checked={s.reopenProject}
          onCheckedChange={(reopenProject) => set({ startup: { reopenProject } })} />
      </Row>
      <Row label="Check for updates on launch">
        <Switch
          checked={s.checkUpdates}
          onCheckedChange={(checkUpdates) => set({ startup: { checkUpdates } })} />
      </Row>
    </Section>
  );
}

function About({ updates, reset }) {
  const [paths, setPaths] = useState(null);
  useEffect(() => { window.tandem.settings.paths().then(setPaths).catch(() => {}); }, []);

  return (
    <>
      <Section title="About">
        <Row label="Tandem"><Mono>{updates.app.current}</Mono></Row>
        <Row label="Installed as"><Mono>{updates.kind}</Mono></Row>
        <Row label="Claude CLI" hint={paths?.claude}>
          <Mono>{updates.claude?.running?.version || '—'}</Mono>
        </Row>
        <Row label="Settings file" hint={paths?.settings}>
          <Button
            variant="ghost"
            onClick={() => window.tandem.settings.reveal()}>
            <FolderOpenIcon className="size-4" /> Show
          </Button>
        </Row>
      </Section>

      <Section title="Start over" note="Puts every setting on this page back to its default.">
        <Row label="Reset settings">
          <Button variant="destructive" onClick={reset}>Reset</Button>
        </Row>
      </Section>
    </>
  );
}

export function SettingsDialog({ open, onOpenChange, section = 'appearance', settings, set, reset, agent, updates }) {
  const [tab, setTab] = useState(section);
  const panel = useRef(null);

  useEffect(() => { if (open) setTab(section); }, [open, section]);

  useEffect(() => {
    parkPreview(open);
    return () => parkPreview(false);
  }, [open]);

  // Opening the page is the moment to find out, so a stale answer is not what
  // someone sees after clicking Updates.
  useEffect(() => { if (open) updates.check(); }, [open]);

  if (!settings) return null;

  const props = { settings, set, reset, agent, updates };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[80vh] max-w-5xl gap-0 overflow-hidden p-0 sm:max-w-5xl"
        // Left alone, the focus ring lands on the first nav item, which is
        // rarely the section that just opened. Park focus on the panel instead:
        // still inside the dialog, so Escape and the focus trap keep working.
        onOpenAutoFocus={(e) => { e.preventDefault(); panel.current?.focus(); }}>
        <DialogHeader className="sr-only">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Appearance, the agent, the terminal, and updates.</DialogDescription>
        </DialogHeader>

        <nav className="flex w-56 shrink-0 flex-col gap-0.5 border-r bg-muted/30 p-3">
          <div className="px-3 pt-1 pb-3 font-medium text-base">Settings</div>
          {SECTIONS.map(([id, label, Icon]) => (
            <Button
              key={id}
              variant={tab === id ? 'secondary' : 'ghost'}
              onClick={() => setTab(id)}
              className="w-full justify-start gap-2.5">
              <Icon />
              {label}
              {/* The one place a badge earns its keep: an update nobody has
                  looked at yet is the reason this page exists. */}
              {id === 'updates' && (updates.app.behind || updates.claude?.behind || updates.codex?.behind) && (
                <span className="ml-auto size-2 rounded-full bg-primary" />
              )}
            </Button>
          ))}
        </nav>

        <div ref={panel} tabIndex={-1} className="min-w-0 flex-1 overflow-y-auto px-8 py-7 outline-none">
          {tab === 'appearance' && <Appearance {...props} />}
          {tab === 'agent' && <Agent {...props} />}
          {tab === 'chat' && <ChatPrefs {...props} />}
          {tab === 'terminal' && <TerminalPrefs {...props} />}
          {tab === 'updates' && <Updates {...props} />}
          {tab === 'startup' && <Startup {...props} />}
          {tab === 'about' && <About {...props} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
