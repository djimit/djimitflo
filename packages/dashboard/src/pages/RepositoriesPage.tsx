import { useEffect, useState } from 'react';
import { FolderGit, RefreshCw, CheckCircle, ChevronRight, Plus } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { Repository } from '@djimitflo/shared';
import { api } from '../lib/api';
import { useAuthStore } from '../lib/auth-store';

/** GET /api/repositories adds path_exists (absent on older servers: treated as present). */
type RepositoryRow = Repository & { path_exists?: boolean };
const SHA = /^[0-9a-f]{7,40}$/i;
const STALE_DAYS = 14;

/** A readable title: explainer cache checkouts are named by commit SHA, so name them owner/repo @ sha7 from the remote or path. */
export function repoTitle(repo: Pick<Repository, 'name' | 'git_remote'> & { path: string | null }): string {
  if (!SHA.test(repo.name)) return repo.name;
  const remote = repo.git_remote?.replace(/\.git$/, '').split(/[/:]/).filter(Boolean).slice(-2).join('/');
  const parts = (repo.path ?? '').split('/').filter(Boolean);
  if (parts[parts.length - 1] === repo.name) parts.pop();
  const base = remote || parts.slice(-2).join('/');
  return base ? `${base} @ ${repo.name.slice(0, 7)}` : repo.name;
}

const ageDays = (at: string | null | undefined) => (at ? Math.floor((Date.now() - Date.parse(at)) / 86_400_000) : null);

