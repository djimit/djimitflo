import { useEffect, useState } from 'react';
import { DollarSign } from 'lucide-react';
import { api } from '../lib/api';

interface CapabilityEconomy {
  capability_id: string;
  capability_kind: string;
  status: string;
  n_runs: number;
  n_completed: number;
  success_rate: number;
  p50_tokens: number;
  p95_tokens: number;
  p50_dollars: number;
  p95_dollars: number;
  verified_artifacts_per_dollar: number | null;
}

interface RunEconomy {
  run_id: string;
  loop_name: string;
  status: string;
  verified_artifacts: number;
  dollars_spent: number;
  efficiency: number | null;
}

export function EconomyPage() {
  const [data, setData] = useState<{ capabilities: CapabilityEconomy[]; recent_runs: RunEconomy[]; summary: any } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.request('/swarms/economy').then((d) => setData(d as { capabilities: CapabilityEconomy[]; recent_runs: RunEconomy[]; summary: any })).catch(() => {}).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="p-8 text-foreground-tertiary">Loading economy data...</div>;
  if (!data) return <div className="p-8 text-foreground-tertiary">No economy data available.</div>;

  return (
    <div className="p-8 space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-foreground flex items-center gap-3">
          <DollarSign className="w-8 h-8 text-accent" /> Economy
        </h1>
        <p className="text-foreground-secondary mt-2">Dollar-denominated cost tracking and verified-artifacts-per-dollar efficiency</p>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-background-secondary border border-border rounded-lg p-6">
          <div className="text-sm text-foreground-secondary mb-2">Total Capabilities</div>
          <div className="text-3xl font-bold text-foreground">{data.summary.total_capabilities}</div>
        </div>
        <div className="bg-background-secondary border border-border rounded-lg p-6">
          <div className="text-sm text-foreground-secondary mb-2">Total Verified Artifacts</div>
          <div className="text-3xl font-bold text-foreground">{data.summary.total_verified_artifacts}</div>
        </div>
        <div className="bg-background-secondary border border-border rounded-lg p-6">
          <div className="text-sm text-foreground-secondary mb-2">Total Dollars Spent</div>
          <div className="text-3xl font-bold text-foreground">${data.summary.total_dollars_spent?.toFixed(4) || '0.00'}</div>
        </div>
      </div>

      {/* Per-capability */}
      <div className="bg-background-secondary border border-border rounded-lg p-6">
        <h2 className="text-xl font-semibold text-foreground mb-4">Per-Capability Economy</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-foreground-tertiary">
                <th className="py-3 pr-4">Capability</th>
                <th className="py-3 pr-4">Status</th>
                <th className="py-3 pr-4">Runs</th>
                <th className="py-3 pr-4">Success Rate</th>
                <th className="py-3 pr-4">P50 $</th>
                <th className="py-3 pr-4">P95 $</th>
                <th className="py-3 pr-4">Artifacts/$</th>
              </tr>
            </thead>
            <tbody>
              {data.capabilities.map((cap) => (
                <tr key={cap.capability_id} className="border-b border-border/60">
                  <td className="py-3 pr-4 font-mono text-foreground">{cap.capability_id.slice(0, 12)}</td>
                  <td className="py-3 pr-4"><span className="px-2 py-0.5 rounded-full text-xs bg-accent/10 text-accent-secondary">{cap.status}</span></td>
                  <td className="py-3 pr-4">{cap.n_runs}</td>
                  <td className="py-3 pr-4">{(cap.success_rate * 100).toFixed(0)}%</td>
                  <td className="py-3 pr-4">${cap.p50_dollars?.toFixed(4) || '0'}</td>
                  <td className="py-3 pr-4">${cap.p95_dollars?.toFixed(4) || '0'}</td>
                  <td className="py-3 pr-4">{cap.verified_artifacts_per_dollar ? cap.verified_artifacts_per_dollar.toFixed(2) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Per-run */}
      <div className="bg-background-secondary border border-border rounded-lg p-6">
        <h2 className="text-xl font-semibold text-foreground mb-4">Recent Run Efficiency</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-foreground-tertiary">
                <th className="py-3 pr-4">Run</th>
                <th className="py-3 pr-4">Status</th>
                <th className="py-3 pr-4">Verified Artifacts</th>
                <th className="py-3 pr-4">$ Spent</th>
                <th className="py-3 pr-4">Efficiency</th>
              </tr>
            </thead>
            <tbody>
              {data.recent_runs.map((run) => (
                <tr key={run.run_id} className="border-b border-border/60">
                  <td className="py-3 pr-4 font-mono text-foreground">{run.run_id.slice(0, 8)}</td>
                  <td className="py-3 pr-4">{run.status}</td>
                  <td className="py-3 pr-4">{run.verified_artifacts}</td>
                  <td className="py-3 pr-4">${run.dollars_spent.toFixed(4)}</td>
                  <td className="py-3 pr-4">{run.efficiency ? run.efficiency.toFixed(2) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
