import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, RefreshCw } from 'lucide-react';
import { api, type OperatorCockpit, type ServiceStatus } from '../lib/api';

const LABELS: Record<string, string> = {
  verified_7d: 'Verified (7 d)', regressed_7d: 'Regressed (7 d)', infra_failed_7d: 'Infra failed (7 d)', approvals_pending: 'Approvals pending',
  approvals_decided_7d: 'Approvals decided (7 d)', approvals_expired_7d: 'Approvals expired (7 d)', runs_failed_7d: 'Runs failed/interrupted (7 d)',
  panel_unparseable_7d: 'Panel unparseable (7 d)', reflection_inflow_24h: 'Reflection inflow (24 h)', needs_grounding_stock: 'Needs grounding',
  needs_more_evidence_stock: 'Needs more evidence', memory_reads_7d: 'Memory reads (7 d)', tokens_per_outcome_7d: 'Tokens per outcome (7 d)',
};
const fmt = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n.toLocaleString('en-US'));
const since = (iso: string | null) => {
  if (!iso) return 'never';
  const h = Math.round((Date.now() - Date.parse(iso)) / 3_600_000);
  return h < 1 ? '< 1 h ago' : h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
};

export function OperatorCockpitPage() {
  const [data, setData] = useState<OperatorCockpit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [services, setServices] = useState<ServiceStatus[] | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    api.getServiceMap().then((r) => setServices(r.services)).catch(() => setServices([]));
    try { setData(await api.getOperatorCockpit()); } catch (err) { setError(err instanceof Error ? err.message : 'Failed to load the cockpit'); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Activity className="w-7 h-7" />
        <h1 className="text-2xl font-bold">Operator cockpit</h1>
        <button onClick={() => void load()} disabled={loading} className="ml-auto flex items-center gap-2 px-3 py-2 rounded-md border border-border">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>
      <p className="text-sm text-foreground-secondary">
        Is the self-improvement loop healthy? Guardrails, silent stalls, gym species and model usage, straight from the database.
        {data?.build.commit && <> Build <code>{data.build.commit.slice(0, 8)}</code>{data.build.build_time && <> · {data.build.build_time}</>}.</>}
      </p>
      {error && <p role="alert" className="text-status-error">{error}</p>}
      {!data && !error && loading && <p className="text-sm text-foreground-secondary">Loading…</p>}

      {data && (
        <>
          {data.needs_you && <NeedsYou n={data.needs_you} />}
          <section aria-labelledby="guardrails">
            <h2 id="guardrails" className="text-lg font-semibold mb-2">Guardrails</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {data.guardrails.map((g) => (
                <div key={g.name} className={`p-4 rounded-lg border ${g.ok ? 'border-border' : 'border-status-error/60 bg-status-error/5'}`}>
                  <div className="text-xs text-foreground-tertiary">{g.name}</div>
                  <div className="text-2xl font-semibold">{fmt(g.value)}</div>
                  <div className={`text-xs ${g.ok ? 'text-foreground-muted' : 'text-status-error'}`}>{g.ok ? 'ok' : 'breached'} · limit {g.limit}</div>
                </div>
              ))}
            </div>
          </section>

          <section aria-labelledby="services">
            <h2 id="services" className="text-lg font-semibold mb-2">Services</h2>
            {services === null ? <p className="text-sm text-foreground-secondary">Probing…</p> : services.length === 0 ? <p className="text-sm text-foreground-secondary">No service endpoints configured or the probe failed.</p> : (
              <table className="w-full text-sm">
                <thead><tr className="text-left text-foreground-tertiary"><th>Service</th><th>Endpoint</th><th>Status</th><th>HTTP</th><th>Latency</th></tr></thead>
                <tbody>{services.map((s) => (
                  <tr key={s.endpoint} className="border-t border-border">
                    <td>{s.names.join(' · ')}</td><td className="font-mono text-xs">{s.endpoint}</td>
                    <td className={s.status === 'up' ? 'text-status-completed' : s.status === 'degraded' ? 'text-status-warning' : 'text-status-error'}>{s.status}{s.error ? ` (${s.error})` : ''}</td>
                    <td>{s.http ?? '—'}</td><td>{s.ms === null ? '—' : `${s.ms} ms`}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </section>

          <section aria-labelledby="deploys">
            <h2 id="deploys" className="text-lg font-semibold mb-2">Deploys</h2>
            {data.deploys.length === 0 ? <p className="text-sm text-foreground-secondary">No deploy events recorded yet (auto-deploy writes them to the data dir).</p> : (
              <table className="w-full text-sm">
                <thead><tr className="text-left text-foreground-tertiary"><th>When</th><th>Event</th><th>Commit</th><th>Detail</th></tr></thead>
                <tbody>{data.deploys.map((d) => (
                  <tr key={`${d.at}-${d.event}`} className={`border-t border-border ${d.event === 'failed' || d.event === 'paused' ? 'text-status-error' : ''}`}>
                    <td>{since(d.at)}</td><td>{d.event.replace('_', ' ')}</td><td><code>{d.sha.slice(0, 8)}</code></td><td>{d.detail}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </section>

          <section aria-labelledby="stalls">
            <h2 id="stalls" className="text-lg font-semibold mb-2">Silent stalls</h2>
            {data.stalls.length === 0 ? <p className="text-sm text-foreground-secondary">None — every watched subsystem produced output recently.</p> : (
              <ul className="space-y-1 text-sm">
                {data.stalls.map((s) => <li key={s.subsystem} className="text-status-warning"><strong>{s.subsystem}</strong> — {s.detail} (since {since(s.since)})</li>)}
              </ul>
            )}
          </section>

          <section aria-labelledby="scorecard">
            <h2 id="scorecard" className="text-lg font-semibold mb-2">Scorecard</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {Object.entries(data.scorecard).map(([k, v]) => (
                <div key={k} className="p-3 rounded-lg border border-border bg-background-elevated">
                  <div className="text-xs text-foreground-tertiary">{LABELS[k] ?? k}</div>
                  <div className="text-xl font-semibold">{fmt(v)}</div>
                </div>
              ))}
            </div>
          </section>

          <section aria-labelledby="gym" className="grid md:grid-cols-2 gap-6">
            <div>
              <h2 id="gym" className="text-lg font-semibold mb-2">Gym species</h2>
              {data.gym.length === 0 ? <p className="text-sm text-foreground-secondary">No gym outcomes yet.</p> : (
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-foreground-tertiary"><th>Species</th><th>State</th><th>Outcomes</th><th>Success</th><th>Avg s</th><th>Avg tokens</th><th>Last</th></tr></thead>
                  <tbody>{data.gym.map((g) => (
                    <tr key={g.species} className="border-t border-border"><td>{g.species}</td><td>{g.benched ? <span className="text-status-error" title="Circuit breaker: 3+ infra discards; the species takes no gym work until the cool-down probe succeeds">benched</span> : <span className="text-status-completed">active</span>}</td><td>{g.outcomes}</td><td>{g.success_pct}%</td><td>{fmt(g.avg_seconds)}</td><td>{fmt(g.avg_tokens)}</td><td>{since(g.last)}</td></tr>
                  ))}</tbody>
                </table>
              )}
            </div>
            <div>
              <h2 className="text-lg font-semibold mb-2">Remote workers</h2>
              {data.remote_workers.length === 0 ? <p className="text-sm text-foreground-secondary">No remote host has claimed work.</p> : (
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-foreground-tertiary"><th>Host</th><th>Claims 24 h</th><th>Interrupted</th><th>Last claim</th></tr></thead>
                  <tbody>{data.remote_workers.map((w) => (
                    <tr key={w.host} className="border-t border-border"><td>{w.host}</td><td>{w.claims_24h}</td><td>{w.interrupted_24h}</td><td>{since(w.last_claim)}</td></tr>
                  ))}</tbody>
                </table>
              )}
            </div>
          </section>

          <section aria-labelledby="usage" className="grid md:grid-cols-2 gap-6">
            <div>
              <h2 id="usage" className="text-lg font-semibold mb-2">Agent runtimes (7 d)</h2>
              <table className="w-full text-sm">
                <thead><tr className="text-left text-foreground-tertiary"><th>Role</th><th>Runtime / model</th><th>Leases</th><th>Tokens</th></tr></thead>
                <tbody>{data.maker_usage_7d.map((u) => (
                  <tr key={`${u.role}-${u.runtime}-${u.model}`} className="border-t border-border"><td>{u.role}</td><td>{u.runtime}{u.model ? ` · ${u.model}` : ''}</td><td>{u.leases}</td><td>{fmt(u.tokens)}</td></tr>
                ))}</tbody>
              </table>
            </div>
            <div>
              <h2 className="text-lg font-semibold mb-2">Judgments (jev, 7 d)</h2>
              <table className="w-full text-sm">
                <thead><tr className="text-left text-foreground-tertiary"><th>Judgment</th><th>Calls</th><th>Errors</th><th>Input tokens</th></tr></thead>
                <tbody>{data.judgments_7d.map((j) => (
                  <tr key={j.judgment} className="border-t border-border"><td>{j.judgment}</td><td>{j.calls}</td><td className={j.errors > j.calls * 0.3 ? 'text-status-error' : ''}>{j.errors}</td><td>{fmt(j.input_tokens)}</td></tr>
                ))}</tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

/** W3: what waits for the operator, each count linking to its /decisions section. */
export function NeedsYou({ n }: { n: NonNullable<OperatorCockpit['needs_you']> }) {
  const items = [
    { label: 'approvals', count: n.approvals, href: '/decisions#approvals' },
    { label: 'requeue candidates', count: n.requeue, href: '/decisions' },
    { label: 'pre-screen labels', count: n.labels, href: '/decisions' },
    { label: 'memory reviews', count: n.memory_review, href: '/decisions' },
  ];
  const total = items.reduce((sum, item) => sum + item.count, 0);
  return (
    <section aria-labelledby="needs-you" className={`rounded-lg border p-4 ${total ? 'border-status-paused/40 bg-status-paused/10' : 'border-border'}`}>
      <h2 id="needs-you" className="text-lg font-semibold mb-2">{total ? `Needs you (${total})` : 'Nothing needs you right now'}</h2>
      {total > 0 && <ul className="flex flex-wrap gap-4 text-sm">{items.filter((item) => item.count).map((item) => (
        <li key={item.label}><Link to={item.href} className="underline">{item.count} {item.label}</Link></li>
      ))}</ul>}
    </section>
  );
}
