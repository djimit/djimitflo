import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { WebSocketEventType } from '@djimitflo/shared';
import { useWsSubscribe } from '../components/WebSocketProvider';
import { Link } from 'react-router-dom';
import { Activity, RefreshCw } from 'lucide-react';
import { api, type EfficiencyConsumer, type EfficiencyView, type OperatorCockpit, type ServiceStatus, type ValueInterval } from '../lib/api';
import { fmt, since } from '../lib/format';
import { DataTable, Section, StatusPill } from '../components/ui';

const LABELS: Record<string, string> = {
  verified_7d: 'Verified (7 d)', regressed_7d: 'Regressed (7 d)', infra_failed_7d: 'Infra failed (7 d)', approvals_pending: 'Approvals pending',
  approvals_decided_7d: 'Approvals decided (7 d)', approvals_expired_7d: 'Approvals expired (7 d)', runs_failed_7d: 'Runs failed/interrupted (7 d)',
  panel_unparseable_7d: 'Panel unparseable (7 d)', reflection_inflow_24h: 'Reflection inflow (24 h)', needs_grounding_stock: 'Needs grounding',
  needs_more_evidence_stock: 'Needs more evidence', memory_reads_7d: 'Memory reads (7 d)', tokens_per_verified_change_7d: 'Tokens per verified change (7 d, maker + reviewers)',
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

/**
 * Cockpit 3.0: explicit health states. A missing measurement is UNKNOWN, never healthy. The server may send `state`,
 * `health`, `errors` and `snapshot_id` (newer builds); an older server sends none, and the state is derived here from
 * `ok` + `value` (a null value is UNKNOWN even when the old server said ok).
 */
export type HealthState = 'HEALTHY' | 'DEGRADED' | 'BREACHED' | 'UNKNOWN' | 'STALE' | 'NOT_APPLICABLE';
type Gr = OperatorCockpit['guardrails'][number] & { state?: HealthState; split?: { maker: number; reviewer: number; environment: number; unknown?: number } };
type NeedsYouCounts = { [K in Exclude<keyof NonNullable<OperatorCockpit['needs_you']>, 'system_requeue'>]?: number | null }
  & { system_requeue?: NonNullable<OperatorCockpit['needs_you']>['system_requeue'] };
export type CockpitView = Omit<OperatorCockpit, 'guardrails' | 'needs_you'> & {
  guardrails: Gr[]; needs_you?: NeedsYouCounts;
  health?: HealthState; errors?: Array<{ section: string; message: string }>; snapshot_id?: string;
};
// worst first; NOT_APPLICABLE never raises the overall state
const RANK: HealthState[] = ['BREACHED', 'DEGRADED', 'UNKNOWN', 'STALE', 'HEALTHY', 'NOT_APPLICABLE'];
const worst = (states: HealthState[]): HealthState => states.reduce((w, s) => (RANK.indexOf(s) < RANK.indexOf(w) ? s : w), 'NOT_APPLICABLE' as HealthState);
const STALE_MS = 10 * 60_000;
export const guardrailState = (g: Gr): HealthState => g.state ?? (g.value === null ? 'UNKNOWN' : g.ok ? 'HEALTHY' : 'BREACHED');
const TONE: Record<HealthState, 'ok' | 'warn' | 'error' | 'paused' | 'neutral'> = { HEALTHY: 'ok', DEGRADED: 'warn', BREACHED: 'error', UNKNOWN: 'paused', STALE: 'paused', NOT_APPLICABLE: 'neutral' };
const lower = (s: HealthState) => s.toLowerCase().replace('_', ' ');

/** Overall health: the worst of the server's verdict, every guardrail, section errors, stalls and snapshot age. */
export function overallHealth(d: CockpitView, now = Date.now()): { state: HealthState; reasons: string[] } {
  const reasons: string[] = [];
  const states: HealthState[] = d.health ? [d.health] : [];
  if (d.health && d.health !== 'HEALTHY') reasons.push(`server reports ${lower(d.health)}`);
  if (!d.guardrails.length) { states.push('UNKNOWN'); reasons.push('no guardrails reported'); }
  for (const g of d.guardrails) { const s = guardrailState(g); states.push(s); if (s !== 'HEALTHY' && s !== 'NOT_APPLICABLE') reasons.push(`${g.name}: ${lower(s)}`); }
  if (d.errors?.length) { states.push('UNKNOWN'); reasons.push(`${d.errors.length} section(s) failed to load`); }
  if (d.stalls.length) { states.push('DEGRADED'); reasons.push(`${d.stalls.length} silent stall(s)`); }
  if (!(Date.parse(d.at) >= now - STALE_MS)) { states.push('STALE'); reasons.push(`snapshot from ${since(d.at, now)}`); }
  return { state: worst(states), reasons };
}

const num = (v: number | null | undefined) => (v === null || v === undefined ? 'unknown' : fmt(v));

/** Level 1: the four questions the operator must answer in seconds. */
export function CommandStrip({ d, now = Date.now() }: { d: CockpitView; now?: number }) {
  const health = overallHealth(d, now);
  const benched = d.gym.filter((g) => g.benched).map((g) => g.species);
  const stale = d.gym.filter((g) => g.stale && !g.benched).map((g) => g.species);
  const blocked = d.stalls.length + benched.length;
  const card = (id: string, title: string, body: ReactNode) => (
    <section aria-labelledby={id} className="p-4 rounded-lg border border-border">
      <h2 id={id} className="text-xs uppercase tracking-wide text-foreground-tertiary mb-1">{title}</h2>{body}
    </section>
  );
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3" data-testid="command-strip">
      {card('cmd-health', 'Is the system healthy?', <div role="status" aria-live="polite">
        <div className="text-xl font-semibold"><StatusPill tone={TONE[health.state]} label={lower(health.state)} /></div>
        {health.reasons.length > 0 && <ul className="text-xs text-foreground-secondary mt-1 list-disc pl-4">{health.reasons.slice(0, 5).map((r) => <li key={r}>{r}</li>)}</ul>}
      </div>)}
      {card('cmd-improvement', 'Is improvement occurring?', <>
        <div className="text-xl font-semibold">{num(d.scorecard.verified_7d)} verified · {num(d.scorecard.regressed_7d)} regressed</div>
        <p className="text-xs text-foreground-secondary">7 d throughput, not intelligence — see <Link to="/evolution" className="underline">Evolution</Link> for the validated-improvement scorecard.</p>
      </>)}
      {card('cmd-blocked', 'What is blocked?', <>
        <div className="text-xl font-semibold">{blocked ? `${blocked} blocked` : 'nothing blocked'}</div>
        <ul className="text-xs text-foreground-secondary">
          {d.stalls.slice(0, 3).map((s) => <li key={s.subsystem}><a href="#stalls" className="underline">{s.subsystem}</a></li>)}
          {benched.map((sp) => <li key={sp}>benched: {sp}</li>)}
          {stale.length > 0 && <li>stale species: {stale.join(', ')}</li>}
        </ul>
      </>)}
      {card('cmd-needs-you', 'What needs you?', d.needs_you ? <NeedsYouTotal n={d.needs_you} /> : <div className="text-xl font-semibold">unknown</div>)}
    </div>
  );
}

