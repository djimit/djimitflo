/**
 * Predictive Analytics Page — visualize loop outcome predictions and system health.
 */

import { useState, useCallback, type ReactNode } from 'react';
import { TrendingUp, AlertTriangle, CheckCircle, Activity } from 'lucide-react';
import { api } from '../lib/api';
import { PageHeader, primaryButton, panel } from '../components/PageHeader';

interface Prediction {
  successProbability: number;
  expectedDurationMs: number;
  expectedCostDollars: number;
  riskFactors: string[];
  recommendations: string[];
}

export function PredictiveAnalyticsPage() {
  const [prediction, setPrediction] = useState<Prediction | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runPrediction = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPrediction(await api.request<Prediction>('/intelligence/predict', {
        method: 'POST',
        body: JSON.stringify({ goalType: 'general', runtime: 'mock', mode: 'closed' }),
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Prediction failed');
    } finally {
      setLoading(false);
    }
  }, []);

  const likely = (prediction?.successProbability ?? 0) > 0.7;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <PageHeader
        title="Predictive Analytics"
        icon={<TrendingUp className="h-7 w-7 text-status-completed" />}
        description="Estimates the success chance, duration and cost of a typical closed-loop run on the mock runtime, with the risk factors behind the estimate."
        actions={<button onClick={runPrediction} disabled={loading} className={primaryButton}>{loading ? 'Predicting...' : 'Run Prediction'}</button>}
      />

      {error && <p role="alert" className="text-status-error">{error}</p>}

      {!prediction && !loading && !error && (
        <div className={`${panel} py-12 text-center text-foreground-secondary`}>Press "Run Prediction" to estimate a typical run.</div>
      )}

      {prediction && (
        <div className="grid gap-4 md:grid-cols-3">
          <MetricCard title="Success Probability" value={`${(prediction.successProbability * 100).toFixed(0)}%`}
            icon={<CheckCircle className={`h-5 w-5 ${likely ? 'text-status-completed' : 'text-status-paused'}`} />}
            tone={likely ? 'bg-status-completed/10' : 'bg-status-paused/10'} />
          <MetricCard title="Expected Duration" value={`${Math.round(prediction.expectedDurationMs / 60000)}min`}
            icon={<Activity className="h-5 w-5 text-accent" />} tone="bg-accent/10" />
          <MetricCard title="Expected Cost" value={`$${prediction.expectedCostDollars.toFixed(3)}`}
            icon={<TrendingUp className="h-5 w-5 text-accent-secondary" />} tone="bg-accent-secondary/10" />
        </div>
      )}

      {prediction && prediction.riskFactors.length > 0 && (
        <section>
          <h2 className="mb-3 text-lg font-semibold text-foreground">Risk Factors</h2>
          <div className="space-y-2">
            {prediction.riskFactors.map((risk, i) => (
              <div key={i} className="flex items-center gap-2 rounded-lg border border-status-error/20 bg-status-error/5 p-3">
                <AlertTriangle className="h-4 w-4 text-status-error" />
                <span className="text-sm text-foreground">{risk}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function MetricCard({ title, value, icon, tone }: { title: string; value: string; icon: ReactNode; tone: string }) {
  return (
    <div className={`rounded-lg border border-border p-5 ${tone}`}>
      <div className="mb-2 flex items-center gap-2">
        {icon}
        <span className="text-sm font-medium text-foreground-secondary">{title}</span>
      </div>
      <div className="text-3xl font-bold text-foreground">{value}</div>
    </div>
  );
}
