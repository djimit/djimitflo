import { useCallback, useEffect, useState } from 'react';
import { WebSocketEventType } from '@djimitflo/shared';
import { useWsSubscribe } from '../components/WebSocketProvider';
import { Link } from 'react-router-dom';
import { Activity, RefreshCw } from 'lucide-react';
import { api, type OperatorCockpit, type ServiceStatus } from '../lib/api';
import { fmt, since } from '../lib/format';
import { DataTable, Section, StatusPill } from '../components/ui';

const LABELS: Record<string, string> = {
  verified_7d: 'Verified (7 d)', regressed_7d: 'Regressed (7 d)', infra_failed_7d: 'Infra failed (7 d)', approvals_pending: 'Approvals pending',
  approvals_decided_7d: 'Approvals decided (7 d)', approvals_expired_7d: 'Approvals expired (7 d)', runs_failed_7d: 'Runs failed/interrupted (7 d)',
  panel_unparseable_7d: 'Panel unparseable (7 d)', reflection_inflow_24h: 'Reflection inflow (24 h)', needs_grounding_stock: 'Needs grounding',
  needs_more_evidence_stock: 'Needs more evidence', memory_reads_7d: 'Memory reads (7 d)', tokens_per_outcome_7d: 'Tokens per outcome (7 d)',
};

/** UX-13: the daily digest, read-only (Telegram delivery is OPERATOR_DIGEST_ENABLED on the server). */
export function DigestCard() {
  const [digest, setDigest] = useState<{ at: string; text: string } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { api.getOperatorDigest().then(setDigest).catch(() => setFailed(true)); }, []);
  if (failed) return <p className="text-sm text-foreground-secondary">Daily digest unavailable.</p>;
  if (!digest) return null;
  return (
    <section aria-labelledby="digest" className="rounded border border-border p-3">
      <h2 id="digest" className="text-lg font-semibold mb-2">Daily digest</h2>
      <pre className="text-sm whitespace-pre-wrap">{digest.text}</pre>
    </section>
  );
}