const mtok = (n: number) => (n ? (n / 1e6).toFixed(2) : '0');
const ratio = (v: number | null) => (v === null ? '—' : v.toFixed(2));
const interval = (v: ValueInterval | null) => (!v ? '—' : v.low === null ? `${v.value.toFixed(2)} (n ${v.n})` : `${v.value.toFixed(2)} [${v.low.toFixed(2)}–${v.high!.toFixed(2)}]`);
const energy = (c: EfficiencyConsumer) => (c.energy === 'not_measured' ? (c.jobs ? 'not measured' : '—')
  : c.energy === 'partial' ? `≥ ${fmt(c.wh)} Wh (${Math.round((c.energy_coverage ?? 0) * 100)} % sampled)` : `${fmt(c.wh)} Wh`);

/** Phase E1/E3: what each consumer spends (cloud tokens, local GPU time, measured GPU energy) and what it delivered. */
export function EfficiencySection() {
  const [view, setView] = useState<EfficiencyView | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { api.getEfficiency().then(setView).catch(() => setFailed(true)); }, []);
  if (failed) return <p className="text-sm text-foreground-secondary">Efficiency view unavailable.</p>;
  if (!view) return null;
  const week = view.north_star.weeks[0];
  return (
    <Section id="efficiency" title={`Efficiency (${view.window_days} d)`}>
      <div className="space-y-4">
        <p className="text-sm text-foreground-secondary">
          North star: verified changes per cloud M tokens and per local kWh — reported separately, never one unit.
          {!view.ledger_enabled && <> GPU power sampling is off (<code>RESOURCE_LEDGER_ENABLED</code>); energy reads &lsquo;not measured&rsquo;.</>}
        </p>
        {week && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="p-3 rounded-lg border border-border"><div className="text-xs text-foreground-tertiary">Verified (last 7 d)</div><div className="text-xl font-semibold">{week.verified}</div></div>
            <div className="p-3 rounded-lg border border-border"><div className="text-xs text-foreground-tertiary">Cloud M tokens</div><div className="text-xl font-semibold">{week.cloud_m_tokens.toFixed(1)}</div></div>
            <div className="p-3 rounded-lg border border-border"><div className="text-xs text-foreground-tertiary">Verified per M tokens</div><div className="text-xl font-semibold">{ratio(week.per_m_tokens)}</div></div>
            <div className="p-3 rounded-lg border border-border"><div className="text-xs text-foreground-tertiary">Verified per local kWh</div>
              <div className="text-xl font-semibold">{week.local_kwh === null ? 'not measured' : week.per_kwh === null && week.per_kwh_reason ? 'insufficient evidence' : ratio(week.per_kwh)}</div>
              {week.per_kwh_reason && <div className="text-xs text-foreground-tertiary">{week.per_kwh_reason.replace(/^INSUFFICIENT_EVIDENCE: /, '')}</div>}</div>
          </div>
        )}
        <DataTable caption="North star per week" rows={view.north_star.weeks} rowKey={(w) => w.week_start} columns={[
          { key: 'week', label: 'Week from', render: (w) => w.week_start },
          { key: 'verified', label: 'Verified', render: (w) => w.verified },
          { key: 'tokens', label: 'Cloud M tokens', render: (w) => w.cloud_m_tokens.toFixed(1) },
          { key: 'kwh', label: 'Local kWh', render: (w) => (w.local_kwh === null ? 'not measured' : `${w.local_kwh.toFixed(2)} (${w.local_covered_h} h sampled)`) },
          { key: 'per_tok', label: 'per M tokens', render: (w) => ratio(w.per_m_tokens) },
          { key: 'per_kwh', label: 'per kWh', render: (w) => (w.per_kwh === null && w.per_kwh_reason ? <span title={w.per_kwh_reason}>insufficient evidence</span> : ratio(w.per_kwh)) },
        ]} />
        <DataTable caption="Resources and value per consumer" rows={view.consumers} rowKey={(c) => c.consumer} empty="No tokens, GPU jobs or outcomes in the window." columns={[
          { key: 'consumer', label: 'Consumer', render: (c) => c.consumer, cellClassName: () => 'font-mono text-xs' },
          { key: 'cloud', label: 'Cloud M tok', render: (c) => mtok(c.cloud_tokens) },
          { key: 'local', label: 'Local M tok', render: (c) => mtok(c.local_tokens) },
          { key: 'gpu', label: 'GPU-h', render: (c) => (c.gpu_seconds ? (c.gpu_seconds / 3600).toFixed(1) : '—') },
          { key: 'wh', label: 'Energy', render: energy },
          { key: 'verified', label: 'Verified', render: (c) => (c.verified === null ? '—' : `${c.verified}/${c.attempts}${c.lanes && Object.keys(c.lanes).length ? ` (${Object.entries(c.lanes).map(([l, k]) => `${l} ${k}`).join(', ')})` : ''}`) },
          { key: 'per_tok', label: 'per M tokens [95 %]', render: (c) => interval(c.per_m_tokens) },
          { key: 'per_kwh', label: 'per kWh [95 %]', render: (c) => interval(c.per_kwh) },
        ]} />
        <DataTable caption="Measured GPU energy per host" rows={view.hosts} rowKey={(h) => h.host} empty="No host has reported GPU power yet." columns={[
          { key: 'host', label: 'Host', render: (h) => h.host },
          { key: 'avg', label: 'Avg W', render: (h) => fmt(h.avg_watts) },
          { key: 'kwh', label: 'GPU kWh', render: (h) => (h.gpu_kwh === null ? 'not measured' : h.gpu_kwh.toFixed(2)) },
          { key: 'covered', label: 'Sampled h', render: (h) => h.covered_h },
          { key: 'last', label: 'Last sample', render: (h) => since(h.last_sample) },
        ]} />
        <ul className="text-xs text-foreground-secondary list-disc pl-5">{view.notes.map((n) => <li key={n}>{n}</li>)}</ul>
      </div>
    </Section>
  );
}

