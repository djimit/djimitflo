import { useState, useEffect, useCallback } from 'react';
import { api, type CatalogCounts, type CatalogAgent } from '../lib/api';

interface UseCatalogState {
  counts: CatalogCounts | null;
  agents: CatalogAgent[];
  loading: boolean;
  error: string | null;
}

interface UseCatalogReturn extends UseCatalogState {
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
  });
  const [divisionFilter, setDivisionFilter] = useState<string | undefined>(undefined);
  const [searchQuery, setSearchQuery] = useState<string>('');

  const fetchAgents = useCallback(async (division?: string, q?: string) => {
    setState(prev => ({ ...prev, loading: true, error: null }));
    try {
      const [countsRes, agentsRes] = await Promise.all([
        api.getCatalogCounts(),
        q
          ? api.searchCatalogAgents(q)
          : api.getCatalogAgents({ division }),
      ]);
      setState({
        counts: countsRes,
        agents: agentsRes.agents,
        loading: false,
        error: null,
      });
    } catch (e) {
      setState(prev => ({
        ...prev,
        loading: false,
        error: e instanceof Error ? e.message : 'Failed to load catalog',
      }));
    }
  }, []);

  useEffect(() => {
    fetchAgents(divisionFilter, searchQuery);
  }, [divisionFilter, searchQuery, fetchAgents]);

  const filterDivision = useCallback((division: string | undefined) => {
    setSearchQuery('');
    setDivisionFilter(division);
  }, []);

  const searchAgents = useCallback((q: string) => {
    setDivisionFilter(undefined);
    setSearchQuery(q);
  }, []);

  const activateAgent = useCallback(async (id: string, target?: string) => {
    await api.activateCatalogAgent(id, target);
    await fetchAgents(divisionFilter, searchQuery);
  }, [fetchAgents, divisionFilter, searchQuery]);

  const deactivateAgent = useCallback(async (id: string) => {
    await api.deactivateCatalogAgent(id);
    await fetchAgents(divisionFilter, searchQuery);
  }, [fetchAgents, divisionFilter, searchQuery]);

  const retry = useCallback(() => {
    fetchAgents(divisionFilter, searchQuery);
  }, [fetchAgents, divisionFilter, searchQuery]);

  return {
    ...state,
    filterDivision,
    searchAgents,
    activateAgent,
    deactivateAgent,
    retry,
  };
}
