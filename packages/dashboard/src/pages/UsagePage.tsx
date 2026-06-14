import { useState, useEffect } from 'react';
import { DollarSign, Activity, AlertTriangle, Server, Zap } from 'lucide-react';
import { api } from '../lib/api';

interface ProviderQuota {
  provider: string;
  tier: string;
  is_active: boolean;
  tokens_used_hourly: number;
  tokens_used_daily: number;
  tokens_used_weekly: number;
  tokens_used_monthly: number;
  quota_hourly: number | null;
  quota_daily: number | null;
  quota_weekly: number | null;
  quota_monthly: number | null;
  cost_total: number;
  cost_per_1k_prompt: number | null;
  cost_per_1k_completion: number | null;
  rate_limit_rpm: number | null;
  rate_limit_rpd: number | null;
}

interface UsageData {
  quotas: ProviderQuota[];
  total_tokens: number;
  total_cost: number;
  daily_usage: { date: string; tokens: number; cost: number }[];
  recent_logs: {
    id: string;
    timestamp: string;
    provider: string;
    model: string;
    task_id: string | null;
    prompt_tokens: number;
    completion_tokens: number;
    cost: number;
  }[];
}

function MetricCard({ icon: Icon, label, value, sub, color }: {
  icon: any;
  label: string;
  value: string | number;
  sub?: string;
  color: string;
}) {
  return (
    <div className={`bg-background-secondary rounded-lg p-4 border-l-4 ${color}`}>
      <div className="flex items-center gap-2 text-content-secondary mb-1">
        <Icon className="w-4 h-4" />
        <span className="text-sm">{label}</span>
      </div>
      <div className="text-2xl font-semibold text-content-primary">{value}</div>
      {sub && <div className="text-xs text-content-secondary mt-1">{sub}</div>}
    </div>
  );
}

