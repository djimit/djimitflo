import { useEffect, useState } from 'react';
import { BookOpen, RefreshCw, Play, Pause, RotateCcw, Globe, ShieldCheck } from 'lucide-react';
import { api } from '../../lib/api';

export interface FleetRepository {
  id: string;
  full_name: string;
  priority_tier: number;
  language: string | null;
  license: string | null;
  stargazers_count: number;
  open_issues_count: number;
  last_commit_at: string | null;
  last_commit_sha: string | null;
  is_active: number;
  last_generated?: string | null;
  age_days?: number | null;
  openmythos_score?: number | null;
  task_status?: string | null;
  task_id?: string | null;
  health_score?: number | null;
  fresh?: boolean;
}

export interface FleetStatus {
  total_repositories: number;
  active_repositories: number;
  pending_jobs: number;
  running_jobs: number;
  completed_today: number;
  failed_today: number;
  paused: boolean;
  budget: {
    llm_calls_used: number;
    llm_calls_remaining: number;
    github_api_calls_used: number;
    github_api_calls_remaining: number;
    git_ops_used: number;
    git_ops_remaining: number;
  };
}

export function ExplainerFleetPage() {
  const [status, setStatus] = useState<FleetStatus | null>(null);
  const [repos, setRepos] = useState<FleetRepository[]>([]);
  const [driftCount, setDriftCount] = useState<number | null>(null);
  const [driftTypes, setDriftTypes] = useState<Record<string, number>>({});
  const [reviewCount, setReviewCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [fleetStatus, overviewRes, driftRes, reviewRes] = await Promise.all([
        api.get<FleetStatus>('/explainer/fleet/status'),
        api.get<{ repositories: FleetRepository[] }>('/explainer/fleet/overview'),
        api.get<{ drift_count: number; drift: Array<{ drift_type: string }> }>('/explainer/fleet/health-drift'),
        api.get<{ count: number }>('/explainer/review-queue'),
      ]);
      setStatus(fleetStatus);
      setRepos(overviewRes.repositories ?? []);
      setDriftCount(driftRes.drift_count ?? 0);
      const byType: Record<string, number> = {};
      for (const d of driftRes.drift ?? []) byType[d.drift_type] = (byType[d.drift_type] ?? 0) + 1;
      setDriftTypes(byType);
      setReviewCount(reviewRes.count ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function mutate(endpoint: string, body?: unknown) {
    setLoading(true);
    try {
      await api.post(`/explainer/fleet/${endpoint}`, body ?? {});
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function regenerate(fullName: string) {
    setLoading(true);
    try {
      await api.post('/explainer/fleet/regenerate', { full_name: fullName });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <BookOpen className="h-6 w-6 text-accent" />
            Explainer Fleet
          </h1>
          <p className="text-sm text-foreground-secondary">
            Manage autonomous repo explainers across the Djimit fleet.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {driftCount !== null && driftCount > 0 && (
            <button
              onClick={() => mutate('refresh-stale', { owner: 'djimit' })}
              disabled={loading}
              className="inline-flex items-center gap-2 rounded-full bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-500 ring-1 ring-amber-500/20 hover:bg-amber-500/20 disabled:opacity-50"
              title={Object.entries(driftTypes).map(([t, n]) => `${t}: ${n}`).join(', ')}
              aria-label={`${driftCount} knowledge drift detected`}
            >
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
              </span>
              {driftCount} drift
            </button>
          )}
          {reviewCount !== null && reviewCount > 0 && (
            <a
              href="#review-queue"
              className="inline-flex items-center gap-2 rounded-full bg-sky-500/10 px-3 py-1.5 text-xs font-medium text-sky-500 ring-1 ring-sky-500/20 hover:bg-sky-500/20"
              aria-label={`${reviewCount} bundles awaiting human review`}
              title="Bundles below quality threshold awaiting human review — resolve via /explainer/review-queue"
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              {reviewCount} review
            </a>
          )}
          <button
            onClick={() => mutate('sync', { owner: 'djimit' })}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
          >
            <RefreshCw className="h-4 w-4" />
            Sync
          </button>
          <button
            onClick={() => mutate('refresh-stale', { owner: 'djimit' })}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-background-secondary px-4 py-2 text-sm font-medium text-foreground hover:bg-background-elevated disabled:opacity-50"
          >
            <RotateCcw className="h-4 w-4" />
            Refresh Stale
          </button>
          <button
            onClick={() => mutate('run')}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-background-secondary px-4 py-2 text-sm font-medium text-foreground hover:bg-background-elevated disabled:opacity-50"
          >
            <Play className="h-4 w-4" />
            Run
          </button>
          <button
            onClick={() => mutate(status?.paused ? 'resume' : 'pause')}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-background-secondary px-4 py-2 text-sm font-medium text-foreground hover:bg-background-elevated disabled:opacity-50"
          >
            {status?.paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
            {status?.paused ? 'Resume' : 'Pause'}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-600">
          {error}
        </div>
      )}

      {status && (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4 lg:grid-cols-6">
          <Stat label="Repositories" value={status.total_repositories} />
          <Stat label="Active" value={status.active_repositories} />
          <Stat label="Pending Jobs" value={status.pending_jobs} />
          <Stat label="Running" value={status.running_jobs} />
          <Stat label="Completed Today" value={status.completed_today} />
          <Stat label="Failed Today" value={status.failed_today} />
        </div>
      )}

      {status && (
        <div className="rounded-xl border border-border bg-background-secondary p-4">
          <h2 className="mb-3 text-sm font-semibold text-foreground">Daily Budget</h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <BudgetBar label="LLM calls" used={status.budget.llm_calls_used} remaining={status.budget.llm_calls_remaining} />
            <BudgetBar label="GitHub API" used={status.budget.github_api_calls_used} remaining={status.budget.github_api_calls_remaining} />
            <BudgetBar label="Git ops" used={status.budget.git_ops_used} remaining={status.budget.git_ops_remaining} />
          </div>
        </div>
      )}

      <div className="rounded-xl border border-border bg-background-secondary">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">Repositories</h2>
          <span className="text-xs text-foreground-secondary">{repos.length} total</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-background-elevated text-xs uppercase text-foreground-secondary">
              <tr>
                <th className="px-4 py-2">Repository</th>
                <th className="px-4 py-2">Tier</th>
                <th className="px-4 py-2">Language</th>
                <th className="px-4 py-2">OpenMythos</th>
                <th className="px-4 py-2">Health</th>
                <th className="px-4 py-2">Last Generated</th>
                <th className="px-4 py-2">Freshness</th>
                <th className="px-4 py-2">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {repos.map((repo) => (
                <tr key={repo.id} className="hover:bg-background-elevated/50">
                  <td className="px-4 py-3 font-medium text-foreground">
                    <a
                      href={`https://github.com/${repo.full_name}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:text-accent"
                    >
                      {repo.full_name}
                    </a>
                  </td>
                  <td className="px-4 py-3">{repo.priority_tier}</td>
                  <td className="px-4 py-3">{repo.language ?? '-'}</td>
                  <td className="px-4 py-3">
                    {repo.openmythos_score !== null && repo.openmythos_score !== undefined ? (
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${repo.openmythos_score >= 85 ? 'bg-emerald-500/10 text-emerald-500' : 'bg-amber-500/10 text-amber-500'}`}>
                        {Math.round(repo.openmythos_score)}
                      </span>
                    ) : (
                      <span className="text-foreground-secondary">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {repo.health_score !== null && repo.health_score !== undefined ? (
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${repo.health_score >= 70 ? 'bg-emerald-500/10 text-emerald-500' : repo.health_score >= 40 ? 'bg-amber-500/10 text-amber-500' : 'bg-rose-500/10 text-rose-500'}`}>
                        {repo.health_score}
                      </span>
                    ) : (
                      <span className="text-foreground-secondary">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-foreground-secondary">
                    {repo.last_generated ? new Date(repo.last_generated).toLocaleDateString() : 'Never'}
                  </td>
                  <td className="px-4 py-3">
                    {repo.last_generated ? (
                      repo.fresh ? (
                        <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-500">Fresh</span>
                      ) : (
                        <span className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-500">Stale ({repo.age_days}d)</span>
                      )
                    ) : (
                      <span className="inline-flex items-center rounded-full bg-zinc-500/10 px-2 py-0.5 text-xs font-medium text-foreground-secondary">Pending</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <a
                        href={`/explore/${repo.full_name}`}
                        className="inline-flex items-center gap-1 text-accent hover:underline"
                      >
                        <Globe className="h-3 w-3" />
                        Explore
                      </a>
                      <button
                        onClick={() => regenerate(repo.full_name)}
                        disabled={loading}
                        className="inline-flex items-center gap-1 text-foreground-secondary hover:text-accent disabled:opacity-50"
                        aria-label={`Regenerate explainer for ${repo.full_name}`}
                      >
                        <RotateCcw className="h-3 w-3" />
                        Regenerate
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {repos.length === 0 && !loading && (
            <div className="px-4 py-8 text-center text-sm text-foreground-secondary">
              No repositories discovered yet. Click Sync to fetch the fleet.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-border bg-background-secondary p-4">
      <div className="text-2xl font-bold text-foreground">{value}</div>
      <div className="text-xs text-foreground-secondary">{label}</div>
    </div>
  );
}

function BudgetBar({ label, used, remaining }: { label: string; used: number; remaining: number }) {
  const total = used + remaining;
  const pct = total > 0 ? Math.round((used / total) * 100) : 0;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="text-foreground-secondary">{label}</span>
        <span className="text-foreground">
          {used} / {total}
        </span>
      </div>
      <div className="h-2 w-full rounded-full bg-background-elevated">
        <div
          className={`h-2 rounded-full ${pct >= 90 ? 'bg-rose-500' : pct >= 70 ? 'bg-amber-500' : 'bg-emerald-500'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
