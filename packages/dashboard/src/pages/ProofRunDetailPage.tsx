import { useCallback, useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Database, RotateCcw, AlertTriangle } from 'lucide-react';
import { WebSocketEventType, type WebSocketMessage, type ProofRunEventPayload } from '@djimitflo/shared';
import { useWebSocket } from '../hooks/useWebSocket';
import { api, type ProofRunSummary } from '../lib/api';

export function ProofRunDetailPage() {
  const { proofRunId } = useParams<{ proofRunId: string }>();
  const { subscribe } = useWebSocket(true);
  const [proofRun, setProofRun] = useState<ProofRunSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [rollingBack, setRollingBack] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshProofRun = useCallback(async (id: string, initial = false) => {
    if (initial) setLoading(true);
    try {
      const updated = await api.getProofRun(id);
      setProofRun(updated);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load proof run');
    } finally {
      if (initial) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!proofRunId) return;
    void refreshProofRun(proofRunId, true);
  }, [proofRunId, refreshProofRun]);

  // Live-update: when a proof_run.updated event arrives for this run (e.g. a
  // rollback or re-run triggered from another tab / Mission Control), refetch.
  useEffect(() => {
    if (!proofRunId) return;
    const unsubscribe = subscribe(WebSocketEventType.PROOF_RUN_UPDATED, (message: WebSocketMessage) => {
      const payload = message.payload as ProofRunEventPayload | undefined;
      if (payload?.id === proofRunId) {
        void refreshProofRun(proofRunId);
      }
    });
    return unsubscribe;
  }, [proofRunId, subscribe, refreshProofRun]);

  async function rollback() {
    if (!proofRunId) return;
    setRollingBack(true);
    setError(null);
    try {
      const updated = await api.rollbackProofRun(proofRunId);
      setProofRun(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rollback failed');
    } finally {
      setRollingBack(false);
    }
  }

  if (loading) {
    return <div className="p-8 text-sm text-foreground-secondary">Loading proof run…</div>;
  }

  if (error || !proofRun) {
    return (
      <div className="p-8 space-y-4">
        <BackLink />
        <div className="flex items-center gap-2 rounded-lg border border-status-error/20 bg-status-error/10 p-3 text-sm text-status-error">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error || 'Proof run not found.'}
        </div>
      </div>
    );
  }

  const rolledBack = proofRun.status === 'rolled_back';
  const verdict = rolledBack ? 'rolled back' : proofRun.passed ? 'passed' : 'incomplete';
  const verdictTone = rolledBack
    ? 'border-status-warning/30 bg-status-warning/10 text-status-warning'
    : proofRun.passed
      ? 'border-status-success/30 bg-status-success/10 text-status-success'
      : 'border-border bg-background-elevated text-foreground-secondary';
  const counts = Object.entries(proofRun.counts);
  const minimums = Object.entries(proofRun.minimums);
  const missing = Object.entries(proofRun.missing);
  const artifacts = Object.entries(proofRun.artifact_refs).filter(([key]) =>
    ['goal', 'loop_run', 'worker_leases', 'panel', 'memory_candidate'].includes(key),
  );

  return (
    <div className="p-8 space-y-6">
      <BackLink />
      <div className="flex flex-wrap items-center gap-3">
        <Database className="h-5 w-5 text-status-success" />
        <h1 className="text-2xl font-bold text-foreground">Proof Run Detail</h1>
        <span className={`rounded border px-2 py-1 text-xs font-medium ${verdictTone}`}>{verdict}</span>
        <span className="font-mono text-xs text-foreground-tertiary">{proofRun.id}</span>
      </div>

      <p className="max-w-3xl text-sm text-foreground-secondary">
        One closed-loop run and its persisted evidence: counts, minimums, missing items, artifact refs and the narrative trace.
      </p>

      <section className="rounded-lg border border-border bg-background-secondary p-5">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Field label="Runtime" value={proofRun.runtime} />
          <Field label="Status" value={proofRun.status} />
          <Field label="Created" value={proofRun.created_at || 'unknown'} />
          <Field label="Completed" value={proofRun.completed_at || 'pending'} />
          <Field label="Rollback safe" value={proofRun.rollback_safe ? 'yes' : 'no'} />
          <Field label="Minimums passed" value={proofRun.passed ? 'yes' : 'no'} />
          <Field label="Missing items" value={String(missing.length)} />
          <Field label="Total counts" value={String(counts.length)} />
        </div>
      </section>

      <section className="rounded-lg border border-border bg-background-secondary p-5">
        <h2 className="text-lg font-semibold text-foreground">Counts vs Minimums</h2>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-foreground-tertiary">
              <tr>
                <th className="py-2 pr-4">Artifact</th>
                <th className="py-2 pr-4">Count</th>
                <th className="py-2 pr-4">Minimum</th>
                <th className="py-2 pr-4">Status</th>
              </tr>
            </thead>
            <tbody>
              {minimums.map(([key, min]) => {
                const count = proofRun.counts[key] ?? 0;
                const ok = count >= min;
                return (
                  <tr key={key} className="border-t border-border">
                    <td className="py-2 pr-4 font-mono text-xs text-foreground-secondary">{key}</td>
                    <td className="py-2 pr-4 font-mono text-foreground">{count}</td>
                    <td className="py-2 pr-4 font-mono text-foreground-secondary">{min}</td>
                    <td className="py-2 pr-4">
                      <span className={ok ? 'text-status-success' : 'text-status-error'}>{ok ? 'met' : 'short'}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {missing.length > 0 && (
          <div className="mt-3 rounded border border-status-error/20 bg-status-error/10 p-3 text-xs text-status-error">
            Missing: {missing.map(([key, n]) => `${key} (${n})`).join(', ')}
          </div>
        )}
      </section>

      <section className="rounded-lg border border-border bg-background-secondary p-5">
        <h2 className="text-lg font-semibold text-foreground">Artifact References</h2>
        <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
          {artifacts.map(([key, value]) => (
            <div key={key} className="rounded border border-border bg-background p-3 text-xs">
              <div className="text-foreground-tertiary">{key}</div>
              <div className="mt-1 font-mono text-foreground-secondary">
                {Array.isArray(value) ? value.join(', ') || 'none' : value || 'none'}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-border bg-background p-4">
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4 text-foreground-secondary" />
          <h3 className="text-sm font-semibold text-foreground">Run Narrative</h3>
        </div>
        <ol className="mt-3 space-y-3">
          {(proofRun.narrative.length ? proofRun.narrative : ['No narrative captured for this run.']).map((line, index, arr) => (
            <li key={index} className="flex gap-3">
              <div className="flex flex-col items-center">
                <span className="flex h-5 w-5 items-center justify-center rounded-full border border-border bg-background-elevated font-mono text-[10px] text-foreground-secondary">{index + 1}</span>
                {index < arr.length - 1 && <span className="mt-1 w-px flex-1 bg-border" />}
              </div>
              <p className="pb-1 text-sm text-foreground-secondary">{line}</p>
            </li>
          ))}
        </ol>
        {!rolledBack && (
          <div className="mt-4 border-t border-border pt-3">
            <button
              onClick={() => void rollback()}
              disabled={rollingBack || !proofRun.rollback_safe}
              className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-foreground-secondary hover:bg-background-elevated disabled:opacity-50"
            >
              <RotateCcw className={`h-4 w-4 ${rollingBack ? 'animate-spin' : ''}`} />
              {proofRun.rollback_safe ? 'Rollback this proof run' : 'Rollback blocked'}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function BackLink() {
  return (
    <Link to="/swarm-mission-control" className="inline-flex items-center gap-2 text-sm text-foreground-secondary hover:text-foreground">
      <ArrowLeft className="h-4 w-4" />
      Back to Mission Control
    </Link>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-border bg-background p-3">
      <div className="text-xs text-foreground-tertiary">{label}</div>
      <div className="mt-1 font-mono text-sm text-foreground">{value}</div>
    </div>
  );
}