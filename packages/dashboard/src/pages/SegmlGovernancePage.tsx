/**
 * SEGML Governance Dashboard — real-time governance evolution monitoring.
 */

import { useState, useCallback } from 'react';
import { Shield, TrendingUp, TrendingDown, Activity, AlertTriangle, CheckCircle, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';

interface SegmlCycle {
  id: string;
  status: string;
  score_delta: number;
  memories_created: number;
  cases_generated: number;
  blind_spots_detected: string[];
  started_at: string;
}

interface SegmlStatus {
  cycles: SegmlCycle[];
  monitoredAgents?: number;
}

export function SegmlGovernancePage() {
  const [status, setStatus] = useState<SegmlStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState('');

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.request('/segml/history?limit=10') as any;
      setStatus({ cycles: res.cycles || [] });
    } catch { /* ignore */ } finally { setLoading(false); }
  }, []);

  const runCycle = useCallback(async () => {
    if (!selectedAgent) return;
    setLoading(true);
    try {
      await api.request(`/segml/run/${selectedAgent}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      await loadStatus();
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [selectedAgent, loadStatus]);

  const latestCycle = status?.cycles?.[0];

  return (
    <div style={{ padding: '24px', maxWidth: '1200px', margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
        <Shield size={28} color="#6366f1" />
        <h1 style={{ fontSize: '24px', fontWeight: 700, margin: 0 }}>SEGML Governance</h1>
        <button onClick={loadStatus} disabled={loading} style={{
          marginLeft: 'auto', padding: '8px 16px', background: '#6366f1', color: 'white',
          border: 'none', borderRadius: '6px', cursor: 'pointer',
        }}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {/* Latest cycle summary */}
      {latestCycle && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px', marginBottom: '24px' }}>
          <StatCard
            label="Status"
            value={latestCycle.status}
            icon={latestCycle.status === 'completed' ? <CheckCircle size={16} color="#10b981" /> : <AlertTriangle size={16} color="#f59e0b" />}
          />
          <StatCard
            label="Score Delta"
            value={latestCycle.score_delta > 0 ? `+${latestCycle.score_delta.toFixed(2)}` : latestCycle.score_delta.toFixed(2)}
            icon={latestCycle.score_delta >= 0 ? <TrendingUp size={16} color="#10b981" /> : <TrendingDown size={16} color="#ef4444" />}
          />
          <StatCard label="Memories Created" value={String(latestCycle.memories_created)} icon={<Activity size={16} color="#6366f1" />} />
          <StatCard label="Cases Generated" value={String(latestCycle.cases_generated)} icon={<Shield size={16} color="#8b5cf6" />} />
        </div>
      )}

      {/* Blind spots */}
      {latestCycle && latestCycle.blind_spots_detected.length > 0 && (
        <div style={{ background: '#fef3c7', border: '1px solid #f59e0b', borderRadius: '8px', padding: '16px', marginBottom: '24px' }}>
          <h3 style={{ margin: '0 0 8px', fontSize: '14px', fontWeight: 600, color: '#92400e' }}>
            <AlertTriangle size={14} style={{ verticalAlign: 'middle', marginRight: '6px' }} />
            Active Blind Spots
          </h3>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {latestCycle.blind_spots_detected.map(spot => (
              <span key={spot} style={{ padding: '4px 12px', background: '#fde68a', borderRadius: '12px', fontSize: '12px', fontWeight: 500 }}>
                {spot}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Run cycle */}
      <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '16px', marginBottom: '24px' }}>
        <h3 style={{ margin: '0 0 12px', fontSize: '14px', fontWeight: 600 }}>Trigger SEGML Cycle</h3>
        <div style={{ display: 'flex', gap: '8px' }}>
          <input
            type="text"
            placeholder="Agent ID"
            value={selectedAgent}
            onChange={e => setSelectedAgent(e.target.value)}
            style={{ flex: 1, padding: '8px 12px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px' }}
          />
          <button onClick={runCycle} disabled={loading || !selectedAgent} style={{
            padding: '8px 16px', background: '#6366f1', color: 'white', border: 'none',
            borderRadius: '6px', cursor: 'pointer', opacity: (!selectedAgent || loading) ? 0.5 : 1,
          }}>
            Run Cycle
          </button>
        </div>
      </div>

      {/* Cycle history */}
      {status?.cycles && status.cycles.length > 0 && (
        <div>
          <h3 style={{ margin: '0 0 12px', fontSize: '14px', fontWeight: 600 }}>Cycle History</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {status.cycles.map(cycle => (
              <div key={cycle.id} style={{
                display: 'flex', alignItems: 'center', gap: '16px', padding: '12px 16px',
                background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '6px',
              }}>
                <span style={{ fontSize: '12px', color: '#64748b', minWidth: '180px' }}>
                  {new Date(cycle.started_at).toLocaleString()}
                </span>
                <span style={{
                  padding: '2px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 600,
                  background: cycle.status === 'completed' ? '#dcfce7' : '#fef3c7',
                  color: cycle.status === 'completed' ? '#166534' : '#92400e',
                }}>
                  {cycle.status}
                </span>
                <span style={{ fontSize: '13px', color: '#374151' }}>
                  Δ {cycle.score_delta > 0 ? '+' : ''}{cycle.score_delta.toFixed(2)}
                </span>
                <span style={{ fontSize: '12px', color: '#64748b' }}>
                  {cycle.memories_created} memories · {cycle.cases_generated} cases
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
        {icon}
        <span style={{ fontSize: '12px', color: '#64748b', fontWeight: 500 }}>{label}</span>
      </div>
      <span style={{ fontSize: '20px', fontWeight: 700, color: '#1e293b' }}>{value}</span>
    </div>
  );
}
