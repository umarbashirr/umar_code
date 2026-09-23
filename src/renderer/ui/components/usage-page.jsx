/* Usage: what every CLI has spent, on one page. An Overall tab adds them up;
   each CLI then gets a tab with its plan windows, its days, models and
   projects. Claude and Codex are read from their own transcripts, so the page
   has history from the first time it opens; the rest only know what Tandem's
   chats recorded. Money is API list prices, for scale. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCwIcon, XIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ProviderLogo } from '@/components/provider-logo';
import { PROVIDERS } from '@/components/settings-panel';
import { PlanRow } from '@/components/usage-meter';
import { blankUsage, compact, money, shortModel, totals } from '@/lib/usage';
import { cn } from '@/lib/utils';

const DAY = 24 * 60 * 60 * 1000;
const COUNTS = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'costUSD'];

const dayKey = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
// The last n calendar days, oldest first, today last.
const lastDays = (n) => Array.from({ length: n }, (_, i) => dayKey(Date.now() - (n - 1 - i) * DAY));

// {model: counts} maps added together.
function merge(...maps) {
  const out = {};
  for (const map of maps) {
    for (const [model, m] of Object.entries(map || {})) {
      const into = (out[model] ||= Object.fromEntries(COUNTS.map((k) => [k, 0])));
      for (const k of COUNTS) into[k] += m[k] || 0;
    }
  }
  return out;
}

// The popover's own arithmetic, so the two never disagree about a model's cost.
const price = (models) => totals({ ...blankUsage(), banked: models });
const tokensOf = (t) => t.input + t.output + t.cacheRead + t.cacheWrite;
const spanOf = (byDay, n) => merge(...lastDays(n).map((d) => byDay?.[d]));

function Stat({ label, models }) {
  const t = price(models);
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border p-3">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="font-mono text-lg tabular-nums">
        {t.cost ? money(t.cost) : compact(tokensOf(t))}
        {!t.cost && <span className="ml-1 text-muted-foreground text-xs">tokens</span>}
      </span>
      <span className="truncate text-muted-foreground text-xs" title="Fresh input and cache writes, output, cache reads">
        {compact(t.input + t.cacheWrite)} in · {compact(t.output)} out · {compact(t.cacheRead)} cached
      </span>
      {t.cost > 0 && t.unpriced && <span className="text-muted-foreground text-[11px]">plus models with no list price</span>}
    </div>
  );
}

function Stats({ byDay }) {
  return (
    <div className="grid grid-cols-3 gap-3">
      <Stat label="Today" models={spanOf(byDay, 1)} />
      <Stat label="Last 7 days" models={spanOf(byDay, 7)} />
      <Stat label="Last 30 days" models={spanOf(byDay, 30)} />
    </div>
  );
}

// One bar per day. Height is every token the day moved, cache included, since
// that is the one measure every CLI reports; the tooltip carries the money.
function Days({ byDay }) {
  const days = lastDays(30).map((d) => ({ d, t: price(byDay?.[d] || {}) }));
  const max = Math.max(1, ...days.map(({ t }) => tokensOf(t)));
  return (
    <section className="flex flex-col gap-2">
      <Heading>Tokens per day, last 30 days</Heading>
      <div className="flex h-24 items-end gap-[3px]">
        {days.map(({ d, t }) => (
          <div
            key={d}
            className="flex h-full flex-1 items-end"
            title={`${d}: ${compact(tokensOf(t))} tokens${t.cost ? `, ${money(t.cost)}` : ''}`}>
            <div className="w-full rounded-sm bg-foreground/60" style={{ height: `${(tokensOf(t) / max) * 100}%`, minHeight: tokensOf(t) ? 2 : 0 }} />
          </div>
        ))}
      </div>
      <div className="flex justify-between text-muted-foreground text-[11px]">
        <span>{days[0].d}</span>
        <span>today</span>
      </div>
    </section>
  );
}

const Heading = ({ children }) => <div className="font-medium text-xs">{children}</div>;
const Num = ({ children }) => <span className="text-right font-mono tabular-nums">{children}</span>;

function Grid({ children, className = '' }) {
  return (
    <div className={`grid grid-cols-[minmax(0,1fr)_repeat(5,5.5rem)] items-baseline gap-x-3 ${className}`}>
      {children}
    </div>
  );
}

// Rows of {label, models}, biggest first, with the five columns the popover uses.
function Table({ title, first, rows, limit }) {
  const priced = rows
    .map((r) => ({ ...r, t: price(r.models) }))
    .filter((r) => tokensOf(r.t) > 0)
    .sort((a, b) => b.t.cost - a.t.cost || tokensOf(b.t) - tokensOf(a.t))
    .slice(0, limit);
  if (!priced.length) return null;
  return (
    <section className="flex flex-col gap-1 text-xs">
      <Heading>{title}</Heading>
      <Grid className="text-muted-foreground">
        <span>{first}</span>
        {['Input', 'Cache read', 'Cache write', 'Output', 'Cost'].map((c) => <span key={c} className="text-right">{c}</span>)}
      </Grid>
      {priced.map(({ key, label, hint, t }) => (
        <Grid key={key} className="border-t pt-1">
          <span className="flex min-w-0 items-center gap-1.5 truncate" title={hint || label}>{label}</span>
          <Num>{compact(t.input)}</Num>
          <Num>{compact(t.cacheRead)}</Num>
          <Num>{compact(t.cacheWrite)}</Num>
          <Num>{compact(t.output)}</Num>
          <Num>{t.cost ? money(t.cost) : '—'}</Num>
        </Grid>
      ))}
    </section>
  );
}

const modelRows = (byDay) => Object.entries(spanOf(byDay, 30))
  .map(([model, m]) => ({ key: model, label: shortModel(model), hint: model, models: { [model]: m } }));

const projectName = (p) => (p === 'unknown' ? 'Unknown folder' : p.split(/[\\/]/).filter(Boolean).pop() || p);

const agoText = (t) => {
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours} hours ago` : `${Math.round(hours / 24)} days ago`;
};

function Plan({ id, plan }) {
  const label = PROVIDERS[id]?.label || id;
  if (!plan?.windows?.length) {
    return (
      <p className="rounded-lg border p-3 text-muted-foreground text-xs">
        {id === 'claude' || id === 'codex'
          ? `${label} did not report plan limits. It may be signed in with an API key, which is billed per token instead.`
          : `${label} does not report plan limits to Tandem.`}
      </p>
    );
  }
  const asOf = Math.min(...plan.windows.map((w) => w.asOf || Date.now()));
  return (
    <section className="flex flex-col gap-2.5 rounded-lg border p-3 text-xs">
      <div className="flex items-baseline gap-2">
        <Heading>Plan{plan.name ? ` · ${plan.name}` : ''}</Heading>
        {Date.now() - asOf > 5 * 60000 && (
          <span className="ml-auto text-muted-foreground">as of {agoText(asOf)}, from the last {label} session</span>
        )}
      </div>
      {plan.windows.map((w) => (
        <PlanRow key={w.id} label={w.label} limit={{ utilization: w.usedPercent, resets_at: w.resetsAt }} />
      ))}
      {plan.extra && (
        <div className="flex items-baseline gap-2">
          <span className="text-muted-foreground">Extra usage this month</span>
          <span className="ml-auto font-mono tabular-nums">
            {money(plan.extra.used)} of {money(plan.extra.limit)}
          </span>
        </div>
      )}
    </section>
  );
}

function ProviderTab({ id, p }) {
  const label = PROVIDERS[id]?.label || id;
  const projects = Object.entries(p.byProject || {}).map(([project, models]) => ({
    key: project, label: projectName(project), hint: project, models,
  }));
  const empty = !Object.keys(p.byDay || {}).length;
  return (
    <div className="flex flex-col gap-5">
      <Plan id={id} plan={p.plan} />
      {empty ? (
        <p className="text-muted-foreground text-xs">
          {p.source === 'transcripts'
            ? `No ${label} requests in the last 30 days.`
            : `Nothing spent in a ${label} chat in Tandem yet. ${label} keeps no usage history Tandem can read, so only chats run here count.`}
        </p>
      ) : (
        <>
          <Stats byDay={p.byDay} />
          <Days byDay={p.byDay} />
          <Table title="Models, last 30 days" first="Model" rows={modelRows(p.byDay)} />
          <Table title="Projects, last 30 days" first="Project" rows={projects} limit={10} />
          <p className="text-muted-foreground text-[11px]">
            {p.source === 'transcripts'
              ? `Read from ${label}'s own transcripts on this machine, so chats outside Tandem count too.`
              : 'Only chats run in Tandem count here.'}
          </p>
        </>
      )}
    </div>
  );
}

function OverallTab({ ids, data }) {
  const all = {};
  for (const id of ids) {
    for (const [day, models] of Object.entries(data[id]?.byDay || {})) all[day] = merge(all[day], models);
  }
  const perProvider = ids.map((id) => ({
    key: id,
    label: <><ProviderLogo id={id} className="size-3.5" />{PROVIDERS[id]?.label || id}</>,
    hint: PROVIDERS[id]?.label || id,
    models: spanOf(data[id]?.byDay, 30),
  }));
  const windows = ids.flatMap((id) => (data[id]?.plan?.windows || []).map((w) => ({ ...w, id: `${id}:${w.id}`, label: `${PROVIDERS[id]?.label || id}, ${w.label}` })));
  return (
    <div className="flex flex-col gap-5">
      <Stats byDay={all} />
      {windows.length > 0 && (
        <section className="flex flex-col gap-2.5 rounded-lg border p-3 text-xs">
          <Heading>Plan windows</Heading>
          {windows.map((w) => (
            <PlanRow key={w.id} label={w.label} limit={{ utilization: w.usedPercent, resets_at: w.resetsAt }} />
          ))}
        </section>
      )}
      <Days byDay={all} />
      <Table title="By CLI, last 30 days" first="CLI" rows={perProvider} />
      <Table title="Top models, last 30 days" first="Model" rows={modelRows(all)} limit={10} />
    </div>
  );
}

export function UsagePage({ providers, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState('overall');

  const load = useCallback(() => {
    setLoading(true);
    window.tandem.agent.allUsage()
      .then((r) => setData(r?.providers || {}))
      .catch(() => setData({}))
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);

  const onKeyDown = (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented) onClose();
  };

  // Installed CLIs, plus any with spend on record: a CLI removed since still
  // spent what it spent.
  const ids = useMemo(() => {
    const installed = new Set((providers || []).filter((p) => p.installed).map((p) => p.id));
    return Object.keys(PROVIDERS).filter((id) => installed.has(id) || Object.keys(data?.[id]?.byDay || {}).length);
  }, [providers, data]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground" onKeyDown={onKeyDown}>
      <div className="flex h-[38px] flex-none items-center gap-1 border-b border-border/60 pr-2 pl-4 text-sm text-foreground/90">
        <span className="truncate">Usage</span>
        <Button variant="ghost" size="icon" className="ml-auto size-7" title="Read again" onClick={load} disabled={loading}>
          <RefreshCwIcon className={cn(loading && 'animate-spin')} />
        </Button>
        <Button variant="ghost" size="icon" className="size-7" title="Back to the chat (Esc)" onClick={onClose}>
          <XIcon />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
        <Tabs value={tab} onValueChange={setTab} className="mx-auto max-w-3xl gap-5 text-sm">
          <TabsList variant="line" className="w-full justify-start border-b pb-1">
            <TabsTrigger value="overall" className="flex-none">Overall</TabsTrigger>
            {ids.map((id) => (
              <TabsTrigger key={id} value={id} className="flex-none">
                <ProviderLogo id={id} className="size-3.5" />
                {PROVIDERS[id]?.label || id}
              </TabsTrigger>
            ))}
          </TabsList>

          {!data ? (
            <p className="text-muted-foreground text-xs">Reading usage from each CLI's history…</p>
          ) : (
            <>
              <TabsContent value="overall"><OverallTab ids={ids} data={data} /></TabsContent>
              {ids.map((id) => (
                <TabsContent key={id} value={id}>
                  <ProviderTab id={id} p={data[id] || { byDay: {}, byProject: {}, plan: null, source: 'tandem' }} />
                </TabsContent>
              ))}
            </>
          )}

          <p className="text-muted-foreground text-[11px] leading-relaxed">
            Money is API list prices, for scale. A subscription bills against its plan windows instead. Models with no known list price show tokens only.
          </p>
        </Tabs>
      </div>
    </div>
  );
}
