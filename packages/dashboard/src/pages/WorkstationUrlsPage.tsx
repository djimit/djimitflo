import { useEffect, useState } from 'react';
import { Network, Server, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';

interface LivePort {
  address: string;
  port: number;
  pid: number | null;
  process: string;
  bind: string;
}

export function WorkstationUrlsPage() {
  const [ports, setPorts] = useState<LivePort[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = () => {
    setLoading(true);
    api.request('/workstation/urls')
      .then((res: any) => { setPorts(res.ports || []); setError(null); })
      .catch((e: any) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 30000);
    return () => clearInterval(interval);
  }, []);

  const lanPorts = ports.filter(p => p.bind === 'LAN');
  const localhostPorts = ports.filter(p => p.bind === 'Localhost');

  return (
    <div className="p-8 space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground flex items-center gap-3">
            <Network className="w-8 h-8 text-accent" /> Workstation URLs
          </h1>
          <p className="text-foreground-secondary mt-2">Live workstation endpoint map — auto-refreshes every 30 seconds</p>
        </div>
        <button onClick={loadData} className="flex items-center gap-2 px-3 py-2 bg-background-secondary border border-border rounded-lg hover:bg-background-elevated">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {error && <div className="bg-status-error/10 border border-status-error/20 rounded-lg p-4 text-status-error text-sm">{error}</div>}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-background-secondary border border-border rounded-lg p-5">
          <div className="text-sm text-foreground-secondary mb-2">Total Ports</div>
          <div className="text-2xl font-bold text-foreground">{ports.length}</div>
        </div>
        <div className="bg-background-secondary border border-border rounded-lg p-5">
          <div className="text-sm text-foreground-secondary mb-2">LAN Accessible</div>
          <div className="text-2xl font-bold text-status-active">{lanPorts.length}</div>
        </div>
        <div className="bg-background-secondary border border-border rounded-lg p-5">
          <div className="text-sm text-foreground-secondary mb-2">Localhost Only</div>
          <div className="text-2xl font-bold text-status-paused">{localhostPorts.length}</div>
        </div>
        <div className="bg-background-secondary border border-border rounded-lg p-5">
          <div className="text-sm text-foreground-secondary mb-2">Processes</div>
          <div className="text-2xl font-bold text-foreground">{new Set(ports.map(p => p.process)).size}</div>
        </div>
      </div>

      <div className="bg-background-secondary border border-border rounded-lg p-6">
        <h2 className="text-xl font-semibold text-foreground mb-4 flex items-center gap-2">
          <Server className="w-5 h-5 text-accent" /> Live Listening Ports
        </h2>
        {loading && ports.length === 0 ? (
          <div className="text-center py-8 text-foreground-muted">Scanning workstation ports...</div>
        ) : ports.length === 0 ? (
          <div className="text-center py-8 text-foreground-muted">No ports found</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-foreground-tertiary">
                  <th className="py-3 pr-4">Port</th>
                  <th className="py-3 pr-4">Address</th>
                  <th className="py-3 pr-4">Process</th>
                  <th className="py-3 pr-4">PID</th>
                  <th className="py-3 pr-4">Exposure</th>
                </tr>
              </thead>
              <tbody>
                {ports.sort((a, b) => a.port - b.port).map((p) => (
                  <tr key={`${p.port}-${p.address}`} className="border-b border-border/60">
                    <td className="py-3 pr-4 font-mono text-foreground">{p.port}</td>
                    <td className="py-3 pr-4 font-mono text-foreground-secondary">{p.address}</td>
                    <td className="py-3 pr-4 text-foreground">{p.process}</td>
                    <td className="py-3 pr-4 font-mono text-foreground-tertiary">{p.pid || '—'}</td>
                    <td className="py-3 pr-4">
                      <span className={`px-2 py-0.5 rounded-full text-xs ${p.bind === 'LAN' ? 'bg-status-active/10 text-status-active' : 'bg-status-paused/10 text-status-paused'}`}>{p.bind}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
