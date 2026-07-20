import { useEffect, useState } from 'react';
import { PlugZap, Circle } from 'lucide-react';
import type { MCPServer } from '@djimitflo/shared';
import { api } from '../lib/api';

const STATUS_DOT: Record<string, string> = {
  running: 'bg-green-500',
  stopped: 'bg-gray-500',
  error: 'bg-red-500',
  unknown: 'bg-yellow-500',
};

const STATUS_LABEL: Record<string, string> = {
  running: 'text-green-400',
  stopped: 'text-gray-400',
  error: 'text-red-400',
  unknown: 'text-yellow-400',
};

export function MCPPermissionsPage() {
  const [servers, setServers] = useState<MCPServer[]>([]);
  const [permissions, setPermissions] = useState<Array<Record<string, unknown>>>([]);
  const [serverId, setServerId] = useState('');
  const [decision, setDecision] = useState('');
  const [riskLevel, setRiskLevel] = useState('');
  const [query, setQuery] = useState('');
  const [serversLoading, setServersLoading] = useState(true);
  const [permissionsLoading, setPermissionsLoading] = useState(true);
  const serverStats = permissions.reduce<Record<string, { tools: number; approvals: number }>>((stats, permission) => {
    const id = String(permission.server_id || '');
    if (!id) return stats;
    stats[id] ||= { tools: 0, approvals: 0 };
    stats[id].tools += 1;
    if (permission.decision === 'requires_approval') stats[id].approvals += 1;
    return stats;
  }, {});

  useEffect(() => {
    api.getMCPServers()
      .then((serversResult) => {
        setServers(serversResult.servers);
      })
      .catch((error) => {
        console.error('Failed to load MCP servers:', error);
      })
      .finally(() => setServersLoading(false));
  }, []);

  useEffect(() => {
    setPermissionsLoading(true);
    api.getMCPPermissions({ serverId, decision, riskLevel, q: query.trim() })
      .then((permissionsResult) => {
        setPermissions(permissionsResult.permissions);
      })
      .catch((error) => {
        console.error('Failed to load MCP permissions:', error);
      })
      .finally(() => setPermissionsLoading(false));
  }, [serverId, decision, riskLevel, query]);

  return (
    <div className="p-8 space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-foreground">MCP Permissions</h1>
        <p className="text-foreground-secondary mt-2">
          MCP server status and effective tool decisions.
        </p>
      </div>

      {/* MCP Servers */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-foreground">
          Servers
          <span className="ml-2 text-sm font-normal text-foreground-secondary">
            ({servers.length})
          </span>
        </h2>

        {serversLoading ? (
          <div className="bg-background-secondary border border-border rounded-lg p-6 text-foreground-secondary text-sm">
            Loading…
          </div>
        ) : servers.length === 0 ? (
          <div className="bg-background-secondary border border-border rounded-lg p-8 text-center text-foreground-secondary text-sm">
            No MCP servers registered.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {servers.map((server) => {
              const dot = STATUS_DOT[server.status] ?? 'bg-gray-500';
              const label = STATUS_LABEL[server.status] ?? 'text-gray-400';
              return (
                <div
                  key={server.id}
                  className="bg-background-secondary border border-border rounded-lg p-4"
                >
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <PlugZap className="w-4 h-4 text-accent shrink-0" />
                      <span className="text-sm font-semibold text-foreground truncate">
                        {server.name}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className={`w-2 h-2 rounded-full ${dot}`} />
                      <span className={`text-xs font-medium capitalize ${label}`}>
                        {server.status}
                      </span>
                    </div>
                  </div>
                  {server.description && (
                    <p className="text-xs text-foreground-secondary mb-2 line-clamp-2">
                      {server.description}
                    </p>
                  )}
                  {server.url && (
                    <div className="text-xs text-foreground-tertiary truncate">{server.url}</div>
                  )}
                  {server.last_ping_at && (
                    <div className="text-xs text-foreground-tertiary mt-1">
                      Last ping: {new Date(server.last_ping_at).toLocaleTimeString()}
                    </div>
                  )}
                  <div className="text-xs text-foreground-tertiary mt-2">
                    Visible tools: {serverStats[server.id]?.tools || 0}
                    <span className="mx-1">·</span>
                    Approval gates: {serverStats[server.id]?.approvals || 0}
                  </div>
                  {server.error_message && (
                    <div className="mt-2 text-xs text-red-400 truncate">{server.error_message}</div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Tool Permissions */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-foreground">
          Tool Permissions
          <span className="ml-2 text-sm font-normal text-foreground-secondary">
            ({permissions.length})
          </span>
        </h2>
        <div className="flex flex-wrap gap-3">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search tools"
            className="bg-background-secondary border border-border rounded-md px-3 py-2 text-sm text-foreground placeholder:text-foreground-tertiary"
          />
          <select
            value={serverId}
            onChange={(event) => setServerId(event.target.value)}
            className="bg-background-secondary border border-border rounded-md px-3 py-2 text-sm text-foreground"
          >
            <option value="">All servers</option>
            {servers.map((server) => (
              <option key={server.id} value={server.id}>{server.name}</option>
            ))}
          </select>
          <select
            value={decision}
            onChange={(event) => setDecision(event.target.value)}
            className="bg-background-secondary border border-border rounded-md px-3 py-2 text-sm text-foreground"
          >
            <option value="">All decisions</option>
            <option value="allowed">Allowed</option>
            <option value="requires_approval">Requires approval</option>
            <option value="denied">Denied</option>
          </select>
          <select
            value={riskLevel}
            onChange={(event) => setRiskLevel(event.target.value)}
            className="bg-background-secondary border border-border rounded-md px-3 py-2 text-sm text-foreground"
          >
            <option value="">All risk levels</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </select>
        </div>

        {permissionsLoading ? (
          <div className="bg-background-secondary border border-border rounded-lg p-6 text-foreground-secondary text-sm">
            Loading…
          </div>
        ) : permissions.length === 0 ? (
          <div className="bg-background-secondary border border-border rounded-lg p-8 text-center">
            <Circle className="w-8 h-8 text-foreground-tertiary mx-auto mb-2" />
            <p className="text-foreground-secondary text-sm">
              No tool-level permissions configured yet.
            </p>
            <p className="text-foreground-tertiary text-xs mt-1">
              Permissions are set automatically when agents invoke MCP tools.
            </p>
          </div>
        ) : (
          <div className="bg-background-secondary border border-border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-background-elevated text-left text-foreground-secondary">
                <tr>
                  <th className="px-4 py-3">Server</th>
                  <th className="px-4 py-3">Tool</th>
                  <th className="px-4 py-3">Decision</th>
                  <th className="px-4 py-3">Risk</th>
                  <th className="px-4 py-3">Reason</th>
                </tr>
              </thead>
              <tbody>
                {permissions.map((permission) => (
                  <tr key={String(permission.id)} className="border-t border-border">
                    <td className="px-4 py-3 text-foreground-secondary">
                      {String(permission.server_name || permission.server_id || '-')}
                    </td>
                    <td className="px-4 py-3 text-foreground">
                      {String(permission.tool_name || permission.tool_id || 'Unknown')}
                    </td>
                    <td className="px-4 py-3 text-foreground-secondary">
                      {String(permission.decision || '-')}
                    </td>
                    <td className="px-4 py-3 text-foreground-secondary">
                      {String(permission.risk_level || '-')}
                    </td>
                    <td className="px-4 py-3 text-foreground-secondary">
                      {String(permission.reason || '-')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
