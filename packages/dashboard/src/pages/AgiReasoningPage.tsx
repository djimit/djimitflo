/**
 * AGI Reasoning Page — visualize autonomous goal reasoning and planning.
 */

import { useState, useCallback } from 'react';
import { Play, Brain, Target, CheckCircle, AlertTriangle, Loader } from 'lucide-react';

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
      const response = await fetch('/api/agi/reason', { method: 'POST' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to run reasoning');
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <div style={{ padding: '24px', maxWidth: '1200px', margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
        <Brain size={28} color="#8b5cf6" />
        <h1 style={{ fontSize: '24px', fontWeight: 700, margin: 0 }}>AGI Goal Reasoning</h1>
        <button
          onClick={runReasoning}
          disabled={loading}
          style={{
            marginLeft: 'auto',
            display: 'flex', alignItems: 'center', gap: '8px',
            padding: '8px 16px', background: '#8b5cf6', color: 'white',
            border: 'none', borderRadius: '6px', cursor: 'pointer',
          }}
        >
          {loading ? <Loader size={14} className="spin" /> : <Play size={14} />}
          {loading ? 'Reasoning...' : 'Run Reasoning'}
        </button>
      </div>

      {error && (
        <div style={{ padding: '12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '6px', color: '#dc2626', marginBottom: '16px' }}>
          <AlertTriangle size={16} /> {error}
        </div>
      )}

      {result && (
        <>
          {/* Observations */}
          <section style={{ marginBottom: '24px' }}>
            <h2 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '12px' }}>Observations</h2>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
              <Card title="System State" items={result.observations.observations} icon="info" />
              <Card title="Anomalies" items={result.observations.anomalies} icon="warning" />
              <Card title="Opportunities" items={result.observations.opportunities} icon="success" />
            </div>
          </section>

          {/* Hypotheses */}
          <section style={{ marginBottom: '24px' }}>
            <h2 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '12px' }}>Goal Hypotheses</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {result.hypotheses.map((h) => (
                <div key={h.id} style={{ padding: '12px', background: '#f8fafc', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <Target size={14} color="#6366f1" />
                    <span style={{ fontWeight: 500 }}>{h.statement}</span>
                    <span style={{ marginLeft: 'auto', padding: '2px 8px', background: h.confidence > 0.7 ? '#dcfce7' : '#fef3c7', borderRadius: '4px', fontSize: '12px' }}>
                      {(h.confidence * 100).toFixed(0)}%
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Strategies */}
          <section>
            <h2 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '12px' }}>Execution Strategies</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {result.strategies.map((stage, i) => (
                <div key={i} style={{ padding: '12px', background: '#f0fdf4', borderRadius: '6px', border: '1px solid #bbf7d0' }}>
                  <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '4px' }}>Stage {i + 1}</div>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    {stage.map((step) => (
                      <span key={step.id} style={{ padding: '4px 12px', background: 'white', borderRadius: '4px', border: '1px solid #e2e8f0', fontSize: '13px' }}>
                        <CheckCircle size={12} style={{ marginRight: '4px' }} />
                        {step.action}
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

function Card({ title, items, icon }: { title: string; items: string[]; icon: string }) {
  const colors = { info: '#3b82f6', warning: '#f59e0b', success: '#10b981' };
  return (
    <div style={{ padding: '12px', background: '#f8fafc', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
      <div style={{ fontSize: '13px', fontWeight: 600, color: colors[icon as keyof typeof colors], marginBottom: '8px' }}>{title}</div>
      {items.length === 0 ? (
        <div style={{ fontSize: '12px', color: '#94a3b8' }}>None detected</div>
      ) : (
        <ul style={{ margin: 0, paddingLeft: '16px', fontSize: '12px' }}>
          {items.slice(0, 5).map((item, i) => <li key={i}>{item.slice(0, 80)}</li>)}
        </ul>
      )}
    </div>
  );
}
