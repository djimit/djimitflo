import { useEffect, useState } from 'react';
import { FolderGit, RefreshCw, CheckCircle, ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { Repository } from '@djimitflo/shared';
import { api } from '../lib/api';

export function RepositoriesPage() {
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState<string | null>(null);
  const [scanResult, setScanResult] = useState<any>(null);

  useEffect(() => {
    api.getRepositories().then((res) => setRepositories(res.repositories)).finally(() => setLoading(false));
  }, []);

  const handleScan = async (path: string) => {
    setScanning(path);
    try {
      const result = await api.scanRepository(path);
      setScanResult(result);
      const res = await api.getRepositories();
      setRepositories(res.repositories);
    } catch (error) {
      console.error('Scan failed:', error);
    } finally {
      setScanning(null);
    }
  };

  const handleRescan = async (id: string) => {
    setScanning(id);
    try {
      const result = await api.rescanRepository(id);
      setScanResult(result);
      const res = await api.getRepositories();
      setRepositories(res.repositories);
    } catch (error) {
      console.error('Rescan failed:', error);
    } finally {
      setScanning(null);
    }
  };

  const [scanPath, setScanPath] = useState('/home/djimit/workspace/djimitflo');

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-foreground">Repositories</h1>
        <p className="text-foreground-secondary mt-2">Scan, analyze, and monitor repositories for health, stack, and AGENTS.md governance.</p>
      </div>

      <div className="bg-background-secondary border border-border rounded-lg p-6">
        <h2 className="text-lg font-semibold text-foreground mb-4">Scan Repository</h2>
        <div className="flex gap-3">
          <input
            type="text"
            value={scanPath}
            onChange={(e) => setScanPath(e.target.value)}
            placeholder="/path/to/repository"
            className="flex-1 px-3 py-2 bg-background rounded border border-border text-foreground text-sm"
          />
          <button
            onClick={() => handleScan(scanPath)}
            disabled={scanning !== null}
            className="flex items-center gap-2 px-4 py-2 bg-accent text-white rounded-lg hover:bg-accent/90 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${scanning === scanPath ? 'animate-spin' : ''}`} />
            {scanning === scanPath ? 'Scanning...' : 'Scan'}
          </button>
        </div>
      </div>

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
      ) : repositories.length === 0 ? (
        <div className="bg-background-secondary border border-border rounded-lg p-12 text-center">
          <FolderGit className="w-12 h-12 text-foreground-muted mx-auto mb-4" />
          <p className="text-foreground-secondary">No repositories registered yet. Scan a repository path to get started.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {repositories.map((repo) => (
            <div key={repo.id} className="bg-background-secondary border border-border rounded-lg p-6 hover:border-accent/20 transition-colors">
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-3">
                    <Link to={`/repositories/${repo.id}`} className="text-lg font-semibold text-foreground hover:text-accent">
                      {repo.name}
                    </Link>
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
                    {repo.health_score !== null && repo.health_score !== undefined && <span>Health: {repo.health_score}/100</span>}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => handleRescan(repo.id)} disabled={scanning !== null} className="p-2 hover:bg-background-elevated rounded-lg transition-colors disabled:opacity-50" title="Rescan">
                    <RefreshCw className={`w-4 h-4 text-foreground-secondary ${scanning === repo.id ? 'animate-spin' : ''}`} />
                  </button>
                  <Link to={`/repositories/${repo.id}`} className="p-2 hover:bg-background-elevated rounded-lg transition-colors" title="Details">
                    <ChevronRight className="w-5 h-5 text-foreground-secondary" />
                  </Link>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}