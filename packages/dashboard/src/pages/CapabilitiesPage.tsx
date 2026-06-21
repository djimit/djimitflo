import { useEffect, useState } from 'react';
import { Plus, Badge } from 'lucide-react';

interface Capability {
  id: string;
  kind: 'skill' | 'specialist' | 'loop_template';
  name: string;
  version: string;
  owner: string;
  status: 'draft' | 'candidate' | 'validated' | 'deprecated' | 'disabled';
  risk_ceiling: 'low' | 'medium' | 'high' | 'critical';
  contract: Record<string, unknown>;
  eval_score?: number;
  eval_evidence_refs?: string[];
  allowed_actions: string[];
  forbidden_actions: string[];
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export function CapabilitiesPage() {
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>('');
  const [filterKind, setFilterKind] = useState<string>('');
  const [promoteLoading, setPromoteLoading] = useState<string | null>(null);

  useEffect(() => {
    fetchCapabilities();
  }, [filterStatus, filterKind]);

  const fetchCapabilities = async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      if (filterStatus) params.append('status', filterStatus);
      if (filterKind) params.append('kind', filterKind);

      const response = await fetch(
        `/api/capabilities?${params.toString()}`,
        {
          credentials: 'include',
        }
      );

      if (!response.ok) {
        throw new Error('Failed to fetch capabilities');
      }

      const data = await response.json() as { capabilities: Capability[] };
      setCapabilities(data.capabilities);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  const handlePromote = async (capId: string, toStatus: 'candidate' | 'validated') => {
    try {
      setPromoteLoading(capId);
      const response = await fetch(
        `/api/capabilities/${capId}/promote`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ to_status: toStatus }),
        }
      );

      if (!response.ok) {
        const errData = await response.json() as { error: string };
        throw new Error(errData.error || 'Promotion failed');
      }

      await fetchCapabilities();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Promotion failed');
    } finally {
      setPromoteLoading(null);
    }
  };

  const getStatusColor = (status: string): string => {
    switch (status) {
      case 'draft':
        return 'bg-gray-100 text-gray-700';
      case 'candidate':
        return 'bg-yellow-100 text-yellow-700';
      case 'validated':
        return 'bg-green-100 text-green-700';
      case 'deprecated':
        return 'bg-orange-100 text-orange-700';
      case 'disabled':
        return 'bg-red-100 text-red-700';
      default:
        return 'bg-gray-100 text-gray-700';
    }
  };

  const getRiskColor = (risk: string): string => {
    switch (risk) {
      case 'low':
        return 'text-green-600';
      case 'medium':
        return 'text-yellow-600';
      case 'high':
        return 'text-orange-600';
      case 'critical':
        return 'text-red-600';
      default:
        return 'text-gray-600';
    }
  };

  const canPromoteToCandidate = (cap: Capability): boolean => {
    return cap.status === 'draft';
  };

  const canPromoteToValidated = (cap: Capability): boolean => {
    return cap.status === 'candidate' && (cap.eval_score || 0) >= 80;
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-4xl font-bold text-slate-900">Capabilities</h1>
            <p className="text-slate-600 mt-2">Manage worker capabilities and routing gates</p>
          </div>
          <button className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition">
            <Plus size={20} />
            New Capability
          </button>
        </div>

        {/* Error Alert */}
        {error && (
          <div className="mb-6 bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
            {error}
          </div>
        )}

        {/* Filters */}
        <div className="mb-6 flex gap-4">
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="px-4 py-2 border border-slate-300 rounded-lg bg-white text-slate-900 hover:border-slate-400 transition"
          >
            <option value="">All Statuses</option>
            <option value="draft">Draft</option>
            <option value="candidate">Candidate</option>
            <option value="validated">Validated</option>
            <option value="deprecated">Deprecated</option>
            <option value="disabled">Disabled</option>
          </select>

          <select
            value={filterKind}
            onChange={(e) => setFilterKind(e.target.value)}
            className="px-4 py-2 border border-slate-300 rounded-lg bg-white text-slate-900 hover:border-slate-400 transition"
          >
            <option value="">All Kinds</option>
            <option value="skill">Skill</option>
            <option value="specialist">Specialist</option>
            <option value="loop_template">Loop Template</option>
          </select>
        </div>

        {/* Loading State */}
        {loading && (
          <div className="flex justify-center items-center py-12">
            <div className="text-slate-600">Loading capabilities...</div>
          </div>
        )}

        {/* Capabilities Table */}
        {!loading && capabilities.length > 0 && (
          <div className="bg-white rounded-lg shadow-sm border border-slate-200 overflow-hidden">
            <table className="w-full">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-slate-900">Name</th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-slate-900">Kind</th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-slate-900">Version</th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-slate-900">Status</th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-slate-900">Eval Score</th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-slate-900">Risk</th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-slate-900">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {capabilities.map((cap) => (
                  <tr key={cap.id} className="hover:bg-slate-50 transition">
                    <td className="px-6 py-4 text-sm font-medium text-slate-900">{cap.name}</td>
                    <td className="px-6 py-4 text-sm text-slate-600 capitalize">{cap.kind.replace('_', ' ')}</td>
                    <td className="px-6 py-4 text-sm text-slate-600">{cap.version}</td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex px-3 py-1 rounded-full text-xs font-semibold ${getStatusColor(cap.status)}`}>
                        {cap.status}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-sm text-slate-600">
                      {cap.eval_score !== undefined ? (
                        <div className="flex items-center gap-2">
                          <div className="w-16 bg-slate-200 rounded-full h-2">
                            <div
                              className={`h-2 rounded-full transition ${
                                cap.eval_score >= 80 ? 'bg-green-500' : 'bg-yellow-500'
                              }`}
                              style={{ width: `${Math.min(cap.eval_score, 100)}%` }}
                            />
                          </div>
                          <span>{cap.eval_score}</span>
                        </div>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      <Badge className={`${getRiskColor(cap.risk_ceiling)} font-semibold`}>
                        {cap.risk_ceiling}
                      </Badge>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex gap-2">
                        {canPromoteToCandidate(cap) && (
                          <button
                            onClick={() => handlePromote(cap.id, 'candidate')}
                            disabled={promoteLoading === cap.id}
                            className="px-3 py-1 bg-blue-100 text-blue-700 rounded text-xs font-semibold hover:bg-blue-200 disabled:opacity-50 disabled:cursor-not-allowed transition"
                          >
                            {promoteLoading === cap.id ? 'Promoting...' : 'Promote'}
                          </button>
                        )}
                        {canPromoteToValidated(cap) && (
                          <button
                            onClick={() => handlePromote(cap.id, 'validated')}
                            disabled={promoteLoading === cap.id}
                            className="px-3 py-1 bg-green-100 text-green-700 rounded text-xs font-semibold hover:bg-green-200 disabled:opacity-50 disabled:cursor-not-allowed transition"
                          >
                            {promoteLoading === cap.id ? 'Validating...' : 'Validate'}
                          </button>
                        )}
                        {!canPromoteToCandidate(cap) && !canPromoteToValidated(cap) && (
                          <span className="text-xs text-slate-500">No actions</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Empty State */}
        {!loading && capabilities.length === 0 && (
          <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-12 text-center">
            <Badge className="mb-4 mx-auto" size={32} />
            <h3 className="text-lg font-semibold text-slate-900 mb-2">No capabilities found</h3>
            <p className="text-slate-600 mb-4">Create your first capability to get started</p>
            <button className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition mx-auto">
              <Plus size={20} />
              New Capability
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
