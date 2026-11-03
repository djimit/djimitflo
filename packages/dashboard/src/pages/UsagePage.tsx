import { useState, useEffect, useCallback, type FormEvent } from 'react';
import { AlertTriangle } from 'lucide-react';
import { api, type UsageAccount, type UsageAccountWide, type UsageAccountsResponse, type UsageLimitView, type UsageOperatorSnapshot, type UsagePctWindow,
  type UsageSnapshotPayload, type UsageWindowId } from '../lib/api';
import { fmtDate, LOCALE, since } from '../lib/format';
import { ACTION_PERMISSIONS, permissionError, useCan } from '../lib/permissions';
import { Button } from '../components/ui';

/**
 * Usage per provider account (llm_model_calls + worker_leases CLI sessions + inference state), read-only.
 * Plan limits come from docs/usage-plan-limits.json: a bar only when a number exists and the units compare.
 * The windows are Djimitflo's share, as recorded; account-wide Ollama figures come from the Ollama balance API
 * (OLLAMA_BALANCE_MODE), and are shown as unknown with the reason when it is off or failed — never 0.
 * Accounts without an account-wide source (Claude Max, ChatGPT Pro) show the latest operator snapshot of the vendor's usage page,
 * labelled operator-reported with its age (stale after 24 h); manage:config can report a new one.
 */
const WINDOWS: Array<{ id: UsageWindowId; label: string }> = [
  { id: '5h', label: 'last 5 h' }, { id: 'today', label: 'today (UTC)' }, { id: '7d', label: 'rolling 7 d' }, { id: 'month', label: 'month (UTC)' },
];
const fmt = (n: number | null) => (n === null ? 'unknown' : n.toLocaleString(LOCALE));
const when = (iso: string | null) => fmtDate(iso, { fallback: '—' });
const usd = (n: number) => `$${n.toFixed(2)}`;
const money = (n: number | undefined, currency: string | undefined) => (n === undefined ? 'unknown'
  : currency ? n.toLocaleString(LOCALE, { style: 'currency', currency }) : n.toLocaleString(LOCALE, { maximumFractionDigits: 2 }));

function Bar({ pct, label }: { pct: number; label: string }) {
  const p = Math.min(pct, 100);
  const color = p < 50 ? 'bg-green-500' : p < 80 ? 'bg-yellow-500' : 'bg-red-500';
  return (
    <div className="h-2 bg-background-elevated rounded-full overflow-hidden" role="meter" aria-valuenow={p} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <div className={`h-full ${color} rounded-full`} style={{ width: `${p}%` }} />
    </div>
  );
}

/** Ollama balance API figures (account-wide, every client on the account) next to Djimitflo's own 7 d share. */
function AccountWide({ u, a }: { u: UsageAccountWide; a: UsageAccount }) {
  if (!u.session && !u.weekly && !u.credits && !u.week) {
    return (
      <div className="text-xs text-foreground-secondary" role="status">
        Account-wide (Ollama): unknown — balance API {u.mode === 'off' ? 'off' : 'unavailable'} ({u.error ?? 'no data returned'})
      </div>
    );
  }
  const pct = (name: string, w: UsagePctWindow | null) => (
    <div>{w ? `${name}: ${fmt(w.used_pct)} % used · resets ${when(w.resets_at)}` : `${name}: unknown (not returned by the API)`}</div>
  );
  const c = u.credits;
  const share = a.windows['7d'].calls; const leases = a.lease_sessions?.['7d'] ?? 0;
  return (
    <div className="text-xs text-foreground space-y-0.5">
      <div className="text-foreground-secondary">Account-wide (Ollama balance API, fetched {when(u.fetched_at)})</div>
      {pct('session', u.session)}
      {pct('weekly', u.weekly)}
      <div>
        {c?.balance_usd !== undefined ? `purchased usage credits: ${usd(c.balance_usd)} left` : 'purchased usage credits: unknown (not returned by the API)'}
        {c?.included_balance_usd !== undefined ? ` · included credits: ${usd(c.included_balance_usd)}${c.included_allowance_usd !== undefined ? ` of ${usd(c.included_allowance_usd)}` : ''} left` : ''}
        {c?.included_period?.until ? ` (until ${when(c.included_period.until)})` : ''}
      </div>
      <div>
        account requests (7 d): {u.week?.request_count != null ? fmt(u.week.request_count) : 'unknown'}
        {' · '}Djimitflo's share: {fmt(share)} calls{leases ? ` (${fmt(leases)} of them CLI lease sessions, each many requests)` : ''}
        {u.week?.usage_value_usd != null ? ` · value of account requests at list rates: ${usd(u.week.usage_value_usd)}` : ''}
      </div>
      {u.error && <div className="text-yellow-600">partly unavailable: {u.error}</div>}
    </div>
  );
}

interface LegacyData {
  total_tokens: number; total_cost: number;
  daily_usage: { date: string; tokens: number; cost: number }[];
}

