import { BookUser, Users, CheckCircle, XCircle, RefreshCw } from 'lucide-react';
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
    divisions,
    divisionFilter,
    searchQuery,
  } = useCatalog();

  return (
    <div className="p-8 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold text-foreground">Agent Catalog</h1>
        <p className="text-foreground-secondary mt-2">Browse, search, and manage imported agents</p>
        <p className="text-foreground-secondary mt-2">Preparing an artifact compiles agent configuration and records catalog activation. It does not register a runtime agent, start a provider, or dispatch work.</p>
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
            label="Artifacts prepared"
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

      {loading && <p role="status" className="text-foreground-secondary">Loading catalog…</p>}
      {error && <div role="alert" className="border border-red-200 rounded-lg p-4 text-red-700">
        <p>{error}</p>
        {agents.length > 0 && <p>Showing previously loaded rows; the current filter could not be refreshed.</p>}
        <button onClick={retry} className="inline-flex items-center gap-2 mt-2"><RefreshCw className="w-4 h-4" /> Retry</button>
      </div>}

      {/* Table */}
      <AgentCatalogTable
        agents={agents}
        divisions={divisions}
        divisionFilter={divisionFilter}
        searchQuery={searchQuery}
        emptyMessage={loading ? 'Waiting for catalog data.' : error ? 'Catalog data unavailable.' : undefined}
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
