import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Shield, GitBranch, Package, FileText, AlertTriangle } from 'lucide-react';
import { api } from '../lib/api';

export function RepositoryDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [repository, setRepository] = useState<any>(null);
  const [health, setHealth] = useState<any>(null);
  const [agentsMd, setAgentsMd] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    Promise.all([
      api.getRepository(id).catch(() => null),
      api.getRepositoryHealth(id).catch(() => null),
      api.getRepositoryAgentsMd(id).catch(() => null),
    ]).then(([repoRes, healthRes, agentsRes]) => {
      if (repoRes) setRepository(repoRes.repository);
      if (healthRes) setHealth(healthRes);
      if (agentsRes) setAgentsMd(agentsRes);
    }).finally(() => setLoading(false));
  }, [id]);

  if (loading) return <div className="p-8 animate-pulse"><div className="h-8 bg-background-secondary rounded w-1/3 mb-4" /><div className="h-64 bg-background-secondary rounded" /></div>;
  if (!repository) return <div className="p-8 text-center"><h2 className="text-2xl font-bold">Repository not found</h2><Link to="/repositories" className="text-accent mt-4 inline-block">Back to Repositories</Link></div>;

  const healthScore = health?.health_score ?? repository.health_score ?? 'N/A';
  const findings = health?.findings ?? [];
  const agentsMdFiles = agentsMd?.files ?? [];
  const agentsMdIssues = agentsMd?.issues ?? [];

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-center gap-4">
        <Link to="/repositories" className="p-2 hover:bg-background-elevated rounded-lg transition-colors"><ArrowLeft className="w-5 h-5 text-foreground-secondary" /></Link>
        <div className="flex-1">
          <h1 className="text-3xl font-bold text-foreground">{repository.name}</h1>
          <p className="text-foreground-secondary mt-1">{repository.path}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-background-secondary border border-border rounded-lg p-6">
          <h2 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2"><GitBranch className="w-5 h-5" /> Git Status</h2>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between"><span className="text-foreground-secondary">Branch</span><span className="text-foreground font-mono">{repository.git_branch || 'N/A'}</span></div>
            <div className="flex justify-between"><span className="text-foreground-secondary">Commit</span><span className="text-foreground font-mono">{repository.git_commit?.slice(0, 8) || 'N/A'}</span></div>
            <div className="flex justify-between"><span className="text-foreground-secondary">Status</span><span className={repository.status === 'clean' ? 'text-status-completed' : repository.status === 'dirty' ? 'text-status-paused' : 'text-foreground'}>{repository.status}</span></div>
            <div className="flex justify-between"><span className="text-foreground-secondary">Has Git</span><span className="text-foreground">{repository.has_git ? 'Yes' : 'No'}</span></div>
          </div>
        </div>

        <div className="bg-background-secondary border border-border rounded-lg p-6">
          <h2 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2"><Package className="w-5 h-5" /> Stack & Scripts</h2>
          <div className="space-y-3">
            <div>
              <div className="text-xs text-foreground-tertiary mb-1">Package Manager</div>
              <div className="text-sm text-foreground">{repository.package_manager || 'unknown'}</div>
            </div>
            <div>
              <div className="text-xs text-foreground-tertiary mb-1">Detected Stacks</div>
              <div className="flex flex-wrap gap-1">{(repository.detected_stacks || []).map((s: string) => <span key={s} className="px-2 py-0.5 text-xs bg-background-elevated rounded border border-border">{s}</span>)}</div>
            </div>
            {(repository.test_commands?.length > 0 || repository.build_commands?.length > 0) && (
              <div className="space-y-1">
                {repository.test_commands?.map((c: string) => <div key={c} className="text-xs font-mono text-foreground-secondary">$ {c}</div>)}
                {repository.build_commands?.map((c: string) => <div key={c} className="text-xs font-mono text-foreground-secondary">$ {c}</div>)}
                {repository.lint_commands?.map((c: string) => <div key={c} className="text-xs font-mono text-foreground-secondary">$ {c}</div>)}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="bg-background-secondary border border-border rounded-lg p-6">
        <h2 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2"><Shield className="w-5 h-5" /> Health</h2>
        <div className="flex items-center gap-4 mb-4">
          <div className="text-4xl font-bold text-foreground">{healthScore}<span className="text-lg text-foreground-secondary">/100</span></div>
          <div className="flex-1 h-3 bg-background-elevated rounded-full overflow-hidden">
            <div className="h-full bg-status-completed rounded-full" style={{ width: `${typeof healthScore === 'number' ? healthScore : 0}%` }} />
          </div>
        </div>
        {findings.length > 0 ? (
          <div className="space-y-2">
            {findings.map((f: any, i: number) => (
              <div key={i} className={`p-3 rounded border text-sm ${f.severity === 'critical' ? 'bg-risk-critical/10 border-risk-critical/20' : f.severity === 'warning' ? 'bg-status-paused/10 border-status-paused/20' : 'bg-blue-500/10 border-blue-500/20'}`}>
                <div className="flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4" />
                  <span className="font-medium">{f.title}</span>
                  <span className={`text-xs px-1.5 py-0.5 rounded ${f.severity === 'critical' ? 'bg-risk-critical/20 text-risk-critical' : f.severity === 'warning' ? 'bg-status-paused/20 text-status-paused' : 'bg-blue-500/20 text-blue-400'}`}>{f.severity}</span>
                </div>
                <p className="text-foreground-secondary mt-1">{f.description}</p>
                {f.recommendation && <p className="text-foreground-tertiary mt-1 text-xs">→ {f.recommendation}</p>}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-foreground-secondary text-sm">No health findings.</p>
        )}
      </div>

      <div className="bg-background-secondary border border-border rounded-lg p-6">
        <h2 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2"><FileText className="w-5 h-5" /> AGENTS.md ({agentsMdFiles.length})</h2>
        {agentsMdFiles.length > 0 ? (
          <div className="space-y-3">
            {agentsMdFiles.map((f: any) => (
              <div key={f.id} className="border border-border rounded p-3">
                <div className="flex items-center gap-2"><FileText className="w-4 h-4 text-foreground-secondary" /><span className="font-mono text-sm text-foreground">{f.relativePath}</span></div>
                <div className="text-xs text-foreground-tertiary mt-1">{f.sizeBytes} bytes · applies to: {f.appliesToPath}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-4">
            <AlertTriangle className="w-8 h-8 text-status-paused mx-auto mb-2" />
            <p className="text-foreground-secondary text-sm">No AGENTS.md found. This is a governance gap.</p>
            <p className="text-foreground-tertiary text-xs mt-1">Create an AGENTS.md with build, test, and lint commands.</p>
          </div>
        )}
        {agentsMdIssues.length > 0 && (
          <div className="mt-4 space-y-2">
            <h3 className="text-sm font-medium text-foreground">Validation Issues</h3>
            {agentsMdIssues.map((issue: any, i: number) => (
              <div key={i} className={`p-2 rounded text-xs border ${issue.severity === 'critical' ? 'bg-risk-critical/10 border-risk-critical/20' : issue.severity === 'warning' ? 'bg-status-paused/10 border-status-paused/20' : 'bg-blue-500/10 border-blue-500/20'}`}>
                <span className="font-medium">{issue.title}</span>: {issue.description}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}