function QuotaBar({ used, quota, label }: { used: number; quota: number | null; label: string }) {
  if (!quota) return null;
  const pct = Math.min((used / quota) * 100, 100);
  const color = pct < 50 ? 'bg-green-500' : pct < 80 ? 'bg-yellow-500' : 'bg-red-500';
  return (
    <div className="mb-2">
      <div className="flex justify-between text-xs text-content-secondary mb-1">
        <span>{label}</span>
        <span>{used.toLocaleString()} / {quota.toLocaleString()} ({pct.toFixed(0)}%)</span>
      </div>
      <div className="h-2 bg-background-elevated rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ProviderCard({ p }: { p: ProviderQuota }) {
  const maxQuota = Math.max(p.quota_hourly || 0, p.quota_daily || 0, p.quota_weekly || 0, p.quota_monthly || 0);
  const maxUsed = Math.max(p.tokens_used_hourly, p.tokens_used_daily, p.tokens_used_weekly, p.tokens_used_monthly);
  const exhausted = maxQuota > 0 && maxUsed >= maxQuota;

  return (
    <div className={`bg-background-secondary rounded-lg p-4 border ${p.is_active ? 'border-accent/20' : 'border-red-500/20'}`}>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-semibold text-content-primary capitalize">{p.provider.replace(/-/g, ' ')}</h3>
          <span className="text-xs text-content-secondary">{p.tier}</span>
        </div>
        <div className="flex items-center gap-2">
          {exhausted && <AlertTriangle className="w-4 h-4 text-red-500" aria-label="Quota exhausted" />}
          <span className={`w-2 h-2 rounded-full ${p.is_active ? 'bg-green-500' : 'bg-red-500'}`} />
        </div>
      </div>

      <QuotaBar used={p.tokens_used_hourly} quota={p.quota_hourly} label="Hourly" />
      <QuotaBar used={p.tokens_used_daily} quota={p.quota_daily} label="Daily" />
      <QuotaBar used={p.tokens_used_weekly} quota={p.quota_weekly} label="Weekly" />
      <QuotaBar used={p.tokens_used_monthly} quota={p.quota_monthly} label="Monthly" />

      <div className="mt-3 pt-3 border-t border-border flex justify-between text-xs text-content-secondary">
        <span>Cost: ${p.cost_total.toFixed(4)}</span>
        {p.cost_per_1k_prompt != null && (
          <span>${p.cost_per_1k_prompt}/1k prompt</span>
        )}
      </div>
    </div>
  );
}

export function UsagePage() {
  const [data, setData] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api.getUsageQuotas().catch(() => ({ quotas: [] })),
      api.getUsageTokens({ group_by: 'day' }).catch(() => ({ total_tokens: 0, total_cost: 0, breakdown: [] })),
      api.getUsageRecent(20).catch(() => ({ logs: [] })),
    ]).then(([quotas, tokens, recent]) => {
      setData({
        quotas: quotas.quotas || [],
        total_tokens: tokens.total_tokens || 0,
        total_cost: tokens.total_cost || 0,
        daily_usage: tokens.breakdown || [],
        recent_logs: recent.logs || [],
      });
    }).catch((e) => setError(e.message))
    .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-background-secondary rounded-lg p-6 text-center">
        <AlertTriangle className="w-8 h-8 text-red-500 mx-auto mb-2" />
        <p className="text-content-secondary">{error}</p>
      </div>
    );
  }

  if (!data) return null;

  const activeProviders = data.quotas.filter(p => p.is_active).length;
  const worstQuota = data.quotas.reduce((max, p) => {
    const pcts = [p.quota_hourly, p.quota_daily, p.quota_weekly, p.quota_monthly].map((q, i) => {
      const used = [p.tokens_used_hourly, p.tokens_used_daily, p.tokens_used_weekly, p.tokens_used_monthly][i];
      return q && q > 0 ? (used / q) * 100 : 0;
    });
    return Math.max(max, ...pcts);
  }, 0);

  const maxDailyTokens = Math.max(...data.daily_usage.map(d => d.tokens), 1);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-content-primary">Usage</h1>
        <p className="text-content-secondary mt-1">Token usage and subscription tracking across all providers</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard icon={Zap} label="Total Tokens" value={data.total_tokens.toLocaleString()} color="border-blue-500" />
        <MetricCard icon={DollarSign} label="Total Cost" value={`$${data.total_cost.toFixed(4)}`} color="border-green-500" />
        <MetricCard icon={Server} label="Active Providers" value={activeProviders} sub={`of ${data.quotas.length} total`} color="border-purple-500" />
        <MetricCard
          icon={Activity}
          label="Quota Utilization"
          value={`${worstQuota.toFixed(0)}%`}
          sub={worstQuota > 80 ? 'Critical — switch providers' : worstQuota > 50 ? 'Monitor closely' : 'Healthy'}
          color={worstQuota > 80 ? 'border-red-500' : worstQuota > 50 ? 'border-yellow-500' : 'border-green-500'}
        />
      </div>

      <div>
        <h2 className="text-lg font-semibold text-content-primary mb-3">Provider Breakdown</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {data.quotas.map(p => (
            <ProviderCard key={p.provider} p={p} />
          ))}
        </div>
      </div>

      <div>
        <h2 className="text-lg font-semibold text-content-primary mb-3">Daily Token Usage (Last 30 Days)</h2>
        <div className="bg-background-secondary rounded-lg p-4">
          {data.daily_usage.length === 0 ? (
            <p className="text-content-secondary text-sm">No usage data yet. Token usage will appear here as agents execute tasks.</p>
          ) : (
            <div className="space-y-1">
              {data.daily_usage.slice(0, 14).map(d => (
                <div key={d.date} className="flex items-center gap-3">
                  <span className="text-xs text-content-secondary w-20">{d.date.slice(5)}</span>
                  <div className="flex-1 h-4 bg-background-elevated rounded-full overflow-hidden">
                    <div
                      className="h-full bg-accent rounded-full transition-all"
                      style={{ width: `${(d.tokens / maxDailyTokens) * 100}%` }}
                    />
                  </div>
                  <span className="text-xs text-content-primary w-24 text-right">{d.tokens.toLocaleString()}</span>
                  <span className="text-xs text-content-secondary w-20 text-right">${d.cost.toFixed(4)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div>
        <h2 className="text-lg font-semibold text-content-primary mb-3">Recent Usage Log</h2>
        <div className="bg-background-secondary rounded-lg overflow-hidden">
          {data.recent_logs.length === 0 ? (
            <p className="p-4 text-content-secondary text-sm">No recent usage. Token usage logging will appear as agents execute tasks.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-content-secondary">
                    <th className="text-left p-3">Time</th>
                    <th className="text-left p-3">Provider</th>
                    <th className="text-left p-3">Model</th>
                    <th className="text-right p-3">Prompt</th>
                    <th className="text-right p-3">Completion</th>
                    <th className="text-right p-3">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent_logs.map((log: any) => (
                    <tr key={log.id} className="border-b border-border/50 hover:bg-background-elevated/50">
                      <td className="p-3 text-content-secondary text-xs">{new Date(log.timestamp).toLocaleTimeString()}</td>
                      <td className="p-3 text-content-primary capitalize">{log.provider}</td>
                      <td className="p-3 text-content-secondary">{log.model}</td>
                      <td className="p-3 text-content-primary text-right">{log.prompt_tokens.toLocaleString()}</td>
                      <td className="p-3 text-content-primary text-right">{log.completion_tokens.toLocaleString()}</td>
                      <td className="p-3 text-content-primary text-right">${(log.cost || 0).toFixed(6)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
