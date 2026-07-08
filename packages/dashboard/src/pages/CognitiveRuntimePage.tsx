import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Brain, TrendingUp, Target, Zap, BarChart3, Award } from "lucide-react";

interface CognitiveStats {
  totalEpisodes: number;
  totalPatterns: number;
  totalStrategies: number;
  overallSuccessRate: number;
  bestGoalType: string | null;
}

interface MetaLearningRecord {
  goalType: string;
  bestStrategy: string;
  bestSuccessRate: number;
  totalEpisodes: number;
  totalStrategies: number;
  lastUpdated: string;
}

function formatPercent(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

function getSuccessColor(rate: number): string {
  if (rate >= 0.8) return "text-emerald-600";
  if (rate >= 0.5) return "text-amber-600";
  return "text-red-600";
}

export function CognitiveRuntimePage() {
  const [stats, setStats] = useState<CognitiveStats | null>(null);
  const [metaLearning, setMetaLearning] = useState<MetaLearningRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.getCognitiveStats().catch(() => null),
      api.getCognitiveMetaLearning().catch(() => []),
    ]).then(([s, ml]: any) => {
      setStats(s);
      setMetaLearning(Array.isArray(ml?.records) ? ml.records : ml || []);
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
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Brain className="w-7 h-7 text-purple-600" />
        <h1 className="text-2xl font-bold text-foreground">Cognitive Runtime</h1>
      </div>

      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          <StatCard icon={<BarChart3 className="w-5 h-5" />} label="Episodes" value={stats.totalEpisodes} color="blue" />
          <StatCard icon={<Zap className="w-5 h-5" />} label="Patterns" value={stats.totalPatterns} color="amber" />
          <StatCard icon={<Target className="w-5 h-5" />} label="Strategies" value={stats.totalStrategies} color="purple" />
          <StatCard icon={<TrendingUp className="w-5 h-5" />} label="Success Rate" value={formatPercent(stats.overallSuccessRate)} color="emerald" />
          <StatCard icon={<Award className="w-5 h-5" />} label="Best Goal Type" value={stats.bestGoalType || "—"} color="pink" />
        </div>
      )}

      <div className="bg-background-elevated rounded-xl border border-border p-6">
        <h2 className="text-lg font-semibold text-foreground mb-4">Meta-Learning Status</h2>
        {metaLearning.length === 0 ? (
          <p className="text-foreground-tertiary text-sm">
            No learned strategies yet. Complete 3+ loop runs per goal type to build cognitive memory.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 px-3 text-foreground-tertiary font-medium">Goal Type</th>
                  <th className="text-left py-2 px-3 text-foreground-tertiary font-medium">Best Strategy</th>
                  <th className="text-right py-2 px-3 text-foreground-tertiary font-medium">Success Rate</th>
                  <th className="text-right py-2 px-3 text-foreground-tertiary font-medium">Episodes</th>
                  <th className="text-right py-2 px-3 text-foreground-tertiary font-medium">Strategies</th>
                </tr>
              </thead>
              <tbody>
                {metaLearning.map((record) => (
                  <tr key={record.goalType} className="border-b border-border/50 hover:bg-background-subtle">
                    <td className="py-2 px-3 font-mono text-xs">{record.goalType}</td>
                    <td className="py-2 px-3">{record.bestStrategy || "—"}</td>
                    <td className={`py-2 px-3 text-right font-medium ${getSuccessColor(record.bestSuccessRate)}`}>
                      {formatPercent(record.bestSuccessRate)}
                    </td>
                    <td className="py-2 px-3 text-right">{record.totalEpisodes}</td>
                    <td className="py-2 px-3 text-right">{record.totalStrategies}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="bg-background-elevated rounded-xl border border-border p-6">
        <h2 className="text-lg font-semibold text-foreground mb-2">How It Works</h2>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 text-sm text-foreground-secondary">
          <div className="space-y-1">
            <div className="font-medium text-foreground">1. Record</div>
            <p>Every completed loop run is recorded as an episode with outcome, cost, and duration.</p>
          </div>
          <div className="space-y-1">
            <div className="font-medium text-foreground">2. Extract</div>
            <p>Patterns are mined from episode buffers — goal type correlations, strategy effectiveness, anomalies.</p>
          </div>
          <div className="space-y-1">
            <div className="font-medium text-foreground">3. Evolve</div>
            <p>Strategies are scored by success rate (70%) and cost efficiency (30%).</p>
          </div>
          <div className="space-y-1">
            <div className="font-medium text-foreground">4. Apply</div>
            <p>The best strategy for each goal type is pre-selected for future loops.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string | number; color: string }) {
  const colorMap: Record<string, string> = {
    blue: "bg-blue-50 text-blue-700 border-blue-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
    purple: "bg-purple-50 text-purple-700 border-purple-200",
    emerald: "bg-emerald-50 text-emerald-700 border-emerald-200",
    pink: "bg-pink-50 text-pink-700 border-pink-200",
  };

  return (
    <div className={`rounded-xl border p-4 ${colorMap[color] || colorMap.blue}`}>
      <div className="flex items-center gap-2 mb-1">
        {icon}
        <span className="text-xs font-medium opacity-80">{label}</span>
      </div>
      <div className="text-2xl font-bold">{value}</div>
    </div>
  );
}
