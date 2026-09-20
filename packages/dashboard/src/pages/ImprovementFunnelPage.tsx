import { useCallback, useEffect, useState } from 'react';
import { Gauge, RefreshCw } from 'lucide-react';
import { api, type ImprovementFunnel, type SpecialistCalibration } from '../lib/api';

const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : '—');

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
  const [funnel, setFunnel] = useState<ImprovementFunnel | null>(null);
  const [calibration, setCalibration] = useState<SpecialistCalibration[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [f, c] = await Promise.all([api.getImprovementFunnel(), api.getPanelCalibration()]);
      setFunnel(f);
      setCalibration(c.specialists);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load the improvement funnel');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const decisions = funnel?.panel.decisions ?? {};
  const decided = Object.values(decisions).reduce((a, b) => a + b, 0);

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
            <Stat label="Proposals" value={funnel.proposals.total} />
            <Stat label="Panel goal rate" value={funnel.panel.goalRate === null ? '—' : pct(decisions.goal ?? 0, decided)} hint={`${decisions.goal ?? 0} of ${decided} decisions`} />
            <Stat label="Refinement converted" value={pct(Object.entries(funnel.refinement.childOutcomes).filter(([s]) => ['scheduled', 'executing', 'verified', 'evaluating', 'applied'].includes(s)).reduce((a, [, n]) => a + n, 0), funnel.refinement.children)} hint={`${funnel.refinement.children} refinements`} />
            <Stat label="Cognitive episodes" value={funnel.learning.cognitiveEpisodes} hint={`${funnel.learning.cognitiveStrategies} strategies`} />
          </div>

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
              <h2 className="text-lg font-semibold mb-2">Open work items ({funnel.queues.openWorkItems})</h2>
              <ul className="text-sm">{funnel.queues.workItemsByLoop.map((w) => <li key={`${w.loop}-${w.status}`}>{w.loop} · {w.status}: {w.n}</li>)}</ul>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