function StateBadge({ s }: { s: UsageAccount['state'] }) {
  if (s.state === 'limit_reached') return <span className="text-xs px-2 py-0.5 rounded bg-red-500/15 text-red-500">account limit reached{s.until ? ` until ${when(s.until)}` : ''}</span>;
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
  if (l.pct_source && l.used_pct !== null) {
    const by = l.pct_source === 'operator_snapshot' ? `operator-reported ${since(l.reported_at)}` : 'account-wide';
    return (
      <div className="mb-2">
        <div className="flex justify-between text-xs text-foreground-secondary mb-1">
          <span>{head}</span>
          <span>{fmt(l.used_pct)} % used ({by}){l.resets_at ? ` · resets ${when(l.resets_at)}` : ''}</span>
        </div>
        <Bar pct={l.used_pct} label={head} />
        {l.unit_note && <div className="text-xs text-foreground-secondary italic mt-1">{l.unit_note}</div>}
        <div className="text-xs"><LimitMeta l={l} /></div>
      </div>
    );
  }
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
  return (
    <div className="mb-2">
      <div className="flex justify-between text-xs text-foreground-secondary mb-1">
        <span>{head}</span>
        <span>{fmt(l.used)} / {l.limit.toLocaleString(LOCALE)} {l.unit} ({l.used_pct}%)</span>
      </div>
      <Bar pct={l.used_pct ?? 0} label={head} />
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

/** The latest operator-reported snapshot of the vendor's usage page; what was not reported reads unknown, never 0. */
function OperatorSnapshot({ s }: { s: UsageOperatorSnapshot }) {
  const pct = (name: string, w: UsageOperatorSnapshot['session']) => (w?.used_pct === undefined
    ? <div>{name}: unknown (not reported)</div>
    : (
      <div>
        <div className="flex justify-between">
          <span>{name}: {fmt(w.used_pct)} % used</span>
          <span className="text-foreground-secondary">{w.resets_at ? `resets ${when(w.resets_at)}` : 'reset time not reported'}</span>
        </div>
        <Bar pct={w.used_pct} label={`operator snapshot · ${name}`} />
      </div>
    ));
  const sl = s.spend_limit;
  return (
    <div role="group" aria-label="Operator snapshot" className="text-xs text-foreground space-y-1 border-l-2 border-border pl-2">
      <div className="text-foreground-secondary flex items-center gap-2">
        <span>operator-reported {since(s.reported_at)} ({when(s.reported_at)}){s.plan ? ` · plan ${s.plan}` : ''}</span>
        {s.stale && <span className="px-1.5 py-0.5 rounded bg-yellow-500/15 text-yellow-600" title="older than 24 h">stale</span>}
      </div>
      {pct('session', s.session)}
      {pct('weekly', s.weekly)}
      {s.model_weekly?.map((m) => (
        <div key={m.model}>
          {`${m.model} (weekly): ${m.used_pct === undefined ? 'unknown' : `${fmt(m.used_pct)} % used`}${m.resets_at ? ` · resets ${when(m.resets_at)}` : ''}${m.cap_note ? ` · ${m.cap_note}` : ''}`}
        </div>
      ))}
      {s.credits?.map((c) => (
        <div key={c.label}>
          {`${c.label}: ${money(c.remaining, c.currency)}${c.total !== undefined ? ` of ${money(c.total, c.currency)}` : ''} left${c.expires_at ? ` · expires ${when(c.expires_at)}` : ''}`}
        </div>
      ))}
      {sl && (
        <div>{`spend limit: ${money(sl.spent, sl.currency)} of ${money(sl.limit, sl.currency)}${sl.period ? ` (${sl.period})` : ''}${sl.auto_reload === undefined ? '' : ` · auto-reload ${sl.auto_reload ? 'on' : 'off'}`}`}</div>
      )}
      {s.by_product?.length ? (
        <div className="text-foreground-secondary">by product: {s.by_product.map((p) => <span key={p.product} className="mr-2">{`${p.product}: ${fmt(p.share_pct)} %`}</span>)}</div>
      ) : null}
      {s.note && <div className="italic text-foreground-secondary">{s.note}</div>}
    </div>
  );
}

const inputCls = 'w-full rounded border border-border bg-background px-2 py-1 text-foreground';
/** datetime-local (browser time zone) → ISO; empty → absent */
const isoOf = (v: string) => (v ? new Date(v).toISOString() : undefined);
const numOf = (v: string) => (v.trim() === '' ? undefined : Number(v));
/** drops undefined fields, so an empty input is absent (unknown), never 0 */
const compact = <T,>(o: T): T => JSON.parse(JSON.stringify(o)) as T;

/** Report what the vendor's usage page shows. Simple fields here; the rest (per-model, credits, spend limit, products) as JSON. */
function SnapshotForm({ account, onSaved }: { account: string; onSaved: () => void }) {
  const [f, setF] = useState({ plan: '', session: '', sessionReset: '', weekly: '', weeklyReset: '', note: '', extra: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setMsg(null);
    let extra: UsageSnapshotPayload = {};
    try { extra = f.extra.trim() ? JSON.parse(f.extra) as UsageSnapshotPayload : {}; } catch { setMsg('more fields: not valid JSON'); return; }
    const win = (pct: string, reset: string) => {
      const w = compact({ used_pct: numOf(pct), resets_at: isoOf(reset) });
      return Object.keys(w).length ? w : undefined;
    };
    const payload = compact<UsageSnapshotPayload>({ ...extra, plan: f.plan.trim() || undefined, session: win(f.session, f.sessionReset) ?? extra.session,
      weekly: win(f.weekly, f.weeklyReset) ?? extra.weekly, note: f.note.trim() || undefined });
    setBusy(true);
    try { await api.postUsageSnapshot(account, payload); setMsg('saved'); onSaved(); } catch (err) {
      setMsg(permissionError(err, ACTION_PERMISSIONS.usageSnapshot, 'snapshot not saved'));
    } finally { setBusy(false); }
  };
  const field = (k: keyof typeof f, label: string, props: Record<string, unknown> = {}) => (
    <label className="block">{label}
      <input aria-label={label} value={f[k]} onChange={(e) => setF((x) => ({ ...x, [k]: e.target.value }))} className={inputCls} {...props} />
    </label>
  );
  return (
    <details>
      <summary className="text-xs text-foreground-secondary cursor-pointer">Report a usage snapshot</summary>
      <form onSubmit={(e) => void submit(e)} className="text-xs space-y-1 mt-1">
        <p className="text-foreground-secondary">Copy the figures from the vendor&apos;s usage page. Leave a field empty when it is not shown: it then reads unknown, not 0.</p>
        {field('plan', 'plan')}
        <div className="grid grid-cols-2 gap-2">
          {field('session', 'session % used', { type: 'number', min: 0, max: 100, step: 0.1 })}
          {field('sessionReset', 'session resets at', { type: 'datetime-local' })}
          {field('weekly', 'weekly % used', { type: 'number', min: 0, max: 100, step: 0.1 })}
          {field('weeklyReset', 'weekly resets at', { type: 'datetime-local' })}
        </div>
        {field('note', 'note', { maxLength: 500 })}
        <label className="block">more fields (JSON: model_weekly, credits, spend_limit, by_product)
          <textarea aria-label="more fields (JSON)" value={f.extra} onChange={(e) => setF((x) => ({ ...x, extra: e.target.value }))} rows={3} className={`${inputCls} font-mono`}
            placeholder='{"spend_limit": {"spent": 12.5, "limit": 50, "currency": "USD", "period": "monthly", "auto_reload": false}}' />
        </label>
        <div className="flex items-center gap-2">
          <Button type="submit" disabled={busy}>Save snapshot</Button>
          {msg && <span role="status" className={msg === 'saved' ? 'text-green-600' : 'text-red-500'}>{msg}</span>}
        </div>
      </form>
    </details>
  );
}

function AccountCard({ a, onChanged }: { a: UsageAccount; onChanged: () => void }) {
  const canReport = useCan(ACTION_PERMISSIONS.usageSnapshot);
  const snapshotable = a.cost.basis === 'flat_subscription' || Boolean(a.operator_snapshot);
  return (
    <section aria-label={a.label} className="bg-background-secondary rounded-lg p-4 border border-border space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">{a.label}</h3>
        <StateBadge s={a.state} />
      </div>
      {a.state.reason && <p className="text-xs text-foreground-secondary">{a.state.reason}</p>}
      {a.account_usage && <AccountWide u={a.account_usage} a={a} />}
      {a.operator_snapshot ? <OperatorSnapshot s={a.operator_snapshot} />
        : a.operator_snapshot === null && snapshotable ? <div className="text-xs text-foreground-secondary">Operator snapshot: none reported</div> : null}
      {canReport && snapshotable && <SnapshotForm account={a.id} onSaved={onChanged} />}
      <table className="w-full text-xs">
        <caption className="text-left text-foreground-secondary mb-1">Djimitflo&apos;s share, as recorded — a CLI lease (e.g. opencode) counts once, although it makes many requests</caption>
        <thead><tr className="text-foreground-secondary"><th className="text-left">window</th><th className="text-right">calls</th><th className="text-right">tokens</th></tr></thead>
        <tbody>
          {WINDOWS.map((w) => {
            const s = a.windows[w.id]; const leases = a.lease_sessions?.[w.id] ?? 0;
            return (
              <tr key={w.id}>
                <td className="text-foreground-secondary">{w.label}</td>
                <td className="text-right text-foreground">{s.calls}{leases ? <span className="text-foreground-secondary"> ({leases} lease)</span> : null}</td>
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
  // after a snapshot is saved: re-read the accounts (the page keeps the old view if the re-read fails)
  const reload = useCallback(() => { api.getUsageAccounts().then(setData).catch(() => undefined); }, []);

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
        {data.accounts.map((a) => <AccountCard key={a.id} a={a} onChanged={reload} />)}
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
