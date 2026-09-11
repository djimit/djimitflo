import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useCatalog } from './useCatalog';
import { api } from '../lib/api';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('omits absent division through the actual API client on initial load and search clear', async () => {
  const agent = { id: 'fixture', name: 'Secure Coder', division: 'engineering', status: 'evaluated' };
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    requests.push(input);
    const url = new URL(input, 'http://local.test');
    const body = url.pathname.endsWith('/counts')
      ? { imported: 1, evaluated: 1, active: 0, duplicate: 0, rejected: 0 }
      : { agents: url.searchParams.has('division') ? [] : [agent] };
    return { ok: true, status: 200, json: async () => body };
  }));
  const { result } = renderHook(() => useCatalog());
  await waitFor(() => expect(result.current.agents).toEqual([agent]));
  expect(requests).toContain('/api/catalog/agents');
  act(() => result.current.searchAgents('Secure'));
  await waitFor(() => expect(requests).toContain('/api/catalog/search?q=Secure'));
  act(() => result.current.searchAgents(''));
  await waitFor(() => expect(requests.filter(url => url === '/api/catalog/agents')).toHaveLength(2));
  expect(requests.some(url => url.includes('division=undefined'))).toBe(false);
});

it('serializes only defined nonempty catalog filters at the shared client boundary', async () => {
  const fetch = vi.fn(async (_input: string) => ({ ok: true, status: 200, json: async () => ({ agents: [] }) }));
  vi.stubGlobal('fetch', fetch);
  await api.getCatalogAgents({ division: undefined, status: '' });
  expect(fetch.mock.calls[0][0]).toBe('/api/catalog/agents');
  await api.getCatalogAgents({ division: 'engineering', status: 'evaluated' });
  expect(fetch.mock.calls[1][0]).toBe('/api/catalog/agents?division=engineering&status=evaluated');
});
