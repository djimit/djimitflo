import { useEffect, useState } from 'react';
import { api } from '../lib/api';

type Meta = Awaited<ReturnType<typeof api.getMetaStats>>;
type TuningEntry = { goalType: string; tuningType: string; recommendedValue?: unknown; applied: boolean; confidence: number; createdAt: string };

/**
 * Nav cut (UX-30): the applied meta-tuning log of the former /self-driving page (which redirects to #runtime-tuned).
 * The rest of that page is gone: its cognitive stats duplicated /evolution and its proactive-memory panel read a dead store.
 */
export function RuntimeTunedSection() {
  const [meta, setMeta] = useState<Meta | null | undefined>(undefined); // undefined = loading, null = unavailable
  const [history, setHistory] = useState<TuningEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tuning, setTuning] = useState(false);
  const [tuningResult, setTuningResult] = useState('');
  const [tuningError, setTuningError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api.getMetaStats().then((stats) => {
      if (!active) return;
      setMeta(stats);
      // tuning history only exists when meta orchestration runs; otherwise the disabled state says why it is empty
      if (stats.enabled) {
        api.getMetaTuningHistory({ limit: 20 })
          .then((result) => { if (active) setHistory(Array.isArray(result) ? result : []); })
          .catch((err) => { if (active) setError(`tuning history: ${err instanceof Error ? err.message : String(err)}`); });
      }
    }).catch((err) => { if (active) { setMeta(null); setError(`meta stats: ${err instanceof Error ? err.message : String(err)}`); } });
    return () => { active = false; };
  }, []);

  const runTuning = async () => {
    setTuning(true);
    setTuningError(null);
    try {
      const result = await api.post<{ enabled: false } | { evaluated: number; applied: number }>('/meta/tuning/run');
      if ('enabled' in result) throw new Error('Meta orchestration is disabled on this instance.');
      setTuningResult(`${result.applied}/${result.evaluated} recommendations applied`);
    } catch (err) {
      setTuningError(err instanceof Error ? err.message : 'Tuning failed');
    } finally {
      setTuning(false);
    }
  };

  return (
    <section id="runtime-tuned" aria-labelledby="runtime-tuned-heading" className="space-y-2 pt-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="runtime-tuned-heading" className="text-lg font-semibold">Runtime-tuned parameters</h2>
          <p className="text-xs text-foreground-tertiary">Loop parameters meta orchestration recommended or applied at runtime (not in runtime.env); newest 20.</p>
        </div>
        <button type="button" disabled={!meta?.enabled || tuning} onClick={() => void runTuning()}
          className="rounded border border-border px-3 py-1 text-sm disabled:opacity-50">{tuning ? 'Tuning...' : 'Run bounded tuning'}</button>
      </div>
      {tuningResult && <p className="text-xs text-foreground-secondary">{tuningResult}</p>}
      {tuningError && <p role="alert" className="text-sm text-status-error">{tuningError}</p>}
      {error && <p role="alert" className="text-sm text-status-error">Could not load {error}</p>}
      {meta === undefined && <p className="text-sm text-foreground-secondary">Loading…</p>}
      {meta?.enabled === false && <p className="text-sm text-foreground-secondary">Meta orchestration is disabled on this instance (runtime profile): nothing is tuned at runtime.</p>}
      {meta?.enabled && !error && (history === null ? <p className="text-sm text-foreground-secondary">Loading tuning history…</p> : history.length === 0 ? (
        <p className="text-sm text-foreground-secondary">No tuning adjustments yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-foreground-tertiary">
              <th className="py-1 pr-4 font-normal">Goal type</th><th className="py-1 pr-4 font-normal">Parameter</th><th className="py-1 pr-4 font-normal">Value</th>
              <th className="py-1 pr-4 font-normal">Confidence</th><th className="py-1 pr-4 font-normal">State</th><th className="py-1 font-normal">Date</th>
            </tr></thead>
            <tbody>{history.map((entry, index) => (
              <tr key={index} className="border-t border-border">
                <td className="py-1 pr-4 font-mono">{entry.goalType}</td>
                <td className="py-1 pr-4">{entry.tuningType}</td>
                <td className="py-1 pr-4 font-mono break-words">{entry.recommendedValue === undefined ? '—' : JSON.stringify(entry.recommendedValue)}</td>
                <td className="py-1 pr-4">{Math.round(entry.confidence * 100)}%</td>
                <td className="py-1 pr-4">{entry.applied ? 'applied' : 'recommended'}</td>
                <td className="py-1 whitespace-nowrap">{entry.createdAt.slice(0, 10)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ))}
    </section>
  );
}
