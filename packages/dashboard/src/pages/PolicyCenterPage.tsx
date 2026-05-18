import { useEffect, useState } from 'react';
import type { ExecutionPolicy } from '@djimitflo/shared';
import { api } from '../lib/api';

export function PolicyCenterPage() {
  const [policies, setPolicies] = useState<ExecutionPolicy[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getPolicies().then((result) => {
      setPolicies(result.policies);
      setLoading(false);
    }).catch((error) => {
      console.error('Failed to load policies:', error);
      setLoading(false);
    });
  }, []);

  const togglePolicy = async (policy: ExecutionPolicy) => {
    const updated = await api.updatePolicy(policy.id, { enabled: !policy.enabled });
    setPolicies((current) => current.map((item) => (item.id === updated.id ? updated : item)));
  };

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-foreground">Policy Center</h1>
        <p className="text-foreground-secondary mt-2">Control which actions are allowed, blocked, or require approval.</p>
      </div>

      {loading ? (
        <div className="bg-background-secondary border border-border rounded-lg p-8 text-foreground-secondary">Loading policies...</div>
      ) : (
        <div className="space-y-4">
          {policies.map((policy) => (
            <div key={policy.id} className="bg-background-secondary border border-border rounded-lg p-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold text-foreground">{policy.name}</h2>
                  <p className="text-sm text-foreground-secondary mt-1">{policy.description}</p>
                  <div className="flex flex-wrap gap-2 mt-3 text-xs">
                    <span className="px-2 py-1 rounded border border-border text-foreground-secondary">{policy.action_type}</span>
                    <span className="px-2 py-1 rounded border border-border text-foreground-secondary">{policy.risk_level}</span>
                    <span className="px-2 py-1 rounded border border-border text-foreground-secondary">{policy.decision}</span>
                  </div>
                </div>
                <button
                  onClick={() => void togglePolicy(policy)}
                  className={`px-4 py-2 rounded-lg border ${policy.enabled ? 'bg-status-running/10 text-status-running border-status-running/20' : 'bg-status-error/10 text-status-error border-status-error/20'}`}
                >
                  {policy.enabled ? 'Enabled' : 'Disabled'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
