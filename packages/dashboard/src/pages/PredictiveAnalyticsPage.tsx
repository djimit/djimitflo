/**
 * Predictive Analytics Page — visualize loop outcome predictions and system health.
 */

import { useState, useCallback } from 'react';
import { TrendingUp, AlertTriangle, CheckCircle, Activity } from 'lucide-react';

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

  const runPrediction = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/intelligence/predict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goalType: 'general', runtime: 'mock', mode: 'closed' }),
      });
      if (response.ok) {
        setPrediction(await response.json());
      }
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <div style={{ padding: '24px', maxWidth: '1200px', margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
        <TrendingUp size={28} color="#10b981" />
        <h1 style={{ fontSize: '24px', fontWeight: 700, margin: 0 }}>Predictive Analytics</h1>
        <button onClick={runPrediction} disabled={loading} style={{
          marginLeft: 'auto', padding: '8px 16px', background: '#10b981', color: 'white',
          border: 'none', borderRadius: '6px', cursor: 'pointer',
        }}>
          {loading ? 'Predicting...' : 'Run Prediction'}
        </button>
      </div>

      {prediction && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px', marginBottom: '24px' }}>
          <MetricCard
            title="Success Probability"
            value={`${(prediction.successProbability * 100).toFixed(0)}%`}
            icon={<CheckCircle size={20} color={prediction.successProbability > 0.7 ? '#10b981' : '#f59e0b'} />}
            color={prediction.successProbability > 0.7 ? '#dcfce7' : '#fef3c7'}
          />
          <MetricCard
            title="Expected Duration"
            value={`${Math.round(prediction.expectedDurationMs / 60000)}min`}
            icon={<Activity size={20} color="#6366f1" />}
            color="#eef2ff"
          />
          <MetricCard
            title="Expected Cost"
            value={`$${prediction.expectedCostDollars.toFixed(3)}`}
            icon={<TrendingUp size={20} color="#8b5cf6" />}
            color="#f5f3ff"
          />
        </div>
      )}

      {prediction && prediction.riskFactors.length > 0 && (
        <div style={{ marginBottom: '24px' }}>
          <h2 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '12px' }}>Risk Factors</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {prediction.riskFactors.map((risk, i) => (
              <div key={i} style={{ padding: '12px', background: '#fef2f2', borderRadius: '6px', border: '1px solid #fecaca', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <AlertTriangle size={14} color="#dc2626" />
                <span style={{ fontSize: '14px' }}>{risk}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function MetricCard({ title, value, icon, color }: { title: string; value: string; icon: React.ReactNode; color: string }) {
  return (
    <div style={{ padding: '20px', background: color, borderRadius: '8px', border: '1px solid #e5e7eb' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
        {icon}
        <span style={{ fontSize: '13px', fontWeight: 500, color: '#6b7280' }}>{title}</span>
      </div>
      <div style={{ fontSize: '28px', fontWeight: 700 }}>{value}</div>
    </div>
  );
}
