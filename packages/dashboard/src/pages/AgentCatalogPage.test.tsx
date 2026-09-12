import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
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
  { id: '1', name: 'Agent Alpha', division: 'research', status: 'active', evaluation: { score: 85, verdict: 'passed' }, activation: { target: 'openclaw', active: true } },
  { id: '2', name: 'Agent Beta', division: 'ops', status: 'imported', evaluation: null, activation: { active: false } },
  { id: '3', name: 'Agent Gamma', division: 'research', status: 'evaluated', evaluation: { score: 92, verdict: 'passed' }, activation: { active: false } },
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
    vi.resetAllMocks();
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
      expect(screen.getByText('Deactivate artifact')).toBeTruthy();
      expect(screen.getAllByText('Prepare artifact')[0]).toBeTruthy();
    });
  });

  it('calls activate API when Activate button is clicked', async () => {
    vi.mocked(api.activateCatalogAgent).mockResolvedValue({ target: 'openclaw', active: true });
    renderPage();
    await waitFor(() => {
      expect(screen.getAllByText('Prepare artifact')[0]).toBeTruthy();
    });
    fireEvent.click(screen.getAllByText('Prepare artifact')[1]);
    await waitFor(() => {
      expect(api.activateCatalogAgent).toHaveBeenCalled();
    });
  });

  it('calls deactivate API when Deactivate button is clicked', async () => {
    vi.mocked(api.deactivateCatalogAgent).mockResolvedValue({ active: false });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Deactivate artifact')).toBeTruthy();
    });
    fireEvent.click(screen.getAllByText('Deactivate artifact')[0]);
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

  it('clears search and retains all division options through filtered results', async () => {
    vi.mocked(api.searchCatalogAgents).mockResolvedValue({ agents: [mockAgents[0]] });
    renderPage();
    await screen.findByText('Agent Beta');
    fireEvent.change(screen.getByLabelText('Search agents'), { target: { value: 'Alpha' } });
    await waitFor(() => expect(screen.queryByText('Agent Beta')).toBeNull());
    expect(screen.getByRole('option', { name: 'ops' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search agents'), { target: { value: '' } });
    await screen.findByText('Agent Beta');
    expect(api.getCatalogAgents).toHaveBeenLastCalledWith(undefined);
  });

  it('keeps division selection and search mutually consistent even for empty results', async () => {
    vi.mocked(api.searchCatalogAgents).mockResolvedValue({ agents: [] });
    renderPage();
    await screen.findByText('Agent Alpha');
    fireEvent.change(screen.getByLabelText('Search agents'), { target: { value: 'none' } });
    await screen.findByText('No agents match the current filter.');
    fireEvent.change(screen.getByLabelText('Division'), { target: { value: 'ops' } });
    await waitFor(() => expect(api.getCatalogAgents).toHaveBeenLastCalledWith({ division: 'ops' }));
    expect((screen.getByLabelText('Search agents') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Division') as HTMLSelectElement).value).toBe('ops');
  });

  it('ignores a late search response after the division changes', async () => {
    let resolveSearch!: (value: { agents: typeof mockAgents }) => void;
    vi.mocked(api.searchCatalogAgents).mockImplementation(() => new Promise(resolve => { resolveSearch = resolve; }));
    vi.mocked(api.getCatalogAgents).mockImplementation(async params => ({ agents: params?.division ? [mockAgents[1]] : mockAgents }));
    renderPage();
    await screen.findByText('Agent Alpha');
    fireEvent.change(screen.getByLabelText('Search agents'), { target: { value: 'Alpha' } });
    await waitFor(() => expect(resolveSearch).toBeTypeOf('function'));
    fireEvent.change(screen.getByLabelText('Division'), { target: { value: 'ops' } });
    await waitFor(() => expect(screen.queryByText('Agent Alpha')).toBeNull());
    await act(async () => resolveSearch({ agents: [mockAgents[0]] }));
    expect(screen.getByText('Agent Beta')).toBeTruthy();
    expect(screen.queryByText('Agent Alpha')).toBeNull();
  });

  it('shows a refresh failure with existing rows and recovers through Retry', async () => {
    vi.mocked(api.searchCatalogAgents).mockRejectedValueOnce(new Error('Catalog offline')).mockResolvedValueOnce({ agents: [mockAgents[0]] });
    renderPage();
    await screen.findByText('Agent Beta');
    fireEvent.change(screen.getByLabelText('Search agents'), { target: { value: 'Alpha' } });
    expect((await screen.findByRole('alert')).textContent).toContain('Catalog offline');
    expect(screen.getByText('Agent Beta')).toBeTruthy();
    fireEvent.click(screen.getByText('Retry'));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.queryByText('Agent Beta')).toBeNull();
  });

  it('prepares the selected artifact target only once while pending and exposes failure', async () => {
    let rejectActivation!: (error: Error) => void;
    vi.mocked(api.activateCatalogAgent).mockImplementation(() => new Promise((_resolve, reject) => { rejectActivation = reject; }));
    renderPage();
    await screen.findByText('Agent Beta');
    fireEvent.change(screen.getByLabelText('Artifact target'), { target: { value: 'codex' } });
    const button = screen.getAllByText('Prepare artifact')[1] as HTMLButtonElement;
    fireEvent.click(button);
    fireEvent.click(button);
    expect(api.activateCatalogAgent).toHaveBeenCalledTimes(1);
    expect(api.activateCatalogAgent).toHaveBeenCalledWith('3', 'codex');
    expect(button.disabled).toBe(true);
    await act(async () => rejectActivation(new Error('Artifact write failed')));
    expect(screen.getByRole('alert').textContent).toContain('Artifact write failed');
    expect(button.disabled).toBe(false);
    expect(screen.getByText(/does not register a runtime agent/)).toBeTruthy();
  });

  it('refreshes the current division after an earlier activation finishes', async () => {
    let resolveActivation!: (value: { target: string; active: boolean }) => void;
    vi.mocked(api.activateCatalogAgent).mockImplementation(() => new Promise(resolve => { resolveActivation = resolve; }));
    vi.mocked(api.getCatalogAgents).mockImplementation(async params => ({ agents: params?.division ? [mockAgents[0]] : mockAgents }));
    renderPage();
    await screen.findByText('Agent Beta');
    fireEvent.click(screen.getAllByText('Prepare artifact')[1]);
    fireEvent.change(screen.getByLabelText('Division'), { target: { value: 'research' } });
    await waitFor(() => expect(screen.queryByText('Agent Beta')).toBeNull());
    await act(async () => resolveActivation({ active: true, target: 'openclaw' }));
    expect(api.getCatalogAgents).toHaveBeenLastCalledWith({ division: 'research' });
    expect(screen.queryByText('Agent Beta')).toBeNull();
  });

  it('guards deactivation while pending and clears the guard after success', async () => {
    let resolveDeactivation!: (value: { active: boolean }) => void;
    vi.mocked(api.deactivateCatalogAgent).mockImplementation(() => new Promise(resolve => { resolveDeactivation = resolve; }));
    renderPage();
    const button = await screen.findByText('Deactivate artifact') as HTMLButtonElement;
    fireEvent.click(button);
    fireEvent.click(button);
    expect(api.deactivateCatalogAgent).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    await act(async () => resolveDeactivation({ active: false }));
    expect(button.disabled).toBe(false);
  });

  it('shows static verdict without inventing a score and blocks rejected preparation', async () => {
    vi.mocked(api.getCatalogAgents).mockResolvedValue({ agents: [
      { ...mockAgents[1], evaluation: { verdict: 'passed' } },
      { ...mockAgents[2], status: 'rejected', evaluation: { verdict: 'rejected' } },
    ] });
    renderPage();
    await screen.findByText('passed — score unavailable');
    expect(screen.getByText('rejected — score unavailable')).toBeTruthy();
    const buttons = screen.getAllByText('Prepare artifact') as HTMLButtonElement[];
    expect(buttons[0].disabled).toBe(false);
    expect(buttons[1].disabled).toBe(true);
    fireEvent.click(buttons[1]);
    expect(api.activateCatalogAgent).not.toHaveBeenCalled();
  });
});
