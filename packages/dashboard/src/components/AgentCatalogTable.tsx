import { useRef, useState } from 'react';
import { Search, Filter, Power, PowerOff } from 'lucide-react';
import { useAuthStore } from '../lib/auth-store';
import type { CatalogAgent } from '../lib/api';

interface AgentCatalogTableProps {
  agents: CatalogAgent[];
  divisions: string[];
  divisionFilter: string | undefined;
  searchQuery: string;
  emptyMessage?: string;
  onActivate: (id: string, target?: string) => Promise<void>;
  onDeactivate: (id: string) => Promise<void>;
  onFilterDivision: (division: string | undefined) => void;
  onSearch: (q: string) => void;
}

const STATUS_COLORS: Record<string, string> = {
  imported: 'bg-blue-100 text-blue-800',
  evaluated: 'bg-purple-100 text-purple-800',
  active: 'bg-green-100 text-green-800',
  inactive: 'bg-gray-100 text-gray-800',
  rejected: 'bg-red-100 text-red-800',
  duplicate: 'bg-yellow-100 text-yellow-800',
};

export function AgentCatalogTable({
  agents,
  divisions,
  divisionFilter,
  searchQuery,
  emptyMessage,
  onActivate,
  onDeactivate,
  onFilterDivision,
  onSearch,
}: AgentCatalogTableProps) {
  const { hasPermission } = useAuthStore();
  const canManage = hasPermission('manage:config');
  const [target, setTarget] = useState('openclaw');
  const [pending, setPending] = useState<string[]>([]);
  const pendingIds = useRef(new Set<string>());
  const [actionError, setActionError] = useState<string | null>(null);

  const handleDivisionChange = (value: string) => {
    onFilterDivision(value || undefined);
  };

  const handleAction = async (id: string, activate: boolean) => {
    if (pendingIds.current.has(id)) return;
    pendingIds.current.add(id);
    setPending([...pendingIds.current]);
    try {
      setActionError(null);
      if (activate) await onActivate(id, target);
      else await onDeactivate(id);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Artifact update failed');
    } finally {
      pendingIds.current.delete(id);
      setPending([...pendingIds.current]);
    }
  };

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap gap-4 items-center">
        <div className="relative w-full min-w-0 sm:flex-1 sm:max-w-xs">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-foreground-muted" />
          <input
            type="text"
            placeholder="Search agents..."
            aria-label="Search agents"
            value={searchQuery}
            onChange={(e) => onSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-border rounded-lg bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-foreground-muted" />
          <select
            aria-label="Division"
            value={divisionFilter || ''}
            onChange={(e) => handleDivisionChange(e.target.value)}
            className="px-3 py-2 border border-border rounded-lg bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          >
            <option value="">All divisions</option>
            {divisions.map(d => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        </div>
        {canManage && <label className="flex items-center gap-2 text-sm">
          Artifact target
          <select aria-label="Artifact target" value={target} onChange={event => setTarget(event.target.value)} className="px-3 py-2 border border-border rounded-lg bg-background text-foreground">
            <option value="openclaw">OpenClaw</option>
            <option value="codex">Codex</option>
          </select>
        </label>}
      </div>
      {searchQuery && <p className="text-sm text-foreground-secondary">Search shows up to 20 ranked matches.</p>}

      {actionError && (
        <div role="alert" className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded-lg text-sm">
          {actionError}
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto border border-border rounded-lg">
        <table className="w-full text-sm">
          <thead className="bg-background-secondary">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-foreground-secondary">Name</th>
              <th className="text-left px-4 py-3 font-medium text-foreground-secondary">Division</th>
              <th className="text-left px-4 py-3 font-medium text-foreground-secondary">Status</th>
              <th className="text-left px-4 py-3 font-medium text-foreground-secondary">Evaluation</th>
              {canManage && <th className="text-right px-4 py-3 font-medium text-foreground-secondary">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {agents.length === 0 ? (
              <tr>
                <td colSpan={canManage ? 5 : 4} className="px-4 py-12 text-center text-foreground-muted">
                  {emptyMessage || (searchQuery || divisionFilter ? 'No agents match the current filter.' : 'No agents imported yet.')}
                </td>
              </tr>
            ) : (
              agents.map((agent) => (
                <tr key={agent.id} className="hover:bg-background-secondary/50">
                  <td className="px-4 py-3 text-foreground">{agent.name}</td>
                  <td className="px-4 py-3 text-foreground-secondary">{agent.division}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[agent.status] || 'bg-gray-100 text-gray-800'}`}>
                      {agent.status === 'active' ? 'artifact prepared' : agent.status}
                    </span>
                    {agent.activation?.active && <span className="block text-xs text-foreground-secondary mt-1">Target: {agent.activation.target || 'unknown'}</span>}
                  </td>
                  <td className="px-4 py-3 text-foreground-secondary">
                    {agent.evaluation?.score != null
                      ? `${agent.evaluation.score} (${agent.evaluation.verdict || '—'})`
                      : agent.evaluation?.verdict ? `${agent.evaluation.verdict} — score unavailable` : 'Not evaluated'}
                  </td>
                  {canManage && (
                    <td className="px-4 py-3 text-right">
                      {agent.activation?.active ? (
                        <button
                          disabled={pending.includes(agent.id)}
                          onClick={() => void handleAction(agent.id, false)}
                          className="inline-flex items-center gap-1 px-2 py-1 text-xs text-red-600 hover:bg-red-50 rounded"
                        >
                          <PowerOff className="w-3 h-3" /> {pending.includes(agent.id) ? 'Updating artifact…' : 'Deactivate artifact'}
                        </button>
                      ) : (
                        <button
                          disabled={pending.includes(agent.id) || agent.evaluation?.verdict !== 'passed'}
                          title={agent.evaluation?.verdict !== 'passed' ? 'A current passed evaluation is required before artifact preparation.' : undefined}
                          onClick={() => void handleAction(agent.id, true)}
                          className="inline-flex items-center gap-1 px-2 py-1 text-xs text-green-600 hover:bg-green-50 rounded"
                        >
                          <Power className="w-3 h-3" /> {pending.includes(agent.id) ? 'Preparing artifact…' : 'Prepare artifact'}
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
