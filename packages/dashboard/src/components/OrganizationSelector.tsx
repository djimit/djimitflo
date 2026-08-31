import React, { useState, useEffect } from 'react';
import { useAuthStore } from '../lib/auth-store';

interface Organization {
  id: string;
  name: string;
}

export const OrganizationSelector: React.FC = () => {
  const { token } = useAuthStore();
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [selectedOrg, setSelectedOrg] = useState<string>('');

  useEffect(() => {
    if (!token) return;
    const fetchOrganizations = async () => {
      try {
        const res = await fetch('/api/organizations', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data)) {
            setOrganizations(data);
            if (data.length > 0) setSelectedOrg(data[0].id);
          }
        }
      } catch {
        // ignore
      }
    };
    fetchOrganizations();
  }, [token]);

  const handleSwitchOrganization = async (orgId: string) => {
    if (!token) return;
    try {
      const res = await fetch('/api/organizations/switch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ organization_id: orgId }),
      });
      if (res.ok) {
        setSelectedOrg(orgId);
      }
    } catch {
      // ignore
    }
  };

  return (
    <select
      value={selectedOrg}
      onChange={(e) => handleSwitchOrganization(e.target.value)}
      className="px-3 py-1 border rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
    >
      {organizations.map((org) => (
        <option key={org.id} value={org.id}>
          {org.name}
        </option>
      ))}
    </select>
  );
};