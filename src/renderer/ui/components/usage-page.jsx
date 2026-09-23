/* Usage: what every agent has spent, across chats, on one page. Tokens and
   money come from the ledger main keeps of each chat's meter; plan limits come
   from whichever chat of that CLI is still running, because only a live
   session can ask. */
import { useCallback, useEffect, useState } from 'react';
import { RefreshCwIcon, XIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ProviderLogo } from '@/components/provider-logo';
import { PROVIDERS } from '@/components/settings-panel';
import { PlanRow } from '@/components/usage-meter';
import { blankUsage, compact, money, shortModel, totals } from '@/lib/usage';

const DAY = 24 * 60 * 60 * 1000;
const COLUMNS = ['Input', 'Cache read', 'Cache write', 'Output', 'Cost'];
// The CLIs that answer a plan query at all. The rest bill some other way.
const REPORTS_PLAN = new Set(['claude', 'codex']);

// The same arithmetic the meter uses, one model at a time, so the page and the
// popover never disagree about what a model cost.
const priced = (models) => Object.entries(models)
  .map(([model, m]) => ({ ...totals({ ...blankUsage(), banked: { [model]: m } }), model, chats: m.chats }))
  .sort((a, b) => b.cost - a.cost || (b.input + b.output) - (a.input + a.output));

function Grid({ children, className = '' }) {
  return (
    <div className={`grid grid-cols-[minmax(0,1fr)_repeat(5,5.5rem)] items-baseline gap-x-3 ${className}`}>
      {children}
    </div>
  );
}

const Num = ({ children }) => <span className="text-right font-mono tabular-nums">{children}</span>;

function Provider({ id, state, models, plan }) {
  const label = PROVIDERS[id]?.label || id;
  const rows = priced(models || {});
  const cost = rows.reduce((n, r) => n + r.cost, 0);
  const unpriced = rows.some((r) => r.unpriced);
  const limits = plan?.rate_limits;

  return (
    <section className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex items-center gap-2">
        <ProviderLogo id={id} className="size-4" />
        <span className="font-medium">{label}</span>
        {state?.version && <span className="text-muted-foreground text-xs">{state.version}</span>}
        {state && !state.installed && <span className="text-muted-foreground text-xs">not installed</span>}
        {rows.length > 0 && (
          <span className="ml-auto font-mono tabular-nums">{unpriced && !cost ? '—' : money(cost)}</span>
        )}
      </div>

      {rows.length ? (
        <div className="flex flex-col gap-1 text-xs">
          <Grid className="text-muted-foreground">
            <span>Model</span>
            {COLUMNS.map((c) => <span key={c} className="text-right">{c}</span>)}
          </Grid>
          {rows.map((r) => (
            <Grid key={r.model} className="border-t pt-1">
              <span className="min-w-0 truncate" title={`${r.model}, ${r.chats} ${r.chats === 1 ? 'chat' : 'chats'}`}>
                {shortModel(r.model)}
              </span>
              <Num>{compact(r.input)}</Num>
              <Num>{compact(r.cacheRead)}</Num>
              <Num>{compact(r.cacheWrite)}</Num>
              <Num>{compact(r.output)}</Num>
              <Num>{r.unpriced ? '—' : money(r.cost)}</Num>
            </Grid>
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">Nothing spent in a chat yet.</p>
      )}

      {REPORTS_PLAN.has(id) && (
        limits ? (
          <div className="flex flex-col gap-2 border-t pt-3 text-xs">
            <div className="font-medium">Plan{plan.subscription_type ? ` · ${plan.subscription_type}` : ''}</div>
            {limits.five_hour && <PlanRow label="5 hours" limit={limits.five_hour} />}
            {limits.seven_day && <PlanRow label="7 days" limit={limits.seven_day} />}
            {limits.seven_day_opus && <PlanRow label="7 days, Opus" limit={limits.seven_day_opus} />}
          </div>
        ) : (
          <p className="border-t pt-3 text-muted-foreground text-xs">
            Plan limits show here while a {label} chat is running: only a live session can ask for them.
          </p>
        )
      )}
    </section>
  );
}

export function UsagePage({ providers, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    window.tandem.agent.allUsage()
      .then(setData)
      .catch(() => setData({ providers: {}, plans: {}, chats: 0 }))
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);

  const onKeyDown = (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented) onClose();
  };

  // Every CLI this build knows, installed or not, plus any the ledger has that
  // is no longer on the list: its spend still happened.
  const states = Object.fromEntries((providers || []).map((p) => [p.id, p]));
  const ids = [...new Set([
    ...Object.keys(PROVIDERS),
    ...Object.keys(data?.providers || {}),
  ])].filter((id) => states[id]?.installed || data?.providers?.[id] || data?.plans?.[id]);
  const days = data?.since ? Math.max(1, Math.ceil((Date.now() - data.since) / DAY)) : 0;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground" onKeyDown={onKeyDown}>
      <div className="flex h-[38px] flex-none items-center gap-1 border-b border-border/60 pr-2 pl-4 text-sm text-foreground/90">
        <span className="truncate">Usage</span>
        <Button variant="ghost" size="icon" className="ml-auto size-7" title="Read again" onClick={load} disabled={loading}>
          <RefreshCwIcon className={loading ? 'animate-spin' : ''} />
        </Button>
        <Button variant="ghost" size="icon" className="size-7" title="Back to the chat (Esc)" onClick={onClose}>
          <XIcon />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 text-sm">
          <p className="text-muted-foreground text-xs leading-relaxed">
            {data?.chats
              ? `${data.chats} ${data.chats === 1 ? 'chat' : 'chats'} over the last ${days} ${days === 1 ? 'day' : 'days'}, counted on this machine. Older chats drop off after 30 days.`
              : 'Chats count here once they have spent something. Older chats drop off after 30 days.'}
            {' '}Costs are API list prices, for scale: a subscription bills against its plan limits instead.
          </p>
          {!data && <p className="text-muted-foreground text-xs">Reading…</p>}
          {data && ids.map((id) => (
            <Provider key={id} id={id} state={states[id]} models={data.providers?.[id]} plan={data.plans?.[id]} />
          ))}
        </div>
      </div>
    </div>
  );
}