export function OperatorCockpitPage() {
  const [data, setData] = useState<OperatorCockpit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [services, setServices] = useState<ServiceStatus[] | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    api.getServiceMap().then((r) => setServices(r.services)).catch(() => setServices([]));
    try { setData(await api.getOperatorCockpit()); setLoadedAt(Date.now()); } catch (err) { setError(err instanceof Error ? err.message : 'Failed to load the cockpit'); } finally { setLoading(false); }
  }, []);
  // UX-3: live — poll every 30 s and refetch when an approval or proof run changes; say how fresh the numbers are
  const [, tick] = useState(0);
  const subscribe = useWsSubscribe();
  useEffect(() => {
    void load();
    const poll = setInterval(() => void load(), 30_000);
    const clock = setInterval(() => tick((n) => n + 1), 5_000);
    const offs = [WebSocketEventType.APPROVAL_REQUESTED, WebSocketEventType.APPROVAL_GRANTED, WebSocketEventType.APPROVAL_DENIED, WebSocketEventType.APPROVAL_EXPIRED, WebSocketEventType.PROOF_RUN_UPDATED]
      .map((t) => subscribe(t, () => void load()));
    return () => { clearInterval(poll); clearInterval(clock); offs.forEach((off) => off()); };
  }, [load, subscribe]);

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Activity className="w-7 h-7" />
        <h1 className="text-2xl font-bold">Operator cockpit</h1>
        <button onClick={() => void load()} disabled={loading} className="ml-auto flex items-center gap-2 px-3 py-2 rounded-md border border-border">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
        {loadedAt && <span className="text-xs text-foreground-secondary">updated {Math.round((Date.now() - loadedAt) / 1000)} s ago</span>}
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
          <DigestCard />
          {data.schedulers && <p className="text-sm text-foreground-secondary">Schedulers: {data.schedulers.armed} armed, {data.schedulers.off} off</p>}
          <Section id="guardrails" title="Guardrails">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {data.guardrails.map((g) => (
                <div key={g.name} className={`p-4 rounded-lg border ${g.ok ? 'border-border' : 'border-status-error/60 bg-status-error/5'}`}>
                  <div className="text-xs text-foreground-tertiary">{g.name}</div>
                  <div className="text-2xl font-semibold">{fmt(g.value)}</div>
                  <div className={`text-xs ${g.ok ? 'text-foreground-muted' : 'text-status-error'}`}>{g.ok ? 'ok' : 'breached'} · limit {g.limit}</div>
                </div>
              ))}
            </div>
          </Section>

          <Section id="services" title="Services">
            {services === null ? <p className="text-sm text-foreground-secondary">Probing…</p> : (
              <DataTable caption="Service endpoints and their status" rows={services} rowKey={(s) => s.endpoint}
                empty="No service endpoints configured or the probe failed." columns={[
                  { key: 'service', label: 'Service', render: (s) => s.names.join(' · ') },
                  { key: 'endpoint', label: 'Endpoint', render: (s) => s.endpoint, cellClassName: () => 'font-mono text-xs' },
                  { key: 'status', label: 'Status', render: (s) => `${s.status}${s.error ? ` (${s.error})` : ''}`,
                    cellClassName: (s) => (s.status === 'up' ? 'text-status-completed' : s.status === 'degraded' ? 'text-status-warning' : 'text-status-error') },
                  { key: 'http', label: 'HTTP', render: (s) => s.http ?? '—' },
                  { key: 'ms', label: 'Latency', render: (s) => (s.ms === null ? '—' : `${s.ms} ms`) },
                ]} />
            )}
          </Section>

          <Section id="deploys" title="Deploys">
            <DataTable caption="Recent deploy events" rows={data.deploys} rowKey={(d) => `${d.at}-${d.event}`}
              rowClassName={(d) => (d.event === 'failed' || d.event === 'paused' ? 'text-status-error' : undefined)}
              empty="No deploy events recorded yet (auto-deploy writes them to the data dir)." columns={[
                { key: 'at', label: 'When', render: (d) => since(d.at) },
                { key: 'event', label: 'Event', render: (d) => d.event.replace('_', ' ') },
                { key: 'sha', label: 'Commit', render: (d) => <code>{d.sha.slice(0, 8)}</code> },
                { key: 'detail', label: 'Detail', render: (d) => d.detail },
              ]} />
          </Section>

          <Section id="stalls" title="Silent stalls">
            {data.stalls.length === 0 ? <p className="text-sm text-foreground-secondary">None — every watched subsystem produced output recently.</p> : (
              <ul className="space-y-1 text-sm">
                {data.stalls.map((s) => <li key={s.subsystem} className="text-status-warning"><strong>{s.subsystem}</strong> — {s.detail} (since {since(s.since)})</li>)}
              </ul>
            )}
          </Section>

          <Section id="scorecard" title="Scorecard">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {Object.entries(data.scorecard).map(([k, v]) => (
                <div key={k} className="p-3 rounded-lg border border-border bg-background-elevated">
                  <div className="text-xs text-foreground-tertiary">{LABELS[k] ?? k}</div>
                  <div className="text-xl font-semibold">{fmt(v)}</div>
                </div>
              ))}
            </div>
          </Section>

          <div className="grid md:grid-cols-2 gap-6">
            <Section id="gym" title="Gym species">
              <DataTable caption="Gym outcomes per species" rows={data.gym} rowKey={(g) => g.species} empty="No gym outcomes yet." columns={[
                { key: 'species', label: 'Species', render: (g) => g.species },
                { key: 'state', label: 'State', render: (g) => (g.benched
                  ? <StatusPill tone="error" label="benched" title="Circuit breaker: 3+ infra discards; the species takes no gym work until the cool-down probe succeeds" />
                  : <StatusPill tone="ok" label="active" />) },
                { key: 'outcomes', label: 'Outcomes', render: (g) => g.outcomes },
                { key: 'success', label: 'Success', render: (g) => `${g.success_pct}%` },
                { key: 'secs', label: 'Avg s', render: (g) => fmt(g.avg_seconds) },
                { key: 'tokens', label: 'Avg tokens', render: (g) => fmt(g.avg_tokens) },
                { key: 'last', label: 'Last', render: (g) => since(g.last) },
              ]} />
            </Section>
            <Section id="remote-workers" title="Remote workers">
              <DataTable caption="Remote gym hosts" rows={data.remote_workers} rowKey={(w) => w.host} empty="No remote host has claimed work." columns={[
                { key: 'host', label: 'Host', render: (w) => w.host },
                { key: 'claims', label: 'Claims 24 h', render: (w) => w.claims_24h },
                { key: 'interrupted', label: 'Interrupted', render: (w) => w.interrupted_24h },
                { key: 'last', label: 'Last claim', render: (w) => since(w.last_claim) },
              ]} />
            </Section>
          </div>

          <Section id="genomes" title="Strategy genomes on real makers (30 d)">
            <DataTable caption="Real-maker outcomes per strategy genome" rows={data.genomes ?? []} rowKey={(g) => `${g.genome}:${g.skill_id}`}
              empty="No real-maker outcome carries a genome yet." columns={[
                { key: 'genome', label: 'Genome', render: (g) => g.genome },
                { key: 'skill', label: 'Maker skill', render: (g) => g.skill_id },
                { key: 'outcomes', label: 'Outcomes (n)', render: (g) => g.outcomes },
                { key: 'wins', label: 'Wins', render: (g) => g.wins },
                { key: 'rate', label: 'Win rate', render: (g) => `${g.win_pct}%` },
              ]} />
          </Section>

          <div className="grid md:grid-cols-2 gap-6">
            <Section id="usage" title="Agent runtimes (7 d)">
              <DataTable caption="Leases and tokens per role and runtime" rows={data.maker_usage_7d} rowKey={(u) => `${u.role}-${u.runtime}-${u.model}`}
                empty="No leases in the last 7 days." columns={[
                  { key: 'role', label: 'Role', render: (u) => u.role },
                  { key: 'runtime', label: 'Runtime / model', render: (u) => `${u.runtime}${u.model ? ` · ${u.model}` : ''}` },
                  { key: 'leases', label: 'Leases', render: (u) => u.leases },
                  { key: 'tokens', label: 'Tokens', render: (u) => fmt(u.tokens) },
                ]} />
            </Section>
            <Section id="judgments" title="Judgments (jev, 7 d)">
              <DataTable caption="jev judgment calls and errors" rows={data.judgments_7d} rowKey={(j) => j.judgment}
                empty="No judgment calls in the last 7 days." columns={[
                  { key: 'judgment', label: 'Judgment', render: (j) => j.judgment },
                  { key: 'calls', label: 'Calls', render: (j) => j.calls },
                  { key: 'errors', label: 'Errors', render: (j) => j.errors, cellClassName: (j) => (j.errors > j.calls * 0.3 ? 'text-status-error' : undefined) },
                  { key: 'tokens', label: 'Input tokens', render: (j) => fmt(j.input_tokens) },
                ]} />
            </Section>
          </div>
        </>
      )}
    </div>
  );
}

