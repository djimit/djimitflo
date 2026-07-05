import { useState, useCallback } from 'react';
import { Heart, AlertTriangle, CheckCircle, RefreshCw } from 'lucide-react';

interface HealthCheck {
  name: string;
  status: 'healthy' | 'degraded' | 'critical';
  message: string;
}

export function SelfHealingPage() {
  const [checks, setChecks] = useState<HealthCheck[]>([]);
  const [loading, setLoading] = useState(false);

  const runHealthCheck = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/intelligence/health');
      if (response.ok) {
        const data = await response.json();
        setChecks(data.checks || []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <div style={{ padding: '24px', maxWidth: '1200px', margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
        <Heart size={28} color="#ef4444" />
        <h1 style={{ fontSize: '24px', fontWeight: 700, margin: 0 }}>Self-Healing Dashboard</h1>
        <button onClick={runHealthCheck} disabled={loading} style={{
          marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px',
          padding: '8px 16px', background: '#ef4444', color: 'white',
          border: 'none', borderRadius: '6px', cursor: 'pointer',
        }}>
          <RefreshCw size={14} className={loading ? 'spin' : ''} />
          {loading ? 'Checking...' : 'Run Health Check'}
        </button>
      </div>

      {checks.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {checks.map((check, i) => (
            <div key={i} style={{
              padding: '16px', borderRadius: '8px',
              background: check.status === 'healthy' ? '#f0fdf4' : check.status === 'degraded' ? '#fffbeb' : '#fef2f2',
              border: `1px solid ${check.status === 'healthy' ? '#bbf7d0' : check.status === 'degraded' ? '#fde68a' : '#fecaca'}`,
              display: 'flex', alignItems: 'center', gap: '12px',
            }}>
              {check.status === 'healthy' ? <CheckCircle size={20} color="#10b981" /> :
               check.status === 'degraded' ? <AlertTriangle size={20} color="#f59e0b" /> :
               <AlertTriangle size={20} color="#ef4444" />}
              <div>
                <div style={{ fontWeight: 600, fontSize: '14px' }}>{check.name}</div>
                <div style={{ fontSize: '13px', color: '#6b7280' }}>{check.message}</div>
              </div>
              <span style={{
                marginLeft: 'auto', padding: '4px 12px', borderRadius: '4px', fontSize: '12px',
                background: check.status === 'healthy' ? '#dcfce7' : check.status === 'degraded' ? '#fef3c7' : '#fee2e2',
              }}>
                {check.status}
              </span>
            </div>
          ))}
        </div>
      )}

      {checks.length === 0 && !loading && (
        <div style={{ padding: '48px', textAlign: 'center', color: '#94a3b8' }}>
          Click "Run Health Check" to scan system health
        </div>
      )}
    </div>
  );
}
