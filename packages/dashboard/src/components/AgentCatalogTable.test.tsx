import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import type { CatalogAgent } from '../lib/api';

const canManageRef = { current: true };

vi.mock('../lib/auth-store', () => ({
  useAuthStore: () => ({
    hasPermission: (perm: string) => perm === 'manage:config' && canManageRef.current,
    user: canManageRef.current ? { role: 'admin' } : null,
    token: null,
    isAuthenticated: canManageRef.current,
    isLoading: false,
    error: null,
    login: vi.fn(),
    logout: vi.fn(),
    restoreSession: vi.fn(),
    replaceToken: vi.fn(),
  }),
}));

import { AgentCatalogTable } from './AgentCatalogTable';

type TableProps = React.ComponentProps<typeof AgentCatalogTable>;

const agent = (over: Partial<CatalogAgent> = {}): CatalogAgent => ({
  id: '1', name: 'Agent Alpha', division: 'research', status: 'imported',
  evaluation: { score: 85, verdict: 'passed' }, activation: { active: false }, ...over,
});

function renderTable(over: Partial<TableProps> = {}) {
  const props: TableProps = {
    agents: [], divisions: ['research', 'ops'], divisionFilter: undefined, searchQuery: '',
    onActivate: vi.fn<(id: string, target?: string) => Promise<void>>(),
    onDeactivate: vi.fn<(id: string) => Promise<void>>(),
    onFilterDivision: vi.fn<(d: string | undefined) => void>(),
    onSearch: vi.fn<(q: string) => void>(),
    ...over,
  };
  return { ...render(<AgentCatalogTable {...props} />), props };
}

describe('AgentCatalogTable', () => {
  beforeEach(() => { canManageRef.current = true; });

  it('renders search input, division select and table headers', () => {
    renderTable();
    expect(screen.getByPlaceholderText('Search agents...')).toBeTruthy();
    expect(screen.getByLabelText('Division')).toBeTruthy();
    for (const h of ['Name', 'Division', 'Status', 'Evaluation', 'Actions']) {
      expect(screen.getByText(h)).toBeTruthy();
    }
  });

  it('shows the ranked-matches hint only while searching', () => {
    const { props, rerender } = renderTable({ searchQuery: 'alpha' });
    expect(screen.getByText('Search shows up to 20 ranked matches.')).toBeTruthy();
    rerender(<AgentCatalogTable {...props} searchQuery="" />);
    expect(screen.queryByText('Search shows up to 20 ranked matches.')).toBeNull();
  });

  it('maps active status to "artifact prepared" and shows the activation target', () => {
    renderTable({ agents: [
      agent({ id: '1', status: 'active', activation: { target: 'openclaw', active: true } }),
      agent({ id: '2', name: 'Agent Beta', division: 'ops' }),
    ] });
    expect(screen.getByText('artifact prepared')).toBeTruthy();
    expect(screen.getByText('Target: openclaw')).toBeTruthy();
    expect(screen.getByText('Agent Beta')).toBeTruthy();
  });

  it('formats evaluation as score (verdict), verdict-only, and not evaluated', () => {
    renderTable({ agents: [
      agent({ id: '1', evaluation: { score: 92, verdict: 'passed' } }),
      agent({ id: '2', name: 'B', evaluation: { verdict: 'passed' } }),
      agent({ id: '3', name: 'C', evaluation: null }),
    ] });
    expect(screen.getByText('92 (passed)')).toBeTruthy();
    expect(screen.getByText('passed — score unavailable')).toBeTruthy();
    expect(screen.getByText('Not evaluated')).toBeTruthy();
  });

  it('uses default, filtered and custom empty messages', () => {
    renderTable();
    expect(screen.getByText('No agents imported yet.')).toBeTruthy();
    renderTable({ searchQuery: 'zzz' });
    expect(screen.getByText('No agents match the current filter.')).toBeTruthy();
    renderTable({ emptyMessage: 'Nothing here.' });
    expect(screen.getByText('Nothing here.')).toBeTruthy();
  });

  it('hides the Actions column and artifact target selector for non-managers', () => {
    canManageRef.current = false;
    renderTable({ agents: [agent()] });
    expect(screen.queryByText('Actions')).toBeNull();
    expect(screen.queryByText('Artifact target')).toBeNull();
    expect(screen.queryByText('Prepare artifact')).toBeNull();
  });

  it('shows Prepare/Deactivate artifact buttons and disables Prepare when verdict is not passed', () => {
    renderTable({ agents: [
      agent({ id: '1', status: 'active', activation: { target: 'openclaw', active: true } }),
      agent({ id: '2', name: 'B', status: 'evaluated', evaluation: { verdict: 'rejected' } }),
    ] });
    expect(screen.getByText('Deactivate artifact')).toBeTruthy();
    const btn = screen.getByText('Prepare artifact').closest('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toContain('passed evaluation is required');
  });

  it('calls onSearch and onFilterDivision on input changes', () => {
    const { props } = renderTable();
    fireEvent.change(screen.getByLabelText('Search agents'), { target: { value: 'alpha' } });
    expect(props.onSearch).toHaveBeenCalledWith('alpha');
    fireEvent.change(screen.getByLabelText('Division'), { target: { value: 'research' } });
    expect(props.onFilterDivision).toHaveBeenCalledWith('research');
    fireEvent.change(screen.getByLabelText('Division'), { target: { value: '' } });
    expect(props.onFilterDivision).toHaveBeenLastCalledWith(undefined);
  });

  it('calls onActivate with the selected target and onDeactivate on button clicks', async () => {
    const { props } = renderTable({ agents: [
      agent({ id: '1', status: 'active', activation: { target: 'openclaw', active: true } }),
      agent({ id: '2', name: 'B', status: 'evaluated', evaluation: { score: 70, verdict: 'passed' } }),
    ] });
    fireEvent.change(screen.getByLabelText('Artifact target'), { target: { value: 'codex' } });
    fireEvent.click(screen.getByText('Prepare artifact'));
    await waitFor(() => expect(props.onActivate).toHaveBeenCalledWith('2', 'codex'));
    fireEvent.click(screen.getByText('Deactivate artifact'));
    await waitFor(() => expect(props.onDeactivate).toHaveBeenCalledWith('1'));
  });

  it('guards against double-click while pending and surfaces an action error', async () => {
    let rejectActivation!: (e: Error) => void;
    const onActivate = vi.fn<() => Promise<void>>(() => new Promise((_r, reject) => { rejectActivation = reject; }));
    renderTable({ agents: [agent({ id: '1', status: 'evaluated', evaluation: { score: 70, verdict: 'passed' } })], onActivate });
    const btn = screen.getByText('Prepare artifact').closest('button') as HTMLButtonElement;
    fireEvent.click(btn); fireEvent.click(btn);
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(btn.disabled).toBe(true);
    expect(screen.getByText('Preparing artifact…')).toBeTruthy();
    await act(async () => rejectActivation(new Error('Artifact write failed')));
    expect(screen.getByRole('alert').textContent).toContain('Artifact write failed');
    await waitFor(() => expect(btn.disabled).toBe(false));
  });
});
