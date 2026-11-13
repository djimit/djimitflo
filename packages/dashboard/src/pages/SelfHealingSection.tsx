import { useState, useCallback } from 'react';
import { Heart, AlertTriangle, CheckCircle, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';
import { primaryButton, panel } from '../components/PageHeader';

interface HealthCheck {
  name: string;
  status: 'healthy' | 'degraded' | 'critical';
  message: string;
}

const TONE: Record<HealthCheck['status'], { card: string; badge: string; icon: string }> = {
  healthy: { card: 'border-status-completed/20 bg-status-completed/5', badge: 'bg-status-completed/10 text-status-completed', icon: 'text-status-completed' },
  degraded: { card: 'border-status-paused/20 bg-status-paused/5', badge: 'bg-status-paused/10 text-status-paused', icon: 'text-status-paused' },
  critical: { card: 'border-status-error/20 bg-status-error/5', badge: 'bg-status-error/10 text-status-error', icon: 'text-status-error' },
};

/** Nav cut (UX-30): the former /self-healing page, now a section of /observability (/self-healing redirects to #health-checks). */
export function SelfHealingSection() {
  const [checks, setChecks] = useState<HealthCheck[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runHealthCheck = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.request<{ checks: HealthCheck[] }>('/intelligence/health');
      setChecks(data.checks);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Health check failed');
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <section id="health-checks" aria-labelledby="health-checks-heading" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 id="health-checks-heading" className="flex items-center gap-2 text-lg font-semibold text-foreground"><Heart className="h-5 w-5 text-status-error" />Health checks</h2>
          <p className="mt-1 text-sm text-foreground-secondary">Read-only scan of loop failure rate, stale leases, leftover worktrees on disk, database size and memory.</p>
        </div>
        <button onClick={runHealthCheck} disabled={loading} className={primaryButton}>
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          {loading ? 'Checking...' : 'Run Health Check'}
        </button>
      </div>

      {error && <p role="alert" className="text-status-error">{error}</p>}

      {checks.length > 0 && (
        <div className="space-y-3">
          {checks.map((check) => {
            const tone = TONE[check.status];
            return (
              <div key={check.name} className={`flex items-center gap-3 rounded-lg border p-4 ${tone.card}`}>
                {check.status === 'healthy' ? <CheckCircle className={`h-5 w-5 ${tone.icon}`} /> : <AlertTriangle className={`h-5 w-5 ${tone.icon}`} />}
                <div>
                  <div className="text-sm font-semibold text-foreground">{check.name}</div>
                  <div className="text-sm text-foreground-secondary">{check.message}</div>
                </div>
                <span className={`ml-auto rounded px-3 py-1 text-xs ${tone.badge}`}>{check.status}</span>
              </div>
            );
          })}
        </div>
      )}

      {checks.length === 0 && !loading && (
        <div className={`${panel} py-6 text-center text-foreground-secondary`}>Click "Run Health Check" to scan system health.</div>
      )}
    </section>
  );
}
