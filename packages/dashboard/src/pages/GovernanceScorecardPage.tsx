import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, TrendingUp, TrendingDown, Minus, RefreshCw, FlaskConical } from 'lucide-react';
import { api, type AgentGovernanceScore, type OpenMythosRun } from '../lib/api';

function scoreColor(score: number): string {
  if (score >= 4) return 'text-status-completed';
  if (score >= 3) return 'text-risk-medium';
  return 'text-status-error';
}

function TrendIcon({ trend }: { trend: AgentGovernanceScore['trend'] }) {
  if (trend === 'improving') return <TrendingUp className="w-4 h-4 text-status-completed" aria-label="improving" />;
  if (trend === 'declining') return <TrendingDown className="w-4 h-4 text-status-error" aria-label="declining" />;
  return <Minus className="w-4 h-4 text-foreground-tertiary" aria-label="stable" />;
}

export function GovernanceScorecardPage() {
  const [leaderboard, setLeaderboard] = useState<AgentGovernanceScore[]>([]);
  const [runs, setRuns] = useState<OpenMythosRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [board, recent] = await Promise.all([
        api.getOpenMythosLeaderboard(),
        api.getOpenMythosRuns(20),
      ]);
      setLeaderboard(board.leaderboard);
      setRuns(recent.runs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load governance data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Governance Scorecard</h1>
          <p className="text-foreground-secondary mt-2">
            OpenMythos Governance Benchmark results per agent — latest score, category breakdown, and trend (0–5 scale).
          </p>
        </div>
        <button
          onClick={() => void load()}
          disabled={loading}
          className="flex items-center gap-2 bg-background-secondary border border-border rounded-lg px-3 py-1.5 text-sm text-foreground hover:bg-background-elevated disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="bg-status-error/10 border border-status-error/30 rounded-lg p-4 text-sm text-status-error">{error}</div>
      )}

      {loading ? (
        <div className="bg-background-secondary border border-border rounded-lg p-8 text-foreground-secondary">Loading governance data...</div>
      ) : leaderboard.length === 0 ? (
        <div className="bg-background-secondary border border-border rounded-lg p-12 text-center">
          <ShieldCheck className="w-12 h-12 text-foreground-muted mx-auto mb-4" />
          <p className="text-foreground-secondary">No governance evaluations recorded yet.</p>
          <p className="text-xs text-foreground-tertiary mt-2 font-mono">POST /api/openmythos/eval/:agentId to run the benchmark.</p>
        </div>
      ) : (
        <div className="bg-background-secondary border border-border rounded-lg p-6">
          <h2 className="text-lg font-semibold text-foreground mb-4">Leaderboard</h2>
          <div className="space-y-4">
            {leaderboard.map((agent, rank) => (
              <div key={agent.agentId} className="border-l-2 border-border pl-4 py-2">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="text-xs font-mono text-foreground-tertiary">#{rank + 1}</span>
                  <span className="text-sm font-medium text-foreground">{agent.agentId}</span>
                  <span className={`text-lg font-bold ${scoreColor(agent.overallScore)}`}>{agent.overallScore.toFixed(2)}</span>
                  <TrendIcon trend={agent.trend} />
                  <span className="text-xs text-foreground-tertiary">
                    {agent.totalCases} cases · {agent.lastEvalAt ? new Date(agent.lastEvalAt).toLocaleString() : 'n/a'}
                  </span>
                </div>
                {Object.keys(agent.categoryScores).length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {Object.entries(agent.categoryScores)
                      .sort(([, a], [, b]) => a - b)
                      .map(([category, score]) => (
                        <span
                          key={category}
                          className={`text-xs px-1.5 py-0.5 rounded bg-background-elevated ${scoreColor(score)}`}
                          title={`${category}: ${score.toFixed(2)}/5`}
                        >
                          {category} {score.toFixed(1)}
                        </span>
                      ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {!loading && runs.length > 0 && (
        <div className="bg-background-secondary border border-border rounded-lg p-6">
          <h2 className="text-lg font-semibold text-foreground mb-4">Recent Eval Runs</h2>
          <div className="space-y-2">
            {runs.map((run) => (
              <div key={run.id} className="flex items-center gap-3 flex-wrap border-l-2 border-border pl-3 py-1">
                <FlaskConical className="w-3.5 h-3.5 text-foreground-tertiary" />
                <span className="text-xs font-mono text-foreground-tertiary">{(run.id ?? '').slice(0, 8)}</span>
                <span className="text-sm text-foreground">{run.agentId}</span>
                {run.subjectModel && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-background-elevated text-foreground-secondary font-mono">{run.subjectModel}</span>
                )}
                <span className={`text-xs px-1.5 py-0.5 rounded ${
                  run.status === 'completed' ? 'bg-status-completed/10 text-status-completed' :
                  run.status === 'failed' ? 'bg-status-error/10 text-status-error' :
                  'bg-background-elevated text-foreground-secondary'
                }`}>{run.status}</span>
                <span className={`text-sm font-semibold ${scoreColor(run.overallScore)}`}>{run.overallScore.toFixed(2)}</span>
                <span className="text-xs text-foreground-tertiary">
                  {run.completedCases}/{run.totalCases} cases
                  {run.oracleCases !== null && ` · ${run.oracleCases} oracle`}
                  {run.finishedAt && ` · ${new Date(run.finishedAt).toLocaleString()}`}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
