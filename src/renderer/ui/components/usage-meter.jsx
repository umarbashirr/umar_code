import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { compact, money, resetsIn, shortModel } from '@/lib/usage';

// The window fills up long before anything is wrong, so the meter stays grey
// through the range where the number is only interesting, and changes colour
// only where it starts to mean something.
const toneOf = (pct) => (pct >= 90 ? 'text-destructive' : pct >= 70 ? 'text-[hsl(var(--warning))]' : 'text-muted-foreground');

// One shade per category, darkest first, so the bar reads as a single object
// rather than a pie chart. Anything past the last step shares the faintest one.
const SHADES = [0.85, 0.66, 0.52, 0.40, 0.30, 0.22, 0.16];
const shade = (i) => `hsl(var(--foreground) / ${SHADES[Math.min(i, SHADES.length - 1)]})`;

// Biggest first, so the darkest band is the one filling the window and the bar
// and the list below it agree about which category that is.
const spend = (detail) => (detail?.categories || [])
  .filter((c) => c.tokens > 0 && !c.isDeferred && !/free/i.test(c.name))
  .sort((a, b) => b.tokens - a.tokens);

function Ring({ pct }) {
  const r = 5.25;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 14 14" className="-rotate-90 size-3.5 shrink-0" aria-hidden="true">
      <circle cx="7" cy="7" r={r} fill="none" stroke="currentColor" strokeWidth="1.75" className="opacity-20" />
      <circle
        cx="7" cy="7" r={r} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - Math.min(1, pct / 100))} />
    </svg>
  );
}

function Row({ label, value, note, swatch, dim }) {
  return (
    <div className="flex items-baseline gap-2">
      {swatch && <span className="size-2 shrink-0 translate-y-px rounded-[2px]" style={{ background: swatch }} />}
      <span className={cn('min-w-0 truncate', dim && 'text-muted-foreground')}>{label}</span>
      <span className="ml-auto shrink-0 font-mono tabular-nums">{value}</span>
      {note && <span className="w-14 shrink-0 text-right text-muted-foreground">{note}</span>}
    </div>
  );
}

function Meter({ pct, className }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={cn('h-full rounded-full transition-[width] duration-500', className || 'bg-foreground/70')}
        style={{ width: `${Math.min(100, pct)}%` }} />
    </div>
  );
}

// The window, drawn as what is in it when the CLI will say, and as one bar when
// it will not. `categories` come straight from /context, minus the row for the
// space still free: that is the track showing through.
function ContextBar({ pct, detail }) {
  const rows = spend(detail);
  const max = detail?.rawMaxTokens || 0;
  if (!rows.length || !max) return <Meter pct={pct} />;
  return (
    <div className="flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-muted">
      {rows.map((c, i) => (
        <div key={c.name} style={{ width: `${(c.tokens / max) * 100}%`, background: shade(i) }} />
      ))}
    </div>
  );
}

function PlanRow({ label, limit }) {
  const pct = Math.round(limit?.utilization ?? 0);
  const left = resetsIn(limit?.resets_at);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline gap-2">
        <span className="text-muted-foreground">{label}</span>
        <span className="ml-auto font-mono tabular-nums">{pct}%</span>
        {left && <span className="w-14 shrink-0 text-right text-muted-foreground">{left} left</span>}
      </div>
      <Meter pct={pct} className={pct >= 90 ? 'bg-destructive' : pct >= 70 ? 'bg-[hsl(var(--warning))]' : 'bg-foreground/70'} />
    </div>
  );
}

