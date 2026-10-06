import { api } from '../lib/api';
import { useResource } from '../hooks/useResource';
import { LoadErrorNotice } from '../components/LoadErrorNotice';
import { fmt, since } from '../lib/format';

/**
 * UX-17: scorecards on the Agents page (the top-level menu is capped at 20). Per runtime: real-maker outcomes (30 d)
 * with a 95 % interval, durations, tokens, cost only when priced, failure classes, gym breaker. Per fleet agent: outcomes
 * per task kind and the connection state. Every rate shows its n; nothing here acts.
 */
const fetchScorecards = () => api.getScorecards();
const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);
const secs = (ms: number | null) => (ms === null ? '—' : `${fmt(Math.round(ms / 1000))} s`);

export function ScorecardsSection() {
  const res = useResource(fetchScorecards, { pollMs: 60_000 });
  const runtimes = res.data?.runtimes ?? []; const agents = res.data?.agents ?? [];
  return (
    <section aria-labelledby="scorecards" className="space-y-4">
      <h2 id="scorecards" className="text-lg font-semibold">Scorecards (30 d)</h2>
      {res.error && <LoadErrorNotice failed={['scorecards']} />}
      {!res.loading && !res.error && runtimes.length === 0 && agents.length === 0 && <p className="text-sm text-foreground-secondary">No runtime or agent outcome in the last 30 days.</p>}
      {runtimes.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Runtime scorecards</caption>
            <thead><tr className="text-left text-foreground-tertiary">
              <th scope="col">Runtime</th><th scope="col">Success (n)</th><th scope="col">95 % interval</th><th scope="col">p50 / p95</th>
              <th scope="col">Tokens</th><th scope="col">Cost</th><th scope="col">Failure classes</th><th scope="col">Gym</th>
            </tr></thead>
            <tbody>{runtimes.map((r) => (
              <tr key={r.runtime} className="border-t border-border">
                <td>{r.runtime}</td>
                <td>{pct(r.outcomes.success_rate)} (n={r.outcomes.n})</td>
                <td>{r.outcomes.ci ? `${pct(r.outcomes.ci[0])}–${pct(r.outcomes.ci[1])}` : '—'}</td>
                <td>{secs(r.duration_ms.p50)} / {secs(r.duration_ms.p95)}</td>
                <td>{fmt(r.tokens)}</td>
                <td>{r.cost.usd === null ? `unknown (${r.cost.reason})` : `$${r.cost.usd.toFixed(2)}`}</td>
                <td>{Object.entries(r.failure_classes).map(([k, v]) => `${k} ${v}`).join(', ') || '—'}</td>
                <td>{r.benched ? 'benched (circuit breaker)' : '—'}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {agents.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Fleet agent scorecards</caption>
            <thead><tr className="text-left text-foreground-tertiary">
              <th scope="col">Agent</th><th scope="col">Success (n)</th><th scope="col">Per task kind</th><th scope="col">Last outcome</th><th scope="col">Connection</th>
            </tr></thead>
            <tbody>{agents.map((a) => (
              <tr key={a.agent} className="border-t border-border">
                <td>{a.agent}</td>
                <td>{pct(a.success_rate)} (n={a.n})</td>
                <td>{a.task_kinds.map((k) => `${k.task_kind} ${pct(k.success_rate)} (n=${k.n})`).join(', ')}</td>
                <td>{a.last_outcome_at ? since(a.last_outcome_at) : '—'}</td>
                <td>{a.connection_state ? `${a.connection_state} — ${a.connection_reason}` : 'no agent record'}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}