export function OperatorCockpitPage() {
  const [data, setData] = useState<CockpitView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [services, setServices] = useState<ServiceStatus[] | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);

  // stale-response guard: a slow older response never overwrites a newer one
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    api.getServiceMap().then((r) => { if (mine === seq.current) setServices(r.services); }).catch(() => { if (mine === seq.current) setServices([]); });
    try {
      const snap = await api.getOperatorCockpit() as CockpitView;
      if (mine === seq.current) { setData(snap); setLoadedAt(Date.now()); }
    } catch (err) { if (mine === seq.current) setError(err instanceof Error ? err.message : 'Failed to load the cockpit'); } finally { if (mine === seq.current) setLoading(false); }
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
        <button onClick={() => void load()} aria-busy={loading} className="ml-auto flex items-center gap-2 px-3 py-2 rounded-md border border-border">
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
          <CommandStrip d={data} />
          {data.errors && data.errors.length > 0 && (
            <div role="alert" className="rounded border border-status-warning/60 bg-status-warning/10 p-3 text-sm">
              <strong>Partial data:</strong> these sections failed and are shown as unknown, not as healthy.
              <ul className="list-disc pl-5">{data.errors.map((e) => <li key={e.section}><code>{e.section}</code>: {e.message}</li>)}</ul>
            </div>
          )}
          {!(Date.parse(data.at) >= Date.now() - STALE_MS) && (
            <p className="text-sm text-status-warning">Stale data: this snapshot was taken {since(data.at)} ({data.at}).</p>
          )}
          {data.needs_you && <NeedsYou n={data.needs_you} />}
          <DigestCard />
          <EfficiencySection />
          {data.schedulers && <p className="text-sm text-foreground-secondary">Schedulers: {data.schedulers.armed} armed, {data.schedulers.off} off</p>}
          <Disclose id="guardrails" title="Guardrails" open>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
              {data.guardrails.map((g) => { const st = guardrailState(g); return (
                <div key={g.name} data-state={st} className={`p-4 rounded-lg border ${st === 'HEALTHY' ? 'border-border' : st === 'BREACHED' ? 'border-status-error/60 bg-status-error/5' : 'border-status-warning/60'}`}>
                  <div className="text-xs text-foreground-tertiary">{g.name}</div>
                  <div className="text-2xl font-semibold">{num(g.value)}</div>
                  <div className={`text-xs ${st === 'HEALTHY' ? 'text-foreground-muted' : st === 'BREACHED' ? 'text-status-error' : 'text-status-warning'}`}>{lower(st)} · limit {g.limit}</div>
                  {g.split && <div className="text-xs text-foreground-tertiary">maker {g.split.maker} · reviewer {g.split.reviewer} · environment {g.split.environment}{g.split.unknown ? ` · unattributed ${g.split.unknown}` : ''}</div>}
                </div>
              ); })}
            </div>
          </Disclose>

          <Disclose id="services" open title="Services">
            {services === null ? <p className="text-sm text-foreground-secondary">Probing…</p> : (
              <DataTable caption="Service endpoints and their status" rows={services} rowKey={(s) => s.endpoint}
                empty="No service endpoints configured or the probe failed." columns={[
                  { key: 'service', label: 'Service', render: (s) => s.names.join(' · ') },
                  { key: 'endpoint', label: 'Endpoint', render: (s) => s.endpoint, cellClassName: () => 'font-mono text-xs' },
                  // a 404 says something listens, not that it is healthy: 'reachable (404)', never 'up'
                  { key: 'status', label: 'Status', render: (s) => `${s.status === 'up' && s.http === 404 ? 'reachable' : s.status}${s.error ? ` (${s.error})` : s.http === 404 ? ' (404)' : ''}`,
                    cellClassName: (s) => (s.status === 'up' && s.http !== 404 ? 'text-status-completed' : s.status === 'down' ? 'text-status-error' : 'text-status-warning') },
                  { key: 'http', label: 'HTTP', render: (s) => s.http ?? '—' },
                  { key: 'ms', label: 'Latency', render: (s) => (s.ms === null ? '—' : `${s.ms} ms`) },
                ]} />
            )}
          </Disclose>

          <Disclose id="deploys" title="Deploys">
            <DataTable caption="Recent deploy events" rows={data.deploys} rowKey={(d) => `${d.at}-${d.event}`}
              rowClassName={(d) => (d.event === 'failed' || d.event === 'paused' ? 'text-status-error' : undefined)}
              empty="No deploy events recorded yet (auto-deploy writes them to the data dir)." columns={[
                { key: 'at', label: 'When', render: (d) => since(d.at) },
                { key: 'event', label: 'Event', render: (d) => d.event.replace('_', ' ') },
                { key: 'sha', label: 'Commit', render: (d) => <code>{d.sha.slice(0, 8)}</code> },
                { key: 'detail', label: 'Detail', render: (d) => d.detail },
              ]} />
          </Disclose>

          <Disclose id="stalls" open title="Silent stalls">
            {data.stalls.length === 0 ? <p className="text-sm text-foreground-secondary">None — every watched subsystem produced output recently.</p> : (
              <ul className="space-y-1 text-sm">
                {data.stalls.map((s) => <li key={s.subsystem} className="text-status-warning"><strong>{s.subsystem}</strong> — {s.detail} (since {since(s.since)})</li>)}
              </ul>
            )}
          </Disclose>

          <Disclose id="scorecard" title="Scorecard">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {Object.entries(data.scorecard).map(([k, v]) => (
                <div key={k} className="p-3 rounded-lg border border-border bg-background-elevated">
                  <div className="text-xs text-foreground-tertiary">{LABELS[k] ?? k}</div>
                  <div className="text-xl font-semibold">{fmt(v)}</div>
                </div>
              ))}
            </div>
          </Disclose>

          <div className="grid md:grid-cols-2 gap-6">
            <Disclose id="gym" open title="Gym species">
              <DataTable caption="Gym outcomes per species" rows={data.gym} rowKey={(g) => g.species} empty="No gym outcomes yet." columns={[
                { key: 'species', label: 'Species', render: (g) => g.species },
                { key: 'state', label: 'State', render: (g) => (g.benched
                  ? <StatusPill tone="error" label="benched" title="Circuit breaker: 3+ infra discards; the species takes no gym work until the cool-down probe succeeds" />
                  : g.stale ? <StatusPill tone="warn" label="stale" title="No gym outcome for 72 h or more" />
                    : <StatusPill tone="ok" label="active" />) },
                { key: 'outcomes', label: 'Outcomes', render: (g) => g.outcomes },
                { key: 'success', label: 'Success', render: (g) => `${g.success_pct}%` },
                { key: 'secs', label: 'Avg s', render: (g) => fmt(g.avg_seconds) },
                { key: 'tokens', label: 'Avg tokens', render: (g) => fmt(g.avg_tokens) },
                { key: 'last', label: 'Last', render: (g) => since(g.last) },
              ]} />
            </Disclose>
            <Disclose id="remote-workers" open title="Remote workers">
              <DataTable caption="Remote gym hosts" rows={data.remote_workers} rowKey={(w) => w.host} empty="No remote host has claimed work." columns={[
                { key: 'host', label: 'Host', render: (w) => w.host },
                { key: 'claims', label: 'Claims 24 h', render: (w) => w.claims_24h },
                { key: 'interrupted', label: 'Interrupted', render: (w) => w.interrupted_24h },
                { key: 'last', label: 'Last claim', render: (w) => since(w.last_claim) },
              ]} />
            </Disclose>
          </div>

          <Disclose id="genomes" title="Strategy genomes (30 d)">
            {/* gym makers (loop-maker:gym:*) and makers on real goals were one 'real makers' table; never mixed again */}
            {(['production', 'gym'] as const).map((scope) => (
              <div key={scope} className="space-y-2">
                <h3 className="text-sm font-semibold">{scope === 'production' ? 'Production makers' : 'Gym makers'}</h3>
                <DataTable caption={scope === 'production' ? 'Production-maker outcomes per strategy genome' : 'Gym-maker outcomes per strategy genome'}
                  rows={(data.genomes ?? []).filter((g) => (g.scope ?? (g.skill_id.startsWith('loop-maker:gym:') ? 'gym' : 'production')) === scope)}
                  rowKey={(g) => `${g.genome}:${g.skill_id}`}
                  empty={scope === 'production' ? 'No production-maker outcome carries a genome yet.' : 'No gym-maker outcome carries a genome yet.'} columns={[
                    { key: 'genome', label: 'Genome', render: (g) => g.genome },
                    { key: 'skill', label: 'Maker skill', render: (g) => g.skill_id },
                    { key: 'outcomes', label: 'Outcomes (n)', render: (g) => g.outcomes },
                    { key: 'wins', label: 'Wins', render: (g) => g.wins },
                    { key: 'rate', label: 'Win rate', render: (g) => `${g.win_pct}%` },
                  ]} />
              </div>
            ))}
          </Disclose>

          <div className="grid md:grid-cols-2 gap-6">
            <Disclose id="usage" title="Agent runtimes (7 d)">
              <DataTable caption="Leases and tokens per role and runtime" rows={data.maker_usage_7d} rowKey={(u) => `${u.role}-${u.runtime}-${u.model}`}
                empty="No leases in the last 7 days." columns={[
                  { key: 'role', label: 'Role', render: (u) => u.role },
                  { key: 'runtime', label: 'Runtime / model', render: (u) => `${u.runtime}${u.model ? ` · ${u.model}` : ''}` },
                  { key: 'leases', label: 'Leases', render: (u) => u.leases },
                  { key: 'tokens', label: 'Tokens', render: (u) => fmt(u.tokens) },
                ]} />
            </Disclose>
            <Disclose id="judgments" title="Judgments (jev, 7 d)">
              <DataTable caption="jev judgment calls and errors" rows={data.judgments_7d} rowKey={(j) => j.judgment}
                empty="No judgment calls in the last 7 days." columns={[
                  { key: 'judgment', label: 'Judgment', render: (j) => j.judgment },
                  { key: 'calls', label: 'Calls', render: (j) => j.calls },
                  { key: 'errors', label: 'Errors', render: (j) => j.errors, cellClassName: (j) => (j.errors > j.calls * 0.3 ? 'text-status-error' : undefined) },
                  { key: 'tokens', label: 'Input tokens', render: (j) => fmt(j.input_tokens) },
                ]} />
            </Disclose>
          </div>
        </>
      )}
    </div>
  );
}

