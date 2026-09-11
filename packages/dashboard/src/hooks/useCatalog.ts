import { useState, useEffect, useCallback, useRef } from 'react';
import { api, type CatalogCounts, type CatalogAgent } from '../lib/api';

interface UseCatalogState {
  counts: CatalogCounts | null;
  agents: CatalogAgent[];
  loading: boolean;
  error: string | null;
  divisions: string[];
}

interface UseCatalogReturn extends UseCatalogState {
  divisionFilter: string | undefined;
  searchQuery: string;
  filterDivision: (division: string | undefined) => void;
  searchAgents: (q: string) => void;
  activateAgent: (id: string, target?: string) => Promise<void>;
  deactivateAgent: (id: string) => Promise<void>;
  retry: () => void;
}

export function useCatalog(): UseCatalogReturn {
  const [state, setState] = useState<UseCatalogState>({
    counts: null,
    agents: [],
    loading: true,
    error: null,
    divisions: [],
  });
  const [divisionFilter, setDivisionFilter] = useState<string | undefined>(undefined);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const requestId = useRef(0);
  const filters = useRef({ division: divisionFilter, q: searchQuery });

  const fetchAgents = useCallback(async (division?: string, q?: string) => {
    const currentRequest = ++requestId.current;
    setState(prev => ({ ...prev, loading: true, error: null }));
    try {
      const [countsRes, agentsRes] = await Promise.all([
        api.getCatalogCounts(),
        q
          ? api.searchCatalogAgents(q)
          : api.getCatalogAgents(division ? { division } : undefined),
      ]);
      if (currentRequest !== requestId.current) return;
      setState(prev => ({
        counts: countsRes,
        agents: agentsRes.agents,
        loading: false,
        error: null,
        divisions: !division && !q ? [...new Set(agentsRes.agents.map(agent => agent.division))].sort() : prev.divisions,
      }));
    } catch (e) {
      if (currentRequest !== requestId.current) return;
      setState(prev => ({
        ...prev,
        loading: false,
        error: e instanceof Error ? e.message : 'Failed to load catalog',
      }));
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => { void fetchAgents(divisionFilter, searchQuery); }, searchQuery ? 300 : 0);
    return () => { clearTimeout(timer); requestId.current += 1; };
  }, [divisionFilter, searchQuery, fetchAgents]);

  const filterDivision = useCallback((division: string | undefined) => {
    requestId.current += 1;
    filters.current = { division, q: '' };
    setSearchQuery('');
    setDivisionFilter(division);
  }, []);

  const searchAgents = useCallback((q: string) => {
    requestId.current += 1;
    filters.current = { division: undefined, q };
    setDivisionFilter(undefined);
    setSearchQuery(q);
  }, []);

  const activateAgent = useCallback(async (id: string, target?: string) => {
    await api.activateCatalogAgent(id, target);
    await fetchAgents(filters.current.division, filters.current.q);
  }, [fetchAgents]);

  const deactivateAgent = useCallback(async (id: string) => {
    await api.deactivateCatalogAgent(id);
    await fetchAgents(filters.current.division, filters.current.q);
  }, [fetchAgents]);

  const retry = useCallback(() => {
    fetchAgents(divisionFilter, searchQuery);
  }, [fetchAgents, divisionFilter, searchQuery]);

  return {
    ...state,
    divisionFilter,
    searchQuery,
    filterDivision,
    searchAgents,
    activateAgent,
    deactivateAgent,
    retry,
  };
}
