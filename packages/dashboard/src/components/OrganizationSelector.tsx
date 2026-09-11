import React, { useState, useEffect } from 'react';
import { apiRequest, sameSessionScope, useAuthStore } from '../lib/auth-store';

interface Organization {
  id: string;
  name: string;
}

// Display only: authorization still validates the signed token/current user server-side.
function organizationFromToken(token: string | null): string {
  try {
    const payload = token?.split('.')[1];
    if (!payload) return '';
    const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof claims.organization_id === 'string' ? claims.organization_id : 'default';
  } catch { return ''; }
}

export const OrganizationSelector: React.FC = () => {
  const token = useAuthStore((state) => state.token);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const selectedOrg = organizationFromToken(token);

  useEffect(() => {
    let active = true;
    setOrganizations([]);
    if (!token) return;
    setLoading(true);
    setError(null);
    void apiRequest<Organization[]>('/organizations').then((data) => {
      if (!Array.isArray(data) || data.some(org => typeof org?.id !== 'string' || typeof org?.name !== 'string')) {
        throw new Error('Invalid organization list');
      }
      if (active) setOrganizations(data);
    }).catch((err) => {
      if (active) setError(err instanceof Error ? err.message : 'Failed to load organizations');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [token, retry]);

  const handleSwitchOrganization = async (orgId: string) => {
    if (!token || switching || loading || orgId === selectedOrg) return;
    setSwitching(true);
    setError(null);
    try {
      const result = await apiRequest<{ token: string }>('/organizations/switch', {
        method: 'POST',
        body: JSON.stringify({ organization_id: orgId }),
      });
      if (!sameSessionScope(token, useAuthStore.getState().token)) throw new Error('Session changed; organization switch was not applied');
      useAuthStore.getState().replaceToken(result.token);
      // Drop page caches and reconnect WebSockets under the replacement scope.
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Organization switch failed');
    } finally {
      setSwitching(false);
    }
  };

  return (
    <div>
      <select
        value={selectedOrg}
        onChange={(e) => void handleSwitchOrganization(e.target.value)}
        disabled={!token || loading || switching || organizations.length === 0}
        aria-label="Organization"
        className="max-w-full w-full px-3 py-1 border rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
      >
        <option value="" disabled>{loading ? 'Loading organizations…' : 'Select organization'}</option>
        {organizations.map((org) => (
          <option key={org.id} value={org.id}>
            {org.name}
          </option>
        ))}
      </select>
      {error && <p role="alert" className="mt-1 text-xs text-status-error">{error}</p>}
      {error && organizations.length === 0 && token && (
        <button onClick={() => setRetry(value => value + 1)} disabled={loading || switching} className="mt-1 text-xs underline">Retry organizations</button>
      )}
    </div>
  );
};