/** W3: what waits for the operator, each count linking to its /decisions section. */
/** Level 1 total; null counts (a failed query) make the total a lower bound, never a calm zero. */
export function NeedsYouTotal({ n }: { n: NeedsYouCounts }) {
  const { total, unknown } = needsYouItems(n);
  return <div className="text-xl font-semibold">{unknown.length ? `≥ ${total} (${unknown.length} unknown)` : total ? `${total} waiting` : 'nothing'} {total || unknown.length ? <Link to="/decisions" className="text-sm underline">open Decisions</Link> : null}</div>;
}

function needsYouItems(n: NeedsYouCounts) {
  // absent (older server) = 0; null (the server could not count it) = unknown
  const c = (v: number | null | undefined) => (v === undefined ? 0 : v);
  const items: Array<{ label: string; count: number | null; href: string }> = [
    { label: 'approvals', count: c(n.approvals), href: '/decisions#approvals' },
    { label: 'approvals expiring within 1 h', count: c(n.approvals_expiring), href: '/decisions#approvals' },
    { label: 'requeue candidates', count: c(n.requeue), href: '/decisions#requeue' },
    { label: 'pre-screen labels', count: c(n.labels), href: '/decisions#prescreen' },
    { label: 'memory reviews', count: c(n.memory_review), href: '/decisions#memory' },
    { label: 'open loop PRs', count: c(n.open_prs), href: '/decisions#draft-prs' },
    { label: 'loop PRs unsettled', count: c(n.draft_prs), href: '/decisions#draft-prs' },
    { label: 'proposals awaiting approval', count: c(n.proposals), href: '/governance?tab=assurance' },
    { label: 'silent stalls', count: c(n.stalls), href: '/#stalls' },
    { label: 'Commons join requests', count: c(n.join_requests), href: '/agent-commons' },
    { label: 'fleet shell requests', count: c(n.shell_requests), href: '/fleet' },
  ];
  // UX-6: 'approvals expiring' is a subset of 'approvals' and unsettled loop PRs include merged ones still settling — not double-counted;
  // open loop PRs wait for a human merge or close, so they count
  const blocking = items.filter((item) => item.label !== 'approvals expiring within 1 h' && item.label !== 'loop PRs unsettled');
  // the server's total counts a proposal waiting in two sections once; older servers send no total
  const total = n.total ?? blocking.reduce((sum, item) => sum + (item.count ?? 0), 0);
  const unknown = blocking.filter((item) => item.count === null);
  return { items, total, unknown };
}

