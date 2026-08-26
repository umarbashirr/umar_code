import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckIcon, DownloadIcon, ExternalLinkIcon, FolderOpenIcon, InfoIcon,
  MonitorIcon, MoonIcon, PaletteIcon, PowerIcon, RefreshCwIcon, SparklesIcon,
  SquareTerminalIcon, SunIcon,
} from 'lucide-react';

import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { sizeLabel } from '@/lib/attachments';
import { cn } from '@/lib/utils';
import { MODES } from '@/components/composer';
// The vanilla half owns the preview pane, which has to move out of the way of
// any dialog that opens over it.
import { parkPreview, ZOOM_STEPS } from '../../app.js';

const SECTIONS = [
  ['appearance', 'Appearance', PaletteIcon],
  ['agent', 'Agent', SparklesIcon],
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
    <div className="flex items-center gap-6 py-4">
      <div className="min-w-0 flex-1">
        <div className="text-sm">{label}</div>
        {hint && <div className="mt-1 text-[13px] text-muted-foreground leading-relaxed">{hint}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

function Section({ title, note, children }) {
  return (
    <div className="mb-9">
      <h3 className="font-medium text-base">{title}</h3>
      {note && <p className="mt-1.5 text-[13px] text-muted-foreground leading-relaxed">{note}</p>}
      <div className="mt-2 divide-y divide-border/60">{children}</div>
    </div>
  );
}

function Segmented({ value, options, onChange }) {
  return (
    <div className="flex items-center gap-1 rounded-lg border p-1">
      {options.map(([v, label, Icon]) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={cn(
            'flex h-8 items-center gap-2 rounded-md px-3 text-[13px] transition-colors',
            v === value ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}>
          {Icon && <Icon className="size-4" />}
          {label}
        </button>
      ))}
    </div>
  );
}

// A real switch rather than a checkbox: at this size the travel is what tells
// you it is a setting and not a form field.
function Switch({ on, onClick, ...props }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onClick}
      className={cn(
        'relative h-6 w-11 shrink-0 rounded-full border transition-colors',
        on ? 'border-primary bg-primary' : 'border-border bg-muted',
      )}
      {...props}>
      <span
        className={cn(
          'absolute top-0.5 size-4.5 rounded-full bg-background shadow-sm transition-[left]',
          on ? 'left-[22px]' : 'left-0.5',
        )} />
    </button>
  );
}

// A plain <select>. The Radix one in this project is built for the composer's
// pill and fights a settings row's sizing for no benefit here.
function Picker({ value, onChange, children, className }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        'h-9 min-w-36 rounded-md border bg-transparent px-3 text-sm outline-none',
        'focus-visible:ring-[3px] focus-visible:ring-ring/50',
        className,
      )}>
      {children}
    </select>
  );
}

const Mono = ({ children, title }) => (
  <span className="truncate font-mono text-[13px] text-muted-foreground" title={title || children}>{children}</span>
);

function Appearance({ settings, set }) {
  const a = settings.appearance;
  return (
    <Section title="Appearance">
      <Row label="Theme" hint="System follows the desktop while the window is open.">
        <Segmented
          value={a.theme}
          options={THEMES}
          onChange={(theme) => set({ appearance: { theme } })} />
      </Row>
      <Row
        label="Interface size"
        hint="Scales the whole shell. The preview keeps the page's own zoom.">
        <Picker value={String(a.zoom)} onChange={(z) => set({ appearance: { zoom: Number(z) } })}>
          {ZOOM_STEPS.map((z) => (
            <option key={z} value={String(z)}>{Math.round(z * 100)}%</option>
          ))}
        </Picker>
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
            <Picker value={agent.model} onChange={agent.changeModel}>
              {!agent.model && <option value="">Pick a model</option>}
              {agent.models.map((m) => (
                <option key={m.value} value={m.value}>{m.displayName || m.value}</option>
              ))}
            </Picker>
          )}
        {custom && (
          <button
            type="button"
            onClick={() => agent.forgetModel(agent.model)}
            className="h-9 rounded-md border px-3 text-[13px] text-muted-foreground hover:text-foreground">
            Forget
          </button>
        )}
      </Row>
      <Row
        label="Another model name"
        hint={agent.driver?.endpoint && agent.driver.endpoint !== 'anthropic'
          ? `${agent.driver.endpoint} decides which names work. Type one it routes.`
          : 'For a name this app has not been told about. It is kept for next time.'}>
        <input
          value={draft}
          placeholder="e.g. claude-sonnet-4-5"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          className={cn(
            'h-9 min-w-56 rounded-md border bg-transparent px-3 text-sm outline-none',
            'placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50',
          )}
        />
        <button
          type="button"
          disabled={!draft.trim()}
          onClick={add}
          className="h-9 rounded-md border px-3 text-[13px] disabled:opacity-40">
          Use it
        </button>
      </Row>
    </>
  );
}

