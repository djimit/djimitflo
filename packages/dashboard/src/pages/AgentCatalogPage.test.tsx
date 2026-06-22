import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AgentCatalogPage } from './AgentCatalogPage';

// Mock the API
vi.mock('../lib/api', () => ({
  api: {
    getCatalogCounts: vi.fn(),
    getCatalogAgents: vi.fn(),
    searchCatalogAgents: vi.fn(),
    activateCatalogAgent: vi.fn(),
    deactivateCatalogAgent: vi.fn(),
  },
}));

// Mock the auth store
vi.mock('../lib/auth-store', () => ({
  useAuthStore: vi.fn(() => ({
    hasPermission: (perm: string) => perm === 'manage:config',
    user: { role: 'admin' },
    token: 'fake-token',
    isAuthenticated: true,
    isLoading: false,
    error: null,
    login: vi.fn(),
    logout: vi.fn(),
    restoreSession: vi.fn(),
  })),
}));

import { api } from '../lib/api';

const mockCounts = { imported: 10, evaluated: 7, active: 5, duplicate: 1, rejected: 2 };
const mockAgents = [
  { id: '1', name: 'Agent Alpha', division: 'research', status: 'active', evaluation: { score: 85, verdict: 'pass' }, activation: { target: 'openclaw', active: true } },
  { id: '2', name: 'Agent Beta', division: 'ops', status: 'imported', evaluation: null, activation: { active: false } },
  { id: '3', name: 'Agent Gamma', division: 'research', status: 'evaluated', evaluation: { score: 92, verdict: 'pass' }, activation: { active: false } },
];

function renderPage() {
  return render(
    <MemoryRouter>
      <AgentCatalogPage />
    </MemoryRouter>
  );
}

describe('AgentCatalogPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getCatalogCounts).mockResolvedValue(mockCounts);
    vi.mocked(api.getCatalogAgents).mockResolvedValue({ agents: mockAgents });
  });

  it('renders page title and description', async () => {
    renderPage();
    expect(screen.getByText('Agent Catalog')).toBeTruthy();
    expect(screen.getByText('Browse, search, and manage imported agents')).toBeTruthy();
  });

  it('displays summary counts', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('10')).toBeTruthy();
      expect(screen.getByText('7')).toBeTruthy();
      expect(screen.getByText('5')).toBeTruthy();
      expect(screen.getByText('2')).toBeTruthy();
    });
  });

  it('displays agent table with correct columns', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Agent Alpha')).toBeTruthy();
      expect(screen.getByText('Agent Beta')).toBeTruthy();
      expect(screen.getByText('Agent Gamma')).toBeTruthy();
    });
    expect(screen.getByText('Name')).toBeTruthy();
    expect(screen.getByText('Division')).toBeTruthy();
    expect(screen.getByText('Status')).toBeTruthy();
    expect(screen.getByText('Evaluation')).toBeTruthy();
  });

  it('shows Not evaluated for agents without evaluation', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Not evaluated')).toBeTruthy();
    });
  });

  it('shows empty state when no agents', async () => {
    vi.mocked(api.getCatalogAgents).mockResolvedValue({ agents: [] });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('No agents imported yet.')).toBeTruthy();
    });
  });

  it('shows error state with retry button on API failure', async () => {
    vi.mocked(api.getCatalogCounts).mockRejectedValue(new Error('Network error'));
    vi.mocked(api.getCatalogAgents).mockRejectedValue(new Error('Network error'));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeTruthy();
      expect(screen.getByText('Retry')).toBeTruthy();
    });
  });

  it('shows activate/deactivate buttons for admin', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Deactivate')).toBeTruthy();
      expect(screen.getAllByText('Activate')[0]).toBeTruthy();
    });
  });

  it('calls activate API when Activate button is clicked', async () => {
    vi.mocked(api.activateCatalogAgent).mockResolvedValue({ target: 'openclaw', active: true });
    renderPage();
    await waitFor(() => {
      expect(screen.getAllByText('Activate')[0]).toBeTruthy();
    });
    fireEvent.click(screen.getAllByText('Activate')[0]);
    await waitFor(() => {
      expect(api.activateCatalogAgent).toHaveBeenCalled();
    });
  });

  it('calls deactivate API when Deactivate button is clicked', async () => {
    vi.mocked(api.deactivateCatalogAgent).mockResolvedValue({ active: false });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Deactivate')).toBeTruthy();
    });
    fireEvent.click(screen.getAllByText('Deactivate')[0]);
    await waitFor(() => {
      expect(api.deactivateCatalogAgent).toHaveBeenCalled();
    });
  });

  it('filters by division', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Agent Alpha')).toBeTruthy();
    });
    const select = screen.getByDisplayValue('All divisions');
    fireEvent.change(select, { target: { value: 'research' } });
    await waitFor(() => {
      expect(api.getCatalogAgents).toHaveBeenCalledWith({ division: 'research' });
    });
  });

  it('searches agents', async () => {
    vi.mocked(api.searchCatalogAgents).mockResolvedValue({ agents: [mockAgents[0]] });
    renderPage();
    await waitFor(() => {
      expect(screen.getByPlaceholderText('Search agents...')).toBeTruthy();
    });
    const input = screen.getByPlaceholderText('Search agents...');
    fireEvent.change(input, { target: { value: 'Alpha' } });
    await waitFor(() => {
      expect(api.searchCatalogAgents).toHaveBeenCalledWith('Alpha');
    }, { timeout: 1000 });
  });
});