export function NeedsYou({ n }: { n: NeedsYouCounts }) {
  const { items, total, unknown } = needsYouItems(n);
  const sys = n.system_requeue;
  return (
    <section aria-labelledby="needs-you" className={`rounded-lg border p-4 ${total || unknown.length ? 'border-status-paused/40 bg-status-paused/10' : 'border-border'}`}>
      <h2 id="needs-you" className="text-lg font-semibold mb-2">{total ? `Needs you (${unknown.length ? '≥ ' : ''}${total})` : unknown.length ? 'Needs you: unknown' : 'Nothing needs you right now'}</h2>
      {unknown.length > 0 && <p className="text-sm text-status-warning mb-1">Could not count: {unknown.map((u) => u.label).join(', ')} — shown as unknown, not 0.</p>}
      {items.some((item) => item.count) && <ul className="flex flex-wrap gap-4 text-sm">{items.filter((item) => item.count).map((item) => (
        <li key={item.label}><Link to={item.href} className="underline">{item.count} {item.label}</Link></li>
      ))}</ul>}
      {sys && (sys.budgeted_requeue || sys.attribution_unknown || sys.not_actionable) ? (
        <p className="text-xs text-foreground-tertiary mt-2">
          System-side requeue candidates (not counted): {sys.budgeted_requeue ?? 0} budgeted requeue · {sys.attribution_unknown ?? 0} attribution unknown · {sys.not_actionable ?? 0} not actionable
        </p>
      ) : null}
    </section>
  );
}

/** Level 2–4 progressive disclosure: native <details> (keyboard and screen-reader accessible out of the box). */
function Disclose({ id, title, open, children }: { id: string; title: ReactNode; open?: boolean; children: ReactNode }) {
  return (
    <details open={open} className="group">
      <summary className="cursor-pointer list-none focus:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded">
        <h2 id={id} className="inline text-lg font-semibold">{title}</h2>
      </summary>
      <section aria-labelledby={id} className="mt-2">{children}</section>
    </details>
  );
}
