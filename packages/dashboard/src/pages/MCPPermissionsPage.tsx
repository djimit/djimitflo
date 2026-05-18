import { useEffect, useState } from 'react';
import { api } from '../lib/api';

export function MCPPermissionsPage() {
  const [permissions, setPermissions] = useState<Array<Record<string, unknown>>>([]);

  useEffect(() => {
    api.getMCPPermissions().then((result) => setPermissions(result.permissions)).catch((error) => {
      console.error('Failed to load MCP permissions:', error);
    });
  }, []);

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-foreground">MCP Permissions</h1>
        <p className="text-foreground-secondary mt-2">Inspect effective MCP tool decisions and risk levels.</p>
      </div>

      <div className="bg-background-secondary border border-border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-background-elevated text-left text-foreground-secondary">
            <tr>
              <th className="px-4 py-3">Tool</th>
              <th className="px-4 py-3">Decision</th>
              <th className="px-4 py-3">Risk</th>
              <th className="px-4 py-3">Reason</th>
            </tr>
          </thead>
          <tbody>
            {permissions.map((permission) => (
              <tr key={String(permission.id)} className="border-t border-border">
                <td className="px-4 py-3 text-foreground">{String(permission.tool_name || permission.tool_id || 'Unknown')}</td>
                <td className="px-4 py-3 text-foreground-secondary">{String(permission.decision || '-')}</td>
                <td className="px-4 py-3 text-foreground-secondary">{String(permission.risk_level || '-')}</td>
                <td className="px-4 py-3 text-foreground-secondary">{String(permission.reason || '-')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
