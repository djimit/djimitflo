import { useState, useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';
import { api, type UsageAccount, type UsageAccountsResponse, type UsageLimitView, type UsageWindowId } from '../lib/api';

/**
 * Usage per provider account (llm_model_calls + worker_leases CLI sessions + inference state), read-only.
 * Plan limits come from docs/usage-plan-limits.json: a bar only when a number exists and the units compare.
 */
const WINDOWS: Array<{ id: UsageWindowId; label: string }> = [
  { id: '5h', label: 'last 5 h' }, { id: 'today', label: 'today (UTC)' }, { id: '7d', label: 'rolling 7 d' }, { id: 'month', label: 'month (UTC)' },
];
const fmt = (n: number | null) => (n === null ? 'unknown' : n.toLocaleString());
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

interface LegacyData {
  total_tokens: number; total_cost: number;
  daily_usage: { date: string; tokens: number; cost: number }[];
}

function StateBadge({ s }: { s: UsageAccount['state'] }) {
  if (s.state === 'limited') return <span className="text-xs px-2 py-0.5 rounded bg-red-500/15 text-red-500">limited since {when(s.since)}{s.until ? ` until ${when(s.until)}` : ''}</span>;
  if (s.state === 'backoff') return <span className="text-xs px-2 py-0.5 rounded bg-yellow-500/15 text-yellow-600">backoff until {when(s.until)}</span>;
  return <span className="text-xs px-2 py-0.5 rounded bg-green-500/15 text-green-600">no limit recorded</span>;
}

function LimitMeta({ l }: { l: UsageLimitView }) {
  return (
    <div className="text-foreground-secondary">
      {l.limit_text || '—'}
      {l.source_url ? <> · <a className="underline" href={l.source_url} target="_blank" rel="noreferrer">source</a></> : null}
      {l.checked_at ? ` · checked ${l.checked_at}` : ''}
      {l.confidence && l.confidence !== 'first_party' ? <span className="text-yellow-600"> · {l.confidence}</span> : null}
      {l.note ? <div className="italic">{l.note}</div> : null}
      {l.exceed_behaviour ? <div>when exceeded: {l.exceed_behaviour}</div> : null}
    </div>
  );
}

function LimitRow({ l }: { l: UsageLimitView }) {
  const head = `${l.plan} · ${l.window}`;
  if (l.limit === null) {
    return (
      <div className="text-xs mb-2">
        <div className="text-foreground">{head}: no published number</div>
        <LimitMeta l={l} />
        {l.unit_note && <div className="text-foreground-secondary italic">{l.unit_note}</div>}
      </div>
    );
  }
  if (!l.comparable) {
    return (
      <div className="text-xs mb-2">
        <div className="text-foreground">{head}: {l.limit.toLocaleString()} {l.unit} · measured {fmt(l.used)} {l.measured_unit}</div>
        {l.unit_note && <div className="text-yellow-600 italic">{l.unit_note}</div>}
        <LimitMeta l={l} />
      </div>
    );
  }
  const pct = Math.min(l.used_pct ?? 0, 100);
  const color = pct < 50 ? 'bg-green-500' : pct < 80 ? 'bg-yellow-500' : 'bg-red-500';
  return (
    <div className="mb-2">
      <div className="flex justify-between text-xs text-foreground-secondary mb-1">
        <span>{head}</span>
        <span>{fmt(l.used)} / {l.limit.toLocaleString()} {l.unit} ({l.used_pct}%)</span>
      </div>
      <div className="h-2 bg-background-elevated rounded-full overflow-hidden" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={head}>
        <div className={`h-full ${color} rounded-full`} style={{ width: `${pct}%` }} />
      </div>
      {l.unit_note && <div className="text-xs text-foreground-secondary italic mt-1">{l.unit_note}</div>}
      <div className="text-xs"><LimitMeta l={l} /></div>
    </div>
  );
}

function Limits({ a }: { a: UsageAccount }) {
  if (a.limits.length === 0) return null;
  const active = a.limits.filter((l) => l.active === true);
  const rest = a.limits.filter((l) => l.active !== true);
  return (
    <div>
      <div className="text-xs text-foreground-secondary mb-1">
        plan: {a.plan === 'unknown' ? 'unknown — set account_plan in docs/usage-plan-limits.json; all candidate plans shown' : a.plan}
      </div>
      {active.map((l) => <LimitRow key={`${l.plan}-${l.window}`} l={l} />)}
      {a.plan === 'unknown' ? rest.map((l) => <LimitRow key={`${l.plan}-${l.window}`} l={l} />) : rest.length > 0 && (
        <details>
          <summary className="text-xs text-foreground-secondary cursor-pointer">other plans (reference)</summary>
          {rest.map((l) => <LimitRow key={`${l.plan}-${l.window}`} l={l} />)}
        </details>
      )}
    </div>
  );
}

function AccountCard({ a }: { a: UsageAccount }) {
  return (
    <section aria-label={a.label} className="bg-background-secondary rounded-lg p-4 border border-border space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">{a.label}</h3>
        <StateBadge s={a.state} />
      </div>
      {a.state.reason && <p className="text-xs text-foreground-secondary">{a.state.reason}</p>}
      <table className="w-full text-xs">
        <thead><tr className="text-foreground-secondary"><th className="text-left">window</th><th className="text-right">calls</th><th className="text-right">tokens</th></tr></thead>
        <tbody>
          {WINDOWS.map((w) => {
            const s = a.windows[w.id];
            return (
              <tr key={w.id}>
                <td className="text-foreground-secondary">{w.label}</td>
                <td className="text-right text-foreground">{s.calls}</td>
                <td className="text-right text-foreground">{fmt(s.tokens)}{s.calls_without_tokens ? <span className="text-foreground-secondary"> (+{s.calls_without_tokens} unreported)</span> : null}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <Limits a={a} />
      <div className="text-xs text-foreground-secondary space-y-1">
        <div>cost basis: {a.cost.basis}{a.cost.observed_bases.length ? ` (ledger: ${a.cost.observed_bases.join(', ')})` : ''}
          {' · '}list price this month: {a.cost.list_price_usd_month === null ? 'unknown' : `$${a.cost.list_price_usd_month.toFixed(4)}`}
          {a.cost.calls_without_list_price_month ? ` (${a.cost.calls_without_list_price_month} calls unpriced)` : ''}</div>
        <div>last limit hit: {a.last_limit_hit ? `${when(a.last_limit_hit.at)} — ${a.last_limit_hit.message}` : 'none recorded'}</div>
        <div>last error: {a.last_error ? `${when(a.last_error.at)} — ${a.last_error.message}` : 'none recorded'}</div>
        {a.id === 'other' && <div>providers: {a.providers_seen.join(', ')}</div>}
      </div>
      {a.consumers_7d.length > 0 && (
        <details>
          <summary className="text-xs text-foreground-secondary cursor-pointer">consumers (7 d)</summary>
          <ul className="text-xs mt-1">
            {a.consumers_7d.map((c) => <li key={c.consumer} className="flex justify-between"><span>{c.consumer}</span><span>{c.calls} calls · {fmt(c.tokens)} tokens</span></li>)}
          </ul>
        </details>
      )}
    </section>
  );
}

export function UsagePage() {
  const [data, setData] = useState<UsageAccountsResponse | null>(null);
  const [legacy, setLegacy] = useState<LegacyData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api.getUsageAccounts(),
      api.getUsageTokens({ group_by: 'day' }).catch(() => null),
    ]).then(([accounts, tokens]) => {
      setData(accounts);
      if (tokens && tokens.total_tokens > 0) setLegacy({ total_tokens: tokens.total_tokens, total_cost: tokens.total_cost || 0, daily_usage: tokens.breakdown || [] });
    }).catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="flex items-center justify-center h-64"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent" /></div>;
  }
  if (error || !data) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-foreground">Usage</h1>
        <div className="bg-background-secondary rounded-lg p-6 text-center" role="alert">
          <AlertTriangle className="w-8 h-8 text-red-500 mx-auto mb-2" />
          <p className="text-foreground-secondary">{error ?? 'No usage data'}</p>
        </div>
      </div>
    );
  }
  const missing = Object.entries(data.sources).filter(([, v]) => v === 'missing').map(([k]) => k);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Usage</h1>
        <p className="text-foreground-secondary mt-1">Calls and tokens per provider account — model-call ledger and maker/checker CLI sessions.</p>
        <p className="text-xs text-foreground-secondary mt-1">{data.note}</p>
      </div>
      {missing.length > 0 && <p className="text-sm text-yellow-600" role="status">Source missing: {missing.join(', ')} — totals are partial.</p>}
      {data.plan_limits.error && <p className="text-sm text-yellow-600" role="status">Plan limits unreadable ({data.plan_limits.source}): {data.plan_limits.error}</p>}
      {data.plan_limits.invalid > 0 && <p className="text-sm text-yellow-600" role="status">{data.plan_limits.invalid} invalid plan-limit entries ignored ({data.plan_limits.source}).</p>}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {data.accounts.map((a) => <AccountCard key={a.id} a={a} />)}
      </div>

      {legacy && (
        <div>
          <h2 className="text-lg font-semibold text-foreground mb-3">Legacy token_usage_log</h2>
          <div className="bg-background-secondary rounded-lg p-4 text-sm text-foreground space-y-1">
            <div>Total: {legacy.total_tokens.toLocaleString()} tokens · ${legacy.total_cost.toFixed(4)}</div>
            {legacy.daily_usage.slice(-14).map((d) => (
              <div key={d.date} className="flex justify-between text-xs text-foreground-secondary"><span>{d.date}</span><span>{d.tokens.toLocaleString()} tokens · ${d.cost.toFixed(4)}</span></div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
