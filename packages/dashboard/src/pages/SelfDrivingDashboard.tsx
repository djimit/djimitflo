import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Brain, Zap, Shield, Database, TrendingUp, Activity, CheckCircle } from "lucide-react";

type DashboardStats = {
  cognitive: Awaited<ReturnType<typeof api.getCognitiveStats>> | null;
  memory: Awaited<ReturnType<typeof api.getMemoryStats>> | null;
  meta: Awaited<ReturnType<typeof api.getMetaStats>> | null;
  compliance: Awaited<ReturnType<typeof api.getComplianceStatus>> | null;
};

export function SelfDrivingDashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [tuningResult, setTuningResult] = useState<string>('');
  const [tuning, setTuning] = useState(false);
  const [tuningError, setTuningError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api.getCognitiveStats().catch(() => null),
      api.getMemoryStats().catch(() => null),
      api.getMetaStats().catch(() => null),
      api.getComplianceStatus().catch(() => null),
    ]).then(([cognitive, memory, meta, compliance]) => {
      setStats({ cognitive, memory, meta, compliance });
      setLoading(false);
    });
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-center gap-3">
        <Activity className="w-7 h-7 text-blue-600" />
        <h1 className="text-2xl font-bold text-foreground">Self-Driving Control Plane</h1>
      </div>

      {stats && (
        <>
          {stats.cognitive ? <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <StatCard icon={<Brain className="w-5 h-5" />} label="Episodes" value={stats.cognitive.totalEpisodes} color="purple" />
            <StatCard icon={<TrendingUp className="w-5 h-5" />} label="Patterns" value={stats.cognitive.totalPatterns} color="blue" />
            <StatCard icon={<Zap className="w-5 h-5" />} label="Strategies" value={stats.cognitive.totalStrategies} color="amber" />
            <StatCard icon={<CheckCircle className="w-5 h-5" />} label="Success Rate" value={`${(stats.cognitive.overallSuccessRate * 100).toFixed(0)}%`} color="emerald" />
          </div> : <p>Cognitive metrics unavailable.</p>}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Panel title="Meta Orchestration" icon={<Activity className="w-5 h-5 text-purple-600" />}>
              {stats.meta?.enabled ? <div className="grid grid-cols-3 gap-4 text-sm mb-4">
                <Metric label="Decisions" value={stats.meta.totalDecisions} />
                <Metric label="Predicted failures" value={stats.meta.failuresPredicted} />
                <Metric label="Cost savings" value={`$${stats.meta.costSavingsDollars.toFixed(2)}`} />
              </div> : <p className="mb-4 text-sm text-foreground-secondary">{stats.meta ? 'Meta orchestration is disabled on this instance.' : 'Meta orchestration metrics unavailable.'}</p>}
              <button disabled={!stats.meta?.enabled || tuning} className="rounded-lg bg-blue-600 px-3 py-2 text-sm text-white disabled:opacity-50" onClick={async () => {
                setTuning(true);
                setTuningError(null);
                try {
                  const result = await api.post<{ enabled: false } | { evaluated: number; applied: number }>('/meta/tuning/run');
                  if ('enabled' in result) throw new Error('Meta orchestration is disabled on this instance.');
                  setTuningResult(`${result.applied}/${result.evaluated} recommendations applied`);
                } catch (error) {
                  setTuningError(error instanceof Error ? error.message : 'Tuning failed');
                } finally {
                  setTuning(false);
                }
              }}>{tuning ? 'Tuning...' : 'Run bounded tuning'}</button>
              {tuningResult && <p className="mt-2 text-xs text-foreground-secondary">{tuningResult}</p>}
              {tuningError && <p role="alert" className="mt-2 text-sm text-status-error">{tuningError}</p>}
            </Panel>

            <Panel title="Proactive Memory" icon={<Database className="w-5 h-5 text-blue-600" />}>
              {stats.memory ? <div className="grid grid-cols-2 gap-4 text-sm">
                <Metric label="Total Memories" value={stats.memory.total} />
                <Metric label="Active" value={stats.memory.active} />
                <Metric label="Candidates" value={stats.memory.candidates} />
                <Metric label="Avg Relevance" value={stats.memory.avgRelevance.toFixed(2)} />
                <Metric label="Relations" value={stats.memory.totalRelations} />
              </div> : <p>Memory metrics unavailable.</p>}
            </Panel>

            <Panel title="Compliance" icon={<Shield className="w-5 h-5 text-green-600" />}>
              {stats.compliance ? <div className="grid grid-cols-2 gap-4 text-sm">
                <Metric label="Audit Entries" value={stats.compliance.totalAuditEntries} />
                <Metric label="Chain Integrity" value={stats.compliance.chainIntegrity ? "✓ Valid" : "✗ Broken"} />
                <Metric label="Last Score" value={`${(stats.compliance.lastReportScore * 100).toFixed(0)}%`} />
                <Metric label="Status" value={stats.compliance.lastReportStatus || "—"} />
              </div> : <p>Compliance metrics unavailable.</p>}
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}

function StatCard({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string | number; color: string }) {
  const colors: Record<string, string> = {
    blue: "bg-blue-50 text-blue-700 border-blue-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
    purple: "bg-purple-50 text-purple-700 border-purple-200",
    emerald: "bg-emerald-50 text-emerald-700 border-emerald-200",
  };
  return (
    <div className={`rounded-xl border p-4 ${colors[color] || colors.blue}`}>
      <div className="flex items-center gap-2 mb-1">{icon}<span className="text-xs font-medium opacity-80">{label}</span></div>
      <div className="text-2xl font-bold">{value}</div>
    </div>
  );
}

function Panel({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-background-elevated rounded-xl border border-border p-6">
      <div className="flex items-center gap-2 mb-4">{icon}<h2 className="text-lg font-semibold text-foreground">{title}</h2></div>
      {children}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div className="text-foreground-tertiary text-xs">{label}</div>
      <div className="font-medium text-foreground">{value}</div>
    </div>
  );
}