/** W3: what waits for the operator, each count linking to its /decisions section. */
export function NeedsYou({ n }: { n: NonNullable<OperatorCockpit['needs_you']> }) {
  const items = [
    { label: 'approvals', count: n.approvals, href: '/decisions#approvals' },
    { label: 'approvals expiring within 1 h', count: n.approvals_expiring ?? 0, href: '/decisions#approvals' },
    { label: 'requeue candidates', count: n.requeue, href: '/decisions#requeue' },
    { label: 'pre-screen labels', count: n.labels, href: '/decisions#prescreen' },
    { label: 'memory reviews', count: n.memory_review, href: '/decisions#memory' },
    { label: 'loop PRs unsettled', count: n.draft_prs ?? 0, href: '/decisions#draft-prs' },
    { label: 'proposals awaiting approval', count: n.proposals ?? 0, href: '/governance?tab=assurance' },
    { label: 'silent stalls', count: n.stalls ?? 0, href: '/#stalls' },
    { label: 'Commons join requests', count: n.join_requests ?? 0, href: '/agent-commons' },
    { label: 'fleet shell requests', count: n.shell_requests ?? 0, href: '/fleet' },
  ];
  // UX-6: 'approvals expiring' is a subset of 'approvals' and unsettled loop PRs include merged ones still settling — not double-counted
  const blocking = items.filter((item) => item.label !== 'approvals expiring within 1 h' && item.label !== 'loop PRs unsettled');
  const total = blocking.reduce((sum, item) => sum + item.count, 0);
  return (
    <section aria-labelledby="needs-you" className={`rounded-lg border p-4 ${total ? 'border-status-paused/40 bg-status-paused/10' : 'border-border'}`}>
      <h2 id="needs-you" className="text-lg font-semibold mb-2">{total ? `Needs you (${total})` : 'Nothing needs you right now'}</h2>
      {items.some((item) => item.count) && <ul className="flex flex-wrap gap-4 text-sm">{items.filter((item) => item.count).map((item) => (
        <li key={item.label}><Link to={item.href} className="underline">{item.count} {item.label}</Link></li>
      ))}</ul>}
    </section>
  );
}