// Sits in the composer footer. The running numbers come from the message stream
// and are always current; the breakdown behind them is asked for only when
// somebody opens this, because it costs a round trip to the running session.
export function UsageMeter({ usage, chat }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const [plan, setPlan] = useState(null);
  const [asked, setAsked] = useState(false);
  const [why, setWhy] = useState(null);

  // A chat that has been parked has no session to answer, and a turn in flight
  // holds the request until it ends. Asking again on every finished turn is what
  // makes the panel fill in by itself rather than sitting on "reading" forever,
  // and the last good answer stays up meanwhile: a section that vanishes reads
  // as a bug, and a slightly stale one is still true of what it was read from.
  useEffect(() => {
    if (!open || !chat) return undefined;
    let live = true;
    window.tandem.agent.usage(chat).then((r) => {
      if (!live) return;
      if (r?.context?.categories) setDetail(r.context);
      if (r?.plan && !r.plan.error) setPlan(r.plan);
      setWhy(r?.context?.error || null);
      setAsked(true);
    }).catch((e) => { if (live) { setWhy(e?.message || String(e)); setAsked(true); } });
    return () => { live = false; };
  }, [open, chat, usage.turns]);

  // Nothing has been spent yet, and a meter reading zero is just noise.
  if (!usage.any) return null;

  // The CLI measures against the window it will actually compact at, which on a
  // 1M model is often 200k. Its own number wins when it has one.
  const pct = detail?.percentage ?? usage.percent;
  const used = detail?.totalTokens || usage.context;
  const max = detail?.rawMaxTokens || usage.window;
  const deferred = (detail?.categories || []).filter((c) => c.isDeferred && c.tokens > 0);
  const limits = plan?.rate_limits;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="xs"
          title="What this chat has used"
          className={cn('h-7 gap-1.5 rounded-full px-3 font-normal', toneOf(pct))}>
          <Ring pct={pct} />
          <span className="font-mono tabular-nums">{pct}%</span>
          {!usage.unpriced && (
            <>
              <span className="opacity-40">·</span>
              <span className="font-mono tabular-nums">{money(usage.cost)}</span>
            </>
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent align="start" side="top" className="flex flex-col w-[330px] gap-3.5 p-3.5 text-xs">
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline gap-2">
            <span className="font-medium">Context</span>
            <span className={cn('ml-auto font-mono tabular-nums', toneOf(pct))}>{pct}%</span>
          </div>
          <ContextBar pct={pct} detail={detail} />
          <div className="flex items-baseline gap-2 text-muted-foreground">
            <span className="font-mono tabular-nums">{compact(used)} of {compact(max)}</span>
            {usage.model && <span className="ml-auto truncate">{shortModel(usage.model)}</span>}
          </div>
        </div>

        {!detail && (
          <p className="text-muted-foreground">
            {!asked ? 'Reading the breakdown…'
              : why ? `No breakdown: ${why}`
              : 'The breakdown arrives once this chat is idle.'}
          </p>
        )}

        {!!detail?.categories?.length && (
          <div className="flex flex-col gap-1">
            {spend(detail).map((c, i) => (
              <Row key={c.name} label={c.name} value={compact(c.tokens)} swatch={shade(i)} />
            ))}
            <Row label="Free" value={compact(Math.max(0, max - used))} swatch="hsl(var(--muted))" dim />
            {deferred.length > 0 && (
              <p className="pt-1 text-muted-foreground">
                {deferred.length} deferred tool {deferred.length === 1 ? 'schema' : 'schemas'} sit outside the window until searched for.
              </p>
            )}
          </div>
        )}

        <div className="flex flex-col gap-1 border-t pt-3">
          <div className="mb-1.5 font-medium">This chat</div>
          <Row label="Fresh input" value={compact(usage.input)} />
          <Row label="Cache read" value={compact(usage.cacheRead)} note="90% off" />
          <Row label="Cache write" value={compact(usage.cacheWrite)} note="+25%" />
          <Row label="Output" value={compact(usage.output)} />
          <div className="flex items-baseline gap-2 border-t pt-1.5">
            <span className="font-medium">At API rates</span>
            <span className="ml-auto font-mono tabular-nums">
              {usage.unpriced ? '—' : money(usage.cost)}
            </span>
            <span className="w-14 shrink-0 text-right text-muted-foreground">
              {usage.turns} {usage.turns === 1 ? 'turn' : 'turns'}
            </span>
          </div>
          {usage.rows.length > 1 && (
            <div className="flex flex-col gap-1 pt-1.5">
              {usage.rows.map((r) => (
                <Row
                  key={r.model}
                  label={shortModel(r.model)}
                  value={r.cost ? money(r.cost) : '—'}
                  note={compact(r.tokens)}
                  dim />
              ))}
            </div>
          )}
        </div>

        {limits && (
          <div className="flex flex-col gap-2 border-t pt-3">
            <div className="font-medium">
              Plan{plan?.subscription_type ? ` · ${plan.subscription_type}` : ''}
            </div>
            {limits.five_hour && <PlanRow label="5 hours" limit={limits.five_hour} />}
            {limits.seven_day && <PlanRow label="7 days" limit={limits.seven_day} />}
            {limits.seven_day_opus && <PlanRow label="7 days, Opus" limit={limits.seven_day_opus} />}
          </div>
        )}

        <p className="border-t pt-3 text-muted-foreground leading-relaxed">
          {usage.unpriced
            ? 'No list price is known for this model, so the tokens are counted and the money is left blank rather than guessed at.'
            : plan?.rate_limits_available === false || !limits
              ? 'A subscription is not billed per token. The figure is what these tokens would cost at API list prices.'
              : 'The dollar figure is API list prices, for scale. Your plan bills against the windows above instead.'}
          {usage.estimated && ' Priced here, not by the CLI.'}
        </p>
      </PopoverContent>
    </Popover>
  );
}