function Agent({ settings, set, agent, updates }) {
  const claude = updates.claude || {};
  const usingSystem = settings.claude.binary === 'path';
  const system = claude.system;
  const bundled = claude.bundled;

  return (
    <>
      <Section title="New chats" note="What a chat starts on. Changing it here changes the chats already open too.">
        <ModelRow agent={agent} />
        <Row label="Permission mode" hint={MODES.find(([v]) => v === settings.agent.mode)?.[2]}>
          <Picker value={settings.agent.mode} onChange={(mode) => set({ agent: { mode } })}>
            {MODES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </Picker>
        </Row>
      </Section>

      <Section
        title="Claude CLI"
        note="Which binary the agent starts. A chat already running keeps the one it started with.">
        <Row
          label="Bundled with Tandem"
          hint={bundled?.path || 'Not found in this build.'}>
          <Mono>{bundled?.version || '—'}</Mono>
          <Button
            variant={usingSystem ? 'outline' : 'default'}
            className="h-9"
            disabled={!usingSystem}
            onClick={() => set({ claude: { binary: 'bundled' } })}>
            {usingSystem ? 'Use' : 'In use'}
          </Button>
        </Row>
        <Row
          label="Yours, on PATH"
          hint={system?.path || 'No separate claude found on your PATH.'}>
          <Mono>{system?.version || '—'}</Mono>
          <Button
            variant={usingSystem ? 'default' : 'outline'}
            className="h-9"
            disabled={!system || usingSystem}
            onClick={() => set({ claude: { binary: 'path' } })}>
            {usingSystem ? 'In use' : 'Use'}
          </Button>
        </Row>
      </Section>
    </>
  );
}

const DEFAULT_STACK = 'ui-monospace, SFMono-Regular, Menlo, "Cascadia Code", monospace';

// Monospace faces worth offering if the machine has them. Listing a font nobody
// has installed gets you a dropdown of choices that all render identically, so
// this is only the candidate set; what survives detection is the menu.
const MONO = [
  'JetBrains Mono', 'JetBrainsMono Nerd Font Mono', 'Fira Code', 'FiraCode Nerd Font Mono',
  'Cascadia Code', 'Cascadia Mono', 'Source Code Pro', 'IBM Plex Mono', 'Hack', 'Hack Nerd Font Mono',
  'Iosevka', 'Inconsolata', 'Roboto Mono', 'Noto Sans Mono', 'DejaVu Sans Mono', 'Liberation Mono',
  'Ubuntu Mono', 'Ubuntu Sans Mono', 'Menlo', 'Monaco', 'SF Mono', 'Consolas', 'Courier New',
];

// document.fonts.check answers true for everything in Electron, fake names
// included, so it cannot be used here. Measuring instead does work: a string
// drawn in an installed font comes out a different width from the generic it
// would otherwise fall back to. Three generics, because a font that happens to
// be the default monospace matches that one baseline exactly.
function installedMono() {
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    const probe = 'mmmmmmmmmmlliWWW0O';
    const width = (font) => { ctx.font = font; return ctx.measureText(probe).width; };
    const bases = ['monospace', 'serif', 'sans-serif'];
    const baseline = Object.fromEntries(bases.map((b) => [b, width(`72px ${b}`)]));
    return MONO.filter((f) => bases.some((b) => width(`72px "${f}", ${b}`) !== baseline[b]));
  } catch {
    return [];
  }
}

function TerminalPrefs({ settings, set }) {
  const t = settings.terminal;
  const fonts = useMemo(installedMono, []);
  // A stack typed into settings.json by hand still has to be selectable, or
  // opening this page would silently reset it to whatever sits at the top.
  const known = [DEFAULT_STACK, ...fonts.map((f) => `"${f}", ${DEFAULT_STACK}`)];
  const custom = known.includes(t.fontFamily) ? null : t.fontFamily;

  return (
    <Section title="Terminal" note="Applies to the tabs already open as well as new ones.">
      <Row label="Font size">
        <Picker
          value={String(t.fontSize)}
          onChange={(v) => set({ terminal: { fontSize: Number(v) } })}>
          {[10, 11, 12, 13, 14, 15, 16, 18, 20].map((n) => <option key={n} value={String(n)}>{n}px</option>)}
        </Picker>
      </Row>
      <Row
        label="Font family"
        hint={fonts.length
          ? `${fonts.length} monospace faces found on this machine.`
          : 'No named monospace faces found, so this falls back to the system stack.'}>
        <Picker
          className="w-64"
          value={custom || t.fontFamily}
          onChange={(fontFamily) => set({ terminal: { fontFamily } })}>
          <option value={DEFAULT_STACK}>System default</option>
          {fonts.map((f) => (
            <option key={f} value={`"${f}", ${DEFAULT_STACK}`}>{f}</option>
          ))}
          {custom && <option value={custom}>Custom (from settings.json)</option>}
        </Picker>
      </Row>
    </Section>
  );
}

