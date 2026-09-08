import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DashboardPage } from './DashboardPage';
import { useStore } from '../lib/store';

vi.mock('../components/SpecComplianceWidget', () => ({
  SpecComplianceWidget: () => <div>Compliance</div>,
}));

vi.mock('../lib/api', () => ({
  api: { getTasks: vi.fn(), getAgents: vi.fn() },
}));

describe('DashboardPage', () => {
  beforeEach(() => {
    useStore.setState({
      tasks: [
        { id: 'running', title: 'Running', description: '', status: 'running', updated_at: new Date().toISOString() } as never,
        { id: 'done', title: 'Done', description: '', status: 'completed', updated_at: new Date().toISOString() } as never,
      ],
      agents: [{ id: 'agent', status: 'active' } as never],
    });
  });

  it('renders task summaries without a Zustand selector update loop', () => {
    render(<DashboardPage />);

    expect(screen.getByText('Mission Control')).toBeTruthy();
    expect(screen.getByText('1 running now')).toBeTruthy();
    expect(screen.getByText('1 successful')).toBeTruthy();
  });
});
