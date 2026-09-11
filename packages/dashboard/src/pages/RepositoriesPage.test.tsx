import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RepositoriesPage } from './RepositoriesPage';
import { RepositoryDetailPage } from './RepositoryDetailPage';
import { useAuthStore } from '../lib/auth-store';

const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const repo = { id: 'fixture', name: 'Repository fixture', path: '/tmp/fixture', status: 'clean', detected_stacks: [] };
beforeEach(() => useAuthStore.setState({ user: { id: 'admin', role: 'admin' } as any }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); useAuthStore.setState({ user: null }); });
const detail = () => render(<MemoryRouter initialEntries={['/repositories/fixture']}><Routes><Route path="/repositories/:id" element={<RepositoryDetailPage />} /></Routes></MemoryRouter>);

it('reports list failure and retries instead of claiming no repositories exist', async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new Error('List unavailable')).mockResolvedValue(response({repositories:[repo]}));
  vi.stubGlobal('fetch', fetch);
  render(<MemoryRouter><RepositoriesPage /></MemoryRouter>);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'List unavailable Retry repository list');
  expect(screen.queryByText(/No repositories registered/)).toBeNull();
  fireEvent.click(screen.getByText('Retry repository list'));
  expect(await screen.findByText('Repository fixture')).toBeTruthy();
});

it('does not invent an absolute server path and displays scan failure', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') throw new Error('Path not allowed');
    return response({repositories:[]});
  }));
  render(<MemoryRouter><RepositoriesPage /></MemoryRouter>);
  const input = screen.getByLabelText('Repository path on the server');
  expect(input).toHaveProperty('value', '');
  expect(screen.getByRole('button', {name:'Scan'})).toHaveProperty('disabled', true);
  fireEvent.change(input, {target:{value:'/tmp/fixture'}});
  fireEvent.click(screen.getByRole('button', {name:'Scan'}));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Path not allowed Retry repository list');
});

it('retains repository identity but never renders missing health/instructions as clean or absent', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url:string) => {
    if (url === '/api/repositories/fixture') return response({repository:repo});
    throw new Error('Dependency unavailable');
  }));
  detail();
  expect(await screen.findByText('Repository fixture')).toBeTruthy();
  expect(screen.getAllByRole('alert')).toHaveLength(2);
  expect(screen.queryByText('No health findings.')).toBeNull();
  expect(screen.queryByText(/No AGENTS.md found/)).toBeNull();
});

it('does not request protected detail endpoints for a viewer', async () => {
  useAuthStore.setState({ user: {id:'viewer',role:'viewer'} as any });
  const fetch = vi.fn().mockResolvedValue(response({repository:repo})); vi.stubGlobal('fetch', fetch);
  detail();
  await screen.findByText('Repository fixture');
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(screen.getAllByRole('alert').every(e => e.textContent?.includes('permission'))).toBe(true);
});
