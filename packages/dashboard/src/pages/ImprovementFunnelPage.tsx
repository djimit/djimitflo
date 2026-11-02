import { Gauge, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';
import { useResource } from '../hooks/useResource';

const fetchFunnel = async () => {
  const [funnel, calibration] = await Promise.all([api.getImprovementFunnel(), api.getPanelCalibration()]);
  return { funnel, calibration: calibration.specialists };
};

const pct = (n: number | null, d: number | null) => (n !== null && d !== null && d > 0 ? `${Math.round((n / d) * 100)}%` : '—');
/** UX-004: a failed or absent read is unknown, never 0 */
const known = (value: number | null | undefined) => (value === null || value === undefined ? 'unknown' : value);

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="p-4 rounded-lg border border-border bg-background-elevated">
      <div className="text-xs text-foreground-tertiary">{label}</div>
      <div className="text-2xl font-semibold">{value}</div>
      {hint && <div className="text-xs text-foreground-muted">{hint}</div>}
    </div>
  );
}

export function ImprovementFunnelPage() {
  const { data, error, loading, refresh: load } = useResource(fetchFunnel);
  const funnel = data?.funnel ?? null;
  const calibration = data?.calibration ?? [];

  const decided = Object.values(funnel?.panel.decisions ?? {}).reduce((a, b) => a + b, 0);
  const linkedGoal = funnel?.panel.linkedDecisions.goal ?? 0;
  const childGoals = funnel?.refinement.childGoals;
  const unavailable = funnel?.unavailable ?? {};
  /** hint text with the read failure appended, so an unknown value says why */
  const why = (metric: string, hint?: string) => [hint, unavailable[metric] && `unavailable — ${unavailable[metric]}`].filter(Boolean).join(' · ') || undefined;
  const queues = funnel?.queues;
  const listed = queues?.workItemsByLoop.reduce((a, w) => a + w.n, 0) ?? 0;
  const groups = queues?.workItemGroups ?? null;
  const notListed = queues?.openWorkItems == null ? null : queues.openWorkItems - listed;
  const medianWindow = funnel?.kpi.medianHoursWindowDays;

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Gauge className="w-7 h-7" />
        <h1 className="text-2xl font-bold">Improvement funnel</h1>
        <button onClick={() => void load()} disabled={loading} className="ml-auto flex items-center gap-2 px-3 py-2 rounded-md border border-border">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>
      <p className="text-sm text-foreground-secondary">
        Where proposals leak: generated, reviewed by the specialist panel, turned into goals, verified. Reasons and rates come straight from the database.
      </p>
      {error && <p role="alert" className="text-status-error">{error}</p>}

      {funnel && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Proposals" value={unavailable.proposals ? 'unknown' : funnel.proposals.total} hint={why('proposals', 'all time, every status')} />
            <Stat label="Panel goal rate" value={funnel.panel.goalRate === null ? '—' : pct(linkedGoal, funnel.panel.linkedDecided)} hint={`${linkedGoal} of ${funnel.panel.linkedDecided} proposal-linked panel decisions (${decided} panels in total)`} />
            <Stat label="Refinement reached goal" value={childGoals ? pct(childGoals.reachedGoal, funnel.refinement.children) : 'unknown'}
              hint={childGoals
                ? why('refinementChildren', `${childGoals.reachedGoal} of ${known(funnel.refinement.children)} refinements · ${childGoals.completed} completed · ${childGoals.failed} failed`)
                : why('refinementChildGoals', `${known(funnel.refinement.children)} refinements · goal outcomes unknown`)} />
            <Stat label="Cognitive episodes" value={known(funnel.learning.cognitiveEpisodes)} hint={why('cognitiveEpisodes', `${known(funnel.learning.cognitiveStrategies)} strategies`)} />
          </div>

          <section>
            {/* UX-003: each stat names its own window; the median does not share the 7-day window */}
            <h2 className="text-lg font-semibold mb-2">Yield</h2>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <Stat label="Verified" value={known(funnel.kpi.verified)} hint={why('verified', `current status verified/evaluating/applied, updated in last ${funnel.kpi.windowDays} d · ${known(funnel.kpi.regressed)} regressed${funnel.kpi.regressionRate === null ? '' : ` (${Math.round(funnel.kpi.regressionRate * 100)}% of verified + regressed)`}`)} />
              <Stat label="Panels created" value={known(funnel.kpi.panels24h)} hint={why('panels24h', `24 h · ${known(funnel.kpi.panels7d)} in 7 d${funnel.kpi.panelsPerVerified === null ? '' : ` · ${funnel.kpi.panelsPerVerified} per verified`}`)} />
              <Stat label="Specialist reviews" value={known(funnel.kpi.reviews24h)} hint={why('reviews24h', `submitted in 24 h · ${known(funnel.kpi.reviews7d)} in 7 d`)} />
              <Stat label="Median hours created → last update" value={funnel.kpi.medianHoursToVerified ?? '—'}
                hint={why('medianHoursToVerified', `currently verified/evaluating/applied · updated in last ${medianWindow ?? '?'} d · n=${known(funnel.kpi.medianHoursN)} · not first-verification latency (no verification timestamp is stored)`)} />
              <Stat label="Approvals per run" value={funnel.kpi.approvalsPerRun ?? '—'} hint={`approved rows / distinct linked loop runs, last ${funnel.kpi.windowDays} d`} />
            </div>
            <div className="grid grid-cols-3 gap-3 mt-3">
              <Stat label="Zombie goals" value={known(funnel.hygiene.zombieGoals)} hint={why('zombieGoals', 'running >24 h / blocked >7 d without a wait reason')} />
              <Stat label="Stale runs" value={known(funnel.hygiene.staleRuns)} hint={why('staleRuns', 'interrupted >48 h / planning >24 h')} />
              <Stat label="Blocked board items" value={known(funnel.hygiene.blockedBoardItems)} hint={why('blockedBoardItems', 'expire after 14 d')} />
            </div>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-2">By source</h2>
            <table className="w-full text-sm">
              <thead><tr className="text-left text-foreground-tertiary"><th>Source</th><th>Total</th><th>Parked</th><th>Needs grounding</th><th>Archived</th><th>Reached goal</th><th>Verified</th><th>Failed</th></tr></thead>
              <tbody>
                {funnel.bySource.map((s) => (
                  <tr key={s.source} className="border-t border-border">
                    <td>{s.source}</td><td>{s.total}</td><td>{s.parked}</td><td>{s.needsGrounding}</td><td>{s.archived}</td>
                    <td>{s.reachedGoal} ({pct(s.reachedGoal, s.total)})</td><td>{s.verified}</td><td>{s.failed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-2">Panel calibration (Brier, lower is better; 0.25 = coin flip)</h2>
            {calibration.length === 0 ? (
              <p className="text-sm text-foreground-secondary">No proposal with an outcome yet — calibration needs verified/failed goals.</p>
            ) : (
              <table className="w-full text-sm">
                <thead><tr className="text-left text-foreground-tertiary"><th>Specialist</th><th>n</th><th>Brier</th><th>Mean predicted</th><th>Observed success</th></tr></thead>
                <tbody>
                  {calibration.map((c) => (
                    <tr key={c.specialistId} className="border-t border-border">
                      <td>{c.specialistId}</td><td>{c.n}</td><td>{c.brier?.toFixed(3) ?? '—'}</td>
                      <td>{c.meanPredicted?.toFixed(2) ?? '—'}</td><td>{c.observedSuccessRate?.toFixed(2) ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="grid md:grid-cols-2 gap-6">
            <div>
              <h2 className="text-lg font-semibold mb-2">Goals from proposals</h2>
              <ul className="text-sm">{Object.entries(funnel.goals.fromSelfImprovement).map(([k, n]) => <li key={k}>{k}: {n}</li>)}</ul>
              <h2 className="text-lg font-semibold mt-4 mb-2">Commons reviews</h2>
              <ul className="text-sm">{Object.entries(funnel.queues.commonsReviews).map(([k, n]) => <li key={k}>{k}: {n}</li>)}</ul>
            </div>
            <div>
              {/* UX-002: the total is an independent COUNT, stated before the truncated breakdown */}
              <h2 className="text-lg font-semibold mb-2">Open work items ({known(funnel.queues.openWorkItems)})</h2>
              <p className="text-xs text-foreground-muted mb-1">
                {why('openWorkItems', 'candidate/triaged/planned/leased/blocked, all time')}
                {groups !== null && groups > funnel.queues.workItemsByLoop.length
                  ? ` · largest ${funnel.queues.workItemsByLoop.length} of ${groups} loop/status groups${notListed !== null && notListed > 0 ? ` · ${notListed} item${notListed === 1 ? '' : 's'} in groups not listed` : ''}`
                  : groups !== null ? ` · ${groups} loop/status group${groups === 1 ? '' : 's'}` : ''}
              </p>
              <ul className="text-sm">{funnel.queues.workItemsByLoop.map((w) => <li key={`${w.loop}-${w.status}`}>{w.loop} · {w.status}: {w.n}</li>)}</ul>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
