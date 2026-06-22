import { BookUser, Users, CheckCircle, XCircle, AlertCircle, RefreshCw } from 'lucide-react';
import { useCatalog } from '../hooks/useCatalog';
import { AgentCatalogTable } from '../components/AgentCatalogTable';

export function AgentCatalogPage() {
  const {
    counts,
    agents,
    loading,
    error,
    filterDivision,
    searchAgents,
    activateAgent,
    deactivateAgent,
    retry,
  } = useCatalog();

  if (loading && agents.length === 0) {
    return (
      <div className="p-8 space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Agent Catalog</h1>
          <p className="text-foreground-secondary mt-2">Browse, search, and manage imported agents</p>
        </div>
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="w-6 h-6 text-foreground-muted animate-spin" />
        </div>
      </div>
    );
  }

  if (error && agents.length === 0) {
    return (
      <div className="p-8 space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Agent Catalog</h1>
          <p className="text-foreground-secondary mt-2">Browse, search, and manage imported agents</p>
        </div>
        <div className="bg-red-50 border border-red-200 rounded-lg p-12 text-center">
          <AlertCircle className="w-8 h-8 text-red-500 mx-auto mb-4" />
          <p className="text-red-700 mb-4">{error}</p>
          <button
            onClick={retry}
            className="inline-flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 text-sm"
          >
            <RefreshCw className="w-4 h-4" /> Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold text-foreground">Agent Catalog</h1>
        <p className="text-foreground-secondary mt-2">Browse, search, and manage imported agents</p>
      </div>

      {/* Summary Counts */}
      {counts && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard
            icon={<BookUser className="w-5 h-5" />}
            label="Imported"
            value={counts.imported}
            color="text-blue-600 bg-blue-50"
          />
          <StatCard
            icon={<Users className="w-5 h-5" />}
            label="Evaluated"
            value={counts.evaluated}
            color="text-purple-600 bg-purple-50"
          />
          <StatCard
            icon={<CheckCircle className="w-5 h-5" />}
            label="Active"
            value={counts.active}
            color="text-green-600 bg-green-50"
          />
          <StatCard
            icon={<XCircle className="w-5 h-5" />}
            label="Rejected"
            value={counts.rejected}
            color="text-red-600 bg-red-50"
          />
        </div>
      )}

      {/* Table */}
      <AgentCatalogTable
        agents={agents}
        onActivate={activateAgent}
        onDeactivate={deactivateAgent}
        onFilterDivision={filterDivision}
        onSearch={searchAgents}
      />
    </div>
  );
}

interface StatCardProps {
  icon: React.ReactNode;
  label: string;
  value: number;
  color: string;
}

function StatCard({ icon, label, value, color }: StatCardProps) {
  return (
    <div className="bg-background border border-border rounded-lg p-4 flex items-center gap-4">
      <div className={`p-2 rounded-lg ${color}`}>
        {icon}
      </div>
      <div>
        <div className="text-2xl font-bold text-foreground">{value}</div>
        <div className="text-sm text-foreground-secondary">{label}</div>
      </div>
    </div>
  );
}