export function RepositoriesPage() {
  const [repositories, setRepositories] = useState<RepositoryRow[]>([]);
  const [showMissing, setShowMissing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState<string | null>(null);
  const [scanResult, setScanResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const canScan = useAuthStore(s => s.hasPermission('scan:repository'));

  const load = async () => {
    setLoading(true);
    setError(null);
    try { setRepositories((await api.getRepositories()).repositories); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Repository list unavailable'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  const handleScan = async (path: string) => {
    if (!canScan || !path.trim() || scanning !== null) return;
    setScanning(path);
    setError(null);
    setScanResult(null);
    try {
      const result = await api.scanRepository(path);
      setScanResult(result);
      const res = await api.getRepositories();
      setRepositories(res.repositories);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Repository scan failed');
    } finally {
      setScanning(null);
    }
  };

  const handleRescan = async (id: string) => {
    if (!canScan || scanning !== null) return;
    setScanning(id);
    setError(null);
    setScanResult(null);
    try {
      const result = await api.rescanRepository(id);
      setScanResult(result);
      const res = await api.getRepositories();
      setRepositories(res.repositories);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Repository rescan failed');
    } finally {
      setScanning(null);
    }
  };

  const [scanPath, setScanPath] = useState('');
  const missing = repositories.filter((r) => r.path_exists === false).length;
  const shown = showMissing ? repositories : repositories.filter((r) => r.path_exists !== false);

  return (
    <div className="p-8 space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Repositories</h1>
          <p className="text-foreground-secondary mt-2">Scan, analyze, and monitor repositories for health, stack, and AGENTS.md governance.</p>
        </div>
        {canScan && !adding && <button type="button" onClick={() => setAdding(true)} className="flex items-center gap-2 px-4 py-2 rounded-lg border border-border hover:bg-background-elevated"><Plus className="w-4 h-4" />Add repository</button>}
      </div>

      {canScan && adding && <div className="bg-background-secondary border border-border rounded-lg p-6">
        <h2 className="text-lg font-semibold text-foreground mb-4">Scan Repository</h2>
        <label htmlFor="repository-scan-path" className="text-sm text-foreground-secondary">Repository path on the server</label>
        <form onSubmit={e => { e.preventDefault(); void handleScan(scanPath.trim()); }} className="flex flex-wrap gap-3">
          <input
            id="repository-scan-path"
            type="text"
            value={scanPath}
            onChange={(e) => setScanPath(e.target.value)}
            placeholder="/path/to/repository"
            className="flex-1 min-w-0 px-3 py-2 bg-background rounded border border-border text-foreground text-sm"
          />
          <button
            type="submit"
            disabled={scanning !== null || !scanPath.trim()}
            className="flex items-center gap-2 px-4 py-2 bg-accent text-white rounded-lg hover:bg-accent/90 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${scanning === scanPath ? 'animate-spin' : ''}`} />
            {scanning === scanPath ? 'Scanning...' : 'Scan'}
          </button>
        </form>
      </div>}

      {error && <div role="alert" className="text-status-error">{error} <button onClick={() => void load()} disabled={loading}>Retry repository list</button></div>}

      {scanResult && (
        <div className="bg-background-secondary border border-accent/20 rounded-lg p-6">
          <h3 className="text-lg font-semibold text-foreground mb-2 flex items-center gap-2">
            <CheckCircle className="w-5 h-5 text-status-completed" />
            Scan Result: {scanResult.repository?.name || 'Repository'}
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
            <div>
              <div className="text-xs text-foreground-tertiary">Health Score</div>
              <div className="text-lg font-bold text-foreground">{scanResult.health?.score ?? 'N/A'}/100</div>
            </div>
            <div>
              <div className="text-xs text-foreground-tertiary">Git Branch</div>
              <div className="text-sm text-foreground">{scanResult.gitStatus?.currentBranch || 'N/A'}</div>
            </div>
            <div>
              <div className="text-xs text-foreground-tertiary">Stack</div>
              <div className="text-sm text-foreground">{scanResult.stack?.detectedStacks?.join(', ') || 'None'}</div>
            </div>
            <div>
              <div className="text-xs text-foreground-tertiary">AGENTS.md</div>
              <div className="text-sm text-foreground">{scanResult.agentsMdFiles?.length ?? 0} file(s)</div>
            </div>
          </div>
          {scanResult.healthFindings?.length > 0 && (
            <div className="mt-4 space-y-2">
              <h4 className="text-sm font-medium text-foreground">Health Findings</h4>
              {scanResult.healthFindings.map((f: any, i: number) => (
                <div key={i} className={`p-2 rounded text-sm border ${f.severity === 'critical' ? 'bg-risk-critical/10 border-risk-critical/20 text-risk-critical' : f.severity === 'warning' ? 'bg-status-paused/10 border-status-paused/20 text-status-paused' : 'bg-blue-500/10 border-blue-500/20 text-blue-400'}`}>
                  <span className="font-medium">{f.title}</span>: {f.description}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {loading ? (
        <div className="bg-background-secondary border border-border rounded-lg p-8 text-foreground-secondary">Loading repositories...</div>
      ) : repositories.length === 0 && !error ? (
        <div className="bg-background-secondary border border-border rounded-lg p-12 text-center">
          <FolderGit className="w-12 h-12 text-foreground-muted mx-auto mb-4" />
          <p className="text-foreground-secondary">No repositories registered yet. Use Add repository to scan a path.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {missing > 0 && (
            <p className="text-sm text-foreground-tertiary">
              {missing} of {repositories.length} registered repositor{repositories.length === 1 ? 'y has a path' : 'ies have a path'} that no longer exists on the server{showMissing ? '' : ' (hidden)'}.{' '}
              <button type="button" onClick={() => setShowMissing((v) => !v)} className="underline">{showMissing ? 'Hide' : 'Show'} {missing} repositor{missing === 1 ? 'y' : 'ies'} whose path is missing</button>
            </p>
          )}
          {shown.map((repo) => { const age = ageDays(repo.last_synced_at ?? repo.updated_at); const stale = age !== null && age > STALE_DAYS; return (
            <div key={repo.id} className="bg-background-secondary border border-border rounded-lg p-6 hover:border-accent/20 transition-colors">
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-3">
                    <Link to={`/repositories/${repo.id}`} title={repo.name} className="text-lg font-semibold text-foreground hover:text-accent">
                      {repoTitle(repo)}
                    </Link>
                    {repo.path_exists === false && <span className="px-2 py-0.5 text-xs rounded border bg-status-error/10 text-status-error border-status-error/20">path missing</span>}
                    <span className={`px-2 py-0.5 text-xs rounded border ${repo.status === 'clean' ? 'bg-status-completed/10 text-status-completed border-status-completed/20' : repo.status === 'dirty' ? 'bg-status-paused/10 text-status-paused border-status-paused/20' : 'bg-foreground-muted/10 text-foreground-muted border-foreground-muted/20'}`}>
                      {repo.status}
                    </span>
                    {repo.has_git && <span className="text-xs text-foreground-tertiary">git</span>}
                    {repo.has_agents_md && <span className="text-xs text-foreground-tertiary">AGENTS.md</span>}
                  </div>
                  <p className="text-sm text-foreground-secondary mt-1">{repo.path}</p>
                  <div className="flex gap-4 mt-2 text-xs text-foreground-tertiary">
                    {repo.git_branch && <span>Branch: {repo.git_branch}</span>}
                    {repo.package_manager !== 'unknown' && <span>Package: {repo.package_manager}</span>}
                    {repo.detected_stacks?.length > 0 && <span>Stack: {repo.detected_stacks.join(', ')}</span>}
                    {repo.health_score !== null && repo.health_score !== undefined && <span className={stale ? 'opacity-50' : undefined} title={stale ? `Scanned ${age} days ago, older than ${STALE_DAYS} days: rescan for a current score` : undefined}>Health: {repo.health_score}/100</span>}
                    <span>{age === null ? 'never scanned' : `scanned ${age} d ago`}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {canScan && <button onClick={() => handleRescan(repo.id)} disabled={scanning !== null} className="p-2 hover:bg-background-elevated rounded-lg transition-colors disabled:opacity-50" title="Rescan">
                    <RefreshCw className={`w-4 h-4 text-foreground-secondary ${scanning === repo.id ? 'animate-spin' : ''}`} />
                  </button>}
                  <Link to={`/repositories/${repo.id}`} className="p-2 hover:bg-background-elevated rounded-lg transition-colors" title="Details">
                    <ChevronRight className="w-5 h-5 text-foreground-secondary" />
                  </Link>
                </div>
              </div>
            </div>
          ); })}
        </div>
      )}
    </div>
  );
}
