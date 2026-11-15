import { useEffect, useState } from 'react';
import type { ExecutionPolicy } from '@djimitflo/shared';
import { api } from '../lib/api';
import { useDialog } from '../components/ConfirmDialog';
import { fmtDate } from '../lib/format';
import { ACTION_PERMISSIONS as P, needsText, useCan } from '../lib/permissions';

/** GET /policies adds the latest audit event per policy (null when the audit trail has none). */
type PolicyRow = ExecutionPolicy & { last_change?: { at: string; action: string; user_id: string | null; email: string | null; role: string | null } | null };

const riskLevels = (policy: PolicyRow) => (policy.risk_levels?.length ? policy.risk_levels : [policy.risk_level]);
const enforces = (policy: PolicyRow) => {
  const scope = `${policy.action_type} actions at risk ${riskLevels(policy).join(', ')}`;
  return policy.decision === 'deny' ? `${scope} are no longer blocked by this policy` : `${scope} no longer require approval from this policy`;
};

export function PolicyCenterPage() {
  const canEdit = useCan(P.policyUpdate);
  const dialog = useDialog();
  const [policies, setPolicies] = useState<PolicyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

  useEffect(() => {
    api.getPolicies().then((result) => {
      setPolicies(result.policies);
    }).catch((err) => setError(`Could not load policies: ${message(err)}`))
      .finally(() => setLoading(false));
  }, []);

  const togglePolicy = async (policy: PolicyRow) => {
    setError(null);
    if (policy.enabled && (policy.decision === 'deny' || policy.decision === 'require_approval')
      && !(await dialog.confirm(`Disable "${policy.name}"?`, `While it is disabled, ${enforces(policy)}.`, 'Disable policy'))) return;
    try {
      const updated = await api.updatePolicy(policy.id, { enabled: !policy.enabled });
      setPolicies((current) => current.map((item) => (item.id === updated.id ? { ...updated, last_change: item.last_change } : item)));
      // the PATCH wrote an audit event: reload so "last changed" shows it
      api.getPolicies().then((result) => setPolicies(result.policies)).catch((err) => setError(`Could not reload policies: ${message(err)}`));
    } catch (err) {
      setError(`Could not update policy ${policy.name}: ${message(err)}`);
    }
  };

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-foreground">Policies</h1>
        <p className="text-foreground-secondary mt-2">Control which actions are allowed, blocked, or require approval.</p>
      </div>

      {error && <p role="alert" className="text-sm text-status-error">{error}</p>}

      {loading ? (
        <div className="bg-background-secondary border border-border rounded-lg p-8 text-foreground-secondary">Loading policies...</div>
      ) : (
        <div className="space-y-4">
          {policies.map((policy, index) => (
            <div key={policy.id} className="bg-background-secondary border border-border rounded-lg p-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold text-foreground">{policy.name}</h2>
                  <p className="text-sm text-foreground-secondary mt-1">{policy.description}</p>
                  <div className="flex flex-wrap gap-2 mt-3 text-xs">
                    <span className="px-2 py-1 rounded border border-border text-foreground-secondary">{policy.action_type}</span>
                    <span className="px-2 py-1 rounded border border-border text-foreground-secondary">{riskLevels(policy).join(', ')}</span>
                    <span className="px-2 py-1 rounded border border-border text-foreground-secondary">{policy.decision}</span>
                    <span className="px-2 py-1 rounded border border-border text-foreground-secondary" title="Policies are evaluated in priority order, highest first">priority {policy.priority ?? 0} · #{index + 1} in evaluation order</span>
                  </div>
                  <p className="text-xs text-foreground-secondary mt-2">
                    {policy.last_change
                      ? `Last changed ${fmtDate(policy.last_change.at)} by ${policy.last_change.email ? `${policy.last_change.email}${policy.last_change.role ? ` (${policy.last_change.role})` : ''}` : policy.last_change.user_id ?? 'unknown'} (${policy.last_change.action})`
                      : 'No change recorded in the audit trail'}
                  </p>
                </div>
                <button
                  onClick={() => void togglePolicy(policy)}
                  disabled={!canEdit}
                  title={canEdit ? undefined : needsText(P.policyUpdate)}
                  className={`px-4 py-2 rounded-lg border ${policy.enabled ? 'bg-status-running/10 text-status-running border-status-running/20' : 'bg-status-error/10 text-status-error border-status-error/20'}`}
                >
                  {policy.enabled ? 'Enabled' : 'Disabled'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {dialog.element}
    </div>
  );
}
