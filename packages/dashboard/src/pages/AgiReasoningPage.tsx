/**
 * AGI Reasoning Page — visualize autonomous goal reasoning and planning.
 */

import { useState, useCallback } from 'react';
import { Play, Brain, Target, CheckCircle, AlertTriangle, Loader } from 'lucide-react';
import { api } from '../lib/api';
import { PageHeader, primaryButton, panel } from '../components/PageHeader';

interface ReasoningResult {
  observations: { observations: string[]; anomalies: string[]; opportunities: string[] };
  hypotheses: Array<{ id: string; statement: string; confidence: number; status: string }>;
  strategies: Array<Array<{ id: string; action: string; status: string }>>;
}

export function AgiReasoningPage() {
  const [result, setResult] = useState<ReasoningResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runReasoning = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setResult(await api.request<ReasoningResult>('/agi/reason', { method: 'POST' }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to run reasoning');
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <PageHeader
        title="AGI Goal Reasoning"
        icon={<Brain className="h-7 w-7 text-accent" />}
        description="Observes the current system state, derives goal hypotheses and orders them into execution stages. Nothing is executed; it only proposes."
        actions={
          <button onClick={runReasoning} disabled={loading} className={primaryButton}>
            {loading ? <Loader className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {loading ? 'Reasoning...' : 'Run Reasoning'}
          </button>
        }
      />

      {error && (
        <div role="alert" className="flex items-center gap-2 rounded-lg border border-status-error/30 bg-status-error/10 p-3 text-status-error">
          <AlertTriangle className="h-4 w-4" /> {error}
        </div>
      )}

      {!result && !loading && !error && (
        <div className={`${panel} py-12 text-center text-foreground-secondary`}>Press "Run Reasoning" to analyse the current state.</div>
      )}

      {result && (
        <>
          <section>
            <h2 className="mb-3 text-lg font-semibold text-foreground">Observations</h2>
            <div className="grid gap-3 md:grid-cols-3">
              <Card title="System State" items={result.observations.observations} tone="text-accent" />
              <Card title="Anomalies" items={result.observations.anomalies} tone="text-status-paused" />
              <Card title="Opportunities" items={result.observations.opportunities} tone="text-status-completed" />
            </div>
          </section>

          <section>
            <h2 className="mb-3 text-lg font-semibold text-foreground">Goal Hypotheses</h2>
            <div className="space-y-2">
              {result.hypotheses.map((h) => (
                <div key={h.id} className={`${panel} flex items-center gap-2`}>
                  <Target className="h-4 w-4 text-accent" />
                  <span className="font-medium text-foreground">{h.statement}</span>
                  <span className={`ml-auto rounded px-2 py-0.5 text-xs ${h.confidence > 0.7 ? 'bg-status-completed/10 text-status-completed' : 'bg-status-paused/10 text-status-paused'}`}>
                    {(h.confidence * 100).toFixed(0)}%
                  </span>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h2 className="mb-3 text-lg font-semibold text-foreground">Execution Strategies</h2>
            <div className="space-y-3">
              {result.strategies.map((stage, i) => (
                <div key={i} className="rounded-lg border border-status-completed/20 bg-status-completed/5 p-3">
                  <div className="mb-1 text-xs text-foreground-tertiary">Stage {i + 1}</div>
                  <div className="flex flex-wrap gap-2">
                    {stage.map((step) => (
                      <span key={step.id} className="inline-flex items-center gap-1 rounded border border-border bg-background px-3 py-1 text-sm text-foreground">
                        <CheckCircle className="h-3 w-3" /> {step.action}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function Card({ title, items, tone }: { title: string; items: string[]; tone: string }) {
  return (
    <div className={panel}>
      <div className={`mb-2 text-sm font-semibold ${tone}`}>{title}</div>
      {items.length === 0 ? (
        <div className="text-xs text-foreground-muted">None detected</div>
      ) : (
        <ul className="list-disc pl-4 text-xs text-foreground-secondary">
          {items.slice(0, 5).map((item, i) => <li key={i}>{item.slice(0, 80)}</li>)}
        </ul>
      )}
    </div>
  );
}