function Progress({ received, total }) {
  const pct = total ? Math.min(100, Math.round((received / total) * 100)) : 0;
  return (
    <div className="w-56">
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1.5 text-right text-[13px] text-muted-foreground">
        {sizeLabel(received)} of {sizeLabel(total)}
      </div>
    </div>
  );
}

function Updates({ settings, set, updates }) {
  const { app, claude, kind, progress, file, checking } = updates;
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
            ? <Progress received={progress.received} total={progress.total} />
            : (
              <>
                <Button
                  variant="outline"
                  className="h-9 gap-2"
                  disabled={checking}
                  onClick={updates.check}>
                  <RefreshCwIcon className={cn('size-4', checking && 'animate-spin')} />
                  Check
                </Button>
                {behind && app.asset && kind !== 'dev' && (
                  file
                    ? (
                      <Button
                        className="h-9 gap-2"
                        disabled={updates.installing || updates.installed}
                        onClick={() => updates.install()}>
                        {updates.installing
                          ? <RefreshCwIcon className="size-4 animate-spin" />
                          : <CheckIcon className="size-4" />}
                        {updates.installed ? 'Installed' : updates.installing ? 'Installing' : 'Install'}
                      </Button>
                    )
                    : (
                      <Button className="h-9 gap-2" onClick={updates.download}>
                        <DownloadIcon className="size-4" />
                        Download {app.asset.size ? sizeLabel(app.asset.size) : ''}
                      </Button>
                    )
                )}
                {behind && app.page && (
                  <Button variant="ghost" className="h-9 gap-2" onClick={updates.openPage}>
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
              className="h-9 gap-2"
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
            <Button variant="outline" className="h-9" onClick={updates.openPage}>Open release</Button>
          </Row>
        )}

        <Row label="Check on launch" hint="One request to GitHub, cached for six hours.">
          <Switch
            on={settings.startup.checkUpdates}
            onClick={() => set({ startup: { checkUpdates: !settings.startup.checkUpdates } })} />
        </Row>
      </Section>

      <Section
        title="Claude CLI"
        note="The bundled binary only moves when Tandem does. Your own copy updates whenever you update it.">
        <Row
          label={claude.behind ? `${claude.latest} is out` : 'Up to date'}
          hint={claude.running?.version
            ? `Running ${claude.running.version}${claude.latest ? `, latest is ${claude.latest}` : ''}.`
            : 'No version reported yet.'}>
          {claude.canSwitch && (
            <Button className="h-9" onClick={() => set({ claude: { binary: 'path' } })}>
              Use yours ({claude.system.version})
            </Button>
          )}
        </Row>
      </Section>

      {updates.error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-destructive text-sm">
          {updates.error}
        </p>
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
        <Switch on={s.reopenProject} onClick={() => set({ startup: { reopenProject: !s.reopenProject } })} />
      </Row>
      <Row label="Check for updates on launch">
        <Switch on={s.checkUpdates} onClick={() => set({ startup: { checkUpdates: !s.checkUpdates } })} />
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
            className="h-9 gap-2"
            onClick={() => window.tandem.settings.reveal()}>
            <FolderOpenIcon className="size-4" /> Show
          </Button>
        </Row>
      </Section>

      <Section title="Start over" note="Puts every setting on this page back to its default.">
        <Row label="Reset settings">
          <Button variant="outline" className="h-9 text-destructive" onClick={reset}>Reset</Button>
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

        <nav className="w-56 shrink-0 space-y-0.5 border-r bg-muted/30 p-3">
          <div className="px-3 pt-1 pb-3 font-medium text-base">Settings</div>
          {SECTIONS.map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={cn(
                'flex h-9 w-full items-center gap-2.5 rounded-md px-3 text-sm transition-colors',
                tab === id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}>
              <Icon className="size-4" />
              {label}
              {/* The one place a badge earns its keep: an update nobody has
                  looked at yet is the reason this page exists. */}
              {id === 'updates' && (updates.app.behind || updates.claude?.canSwitch) && (
                <span className="ml-auto size-2 rounded-full bg-primary" />
              )}
            </button>
          ))}
        </nav>

        <div ref={panel} tabIndex={-1} className="min-w-0 flex-1 overflow-y-auto px-8 py-7 outline-none">
          {tab === 'appearance' && <Appearance {...props} />}
          {tab === 'agent' && <Agent {...props} />}
          {tab === 'terminal' && <TerminalPrefs {...props} />}
          {tab === 'updates' && <Updates {...props} />}
          {tab === 'startup' && <Startup {...props} />}
          {tab === 'about' && <About {...props} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
