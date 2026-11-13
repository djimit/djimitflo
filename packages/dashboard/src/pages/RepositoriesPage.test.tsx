import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RepositoriesPage, repoTitle } from './RepositoriesPage';
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
  expect(screen.queryByLabelText('Repository path on the server')).toBeNull(); // the free-path form sits behind "Add repository"
  fireEvent.click(screen.getByRole('button', {name:'Add repository'}));
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

it('truth audit 2026-11-12: missing paths are marked and hidden by default, SHA-named checkouts get a repo title, old scans are greyed', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-12T12:00:00Z'));
  const sha = '08c1aac9b37d398d7431be23802ced8813537169';
  const base = { status: 'clean', detected_stacks: [], package_manager: 'npm', git_remote: null };
  vi.stubGlobal('fetch', vi.fn(async () => response({repositories:[
    { ...base, id: 'real', name: 'djimitflo', path: '/workspace/djimitflo', path_exists: true, health_score: 100, last_synced_at: '2026-09-30T13:25:56Z' },
    { ...base, id: 'cache', name: sha, path: `/tmp/djimitflo-explainer-cache/repos/djimit/uitspraken/${sha}`, path_exists: false, health_score: 90, last_synced_at: '2026-11-10T12:00:00Z' },
  ]})));
  try {
    render(<MemoryRouter><RepositoriesPage /></MemoryRouter>);
    expect(await screen.findByText('djimitflo')).toBeTruthy();
    expect(screen.getByText(/scanned 42 d ago/)).toBeTruthy();
    expect(screen.getByText('Health: 100/100').getAttribute('title')).toMatch(/older than 14 days/);
    expect(screen.queryByText(/uitspraken/)).toBeNull();
    fireEvent.click(screen.getByRole('button', {name:'Show 1 repository whose path is missing'}));
    expect(screen.getByText('djimit/uitspraken @ 08c1aac')).toBeTruthy();
    expect(screen.getByText('path missing')).toBeTruthy();
    expect(screen.getByText('Health: 90/100').getAttribute('title')).toBeNull(); // scanned 2 d ago: current
  } finally { vi.useRealTimers(); }
});

it('derives a repository title from the remote or the checkout path when the name is a commit SHA', () => {
  const sha = 'cdeed396db828c15d11d4d2c3ca165287f9e0504';
  expect(repoTitle({ name: 'djimitflo', path: '/workspace/djimitflo', git_remote: null })).toBe('djimitflo');
  expect(repoTitle({ name: sha, path: `/tmp/djimitflo-explainer-cache/repos/djimit/openmythos-benchmark/${sha}`, git_remote: null })).toBe('djimit/openmythos-benchmark @ cdeed39');
  expect(repoTitle({ name: sha, path: null, git_remote: 'git@github.com:djimit/djimitflo.git' })).toBe('djimit/djimitflo @ cdeed39');
  expect(repoTitle({ name: sha, path: null, git_remote: null })).toBe(sha);
});
