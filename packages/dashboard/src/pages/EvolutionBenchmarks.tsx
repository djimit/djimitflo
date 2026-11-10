import type { BenchmarkEvidence, BenchmarkSeries } from '../lib/api';

/**
 * Periodic fixed benchmarks (services/benchmark-schedule.ts): one block per benchmark — its state (due, overdue, regression)
 * and its runs, oldest first, each with its value and CI. A value the server did not compute reads "—", never 0.
 */
const num = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v.toFixed(3));
const ci = (lo: number | null, hi: number | null) => (lo === null || hi === null ? '—' : `[${lo.toFixed(3)}, ${hi.toFixed(3)}]`);
const METRIC: Record<BenchmarkSeries['metric'], string> = { auc: 'AUC', pass_rate: 'pass rate' };

function state(b: BenchmarkSeries): { text: string; bad: boolean } {
  if (b.regression.regressed) return { text: `regression: −${num(b.regression.drop)} > ${num(b.regression.threshold)} (${b.regression.basis === 'ci' ? 'previous CI' : 'margin'})`, bad: true };
  if (b.overdue) return { text: `overdue since ${b.owed_at?.slice(0, 10) ?? 'unknown'}`, bad: true };
  if (b.due) return { text: b.execution === 'operator_runner' ? `due — bash scripts/benchmark-run.sh ${b.id} --apply` : 'due — the scheduler records it within the hour', bad: false };
  if (b.due === null) return { text: 'state unknown', bad: false };
  return { text: 'up to date', bad: false };
}

export function BenchmarksCard({ data }: { data: BenchmarkEvidence }) {
  return (
    <div className="space-y-4 text-sm" data-testid="benchmarks-card">
      <p className="text-foreground-secondary">
        Mode {data.mode}{data.mode === 'off' ? ' — nothing runs, no alarms' : ''} · token cap {data.token_cap.toLocaleString('en-US')} per reviewer run · regression margin {data.margin}
      </p>
      {data.benchmarks.map((b) => {
        const s = state(b);
        return (
          <div key={b.id} className="space-y-1">
            <p className="font-medium">
              {b.title} <span className="text-foreground-tertiary">({b.id}, {METRIC[b.metric]}, {b.cadence})</span> · <span className={s.bad ? 'text-status-error' : 'text-foreground-secondary'}>{s.text}</span>
            </p>
            {!b.series.length ? <p className="text-foreground-secondary">No run recorded yet.</p> : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-foreground-tertiary">{['Run', METRIC[b.metric], '95 % CI', 'n', 'Caught / false rejects', 'Tokens', 'Model', 'Status'].map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
                  <tbody>
                    {b.series.map((r) => (
                      <tr key={`${b.id}-${r.started_at}-${r.status}`} className="border-t border-border">
                        <td>{r.started_at.slice(0, 10)}</td>
                        <td>{num(r.value)}</td>
                        <td>{ci(r.ci_low, r.ci_high)}</td>
                        <td>n = {r.n}</td>
                        <td>{r.catches === null ? '—' : `${r.catches} / ${r.false_rejects ?? '—'}`}</td>
                        <td>{r.tokens === null ? '—' : r.tokens.toLocaleString('en-US')}</td>
                        <td>{r.models.join(', ') || '—'}</td>
                        <td className={r.status === 'ok' ? undefined : 'text-foreground-secondary'}>{`${r.status}${r.reason ? ` — ${r.reason}` : ''}`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
