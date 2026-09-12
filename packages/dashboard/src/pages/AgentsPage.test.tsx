import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../../../server/src/database/schema';
import { NlAgentFactory } from '../../../server/src/services/nl-agent-factory';
import { useStore } from '../lib/store';
import { AgentsPage } from './AgentsPage';

afterEach(() => { cleanup(); useStore.setState({ agents: [], tasks: [] }); });

it('renders the actual factory pending-approval record without activating it', () => {
  const db = new Database(':memory:');
  try {
    db.exec(schema);
    const created = new NlAgentFactory(db).createFromDescription('Read fixture documentation', { name: 'Disposable NL draft' });
    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(created.id) as any;
    useStore.setState({ agents: [{ ...row, capabilities: JSON.parse(row.capabilities), metadata: JSON.parse(row.metadata) }] });
    render(<MemoryRouter><AgentsPage /></MemoryRouter>);
    expect(screen.getByText('Disposable NL draft')).toBeTruthy();
    expect(screen.getByText('pending_approval')).toBeTruthy();
    expect(db.prepare('SELECT status FROM agents WHERE id = ?').get(created.id)).toEqual({ status: 'pending_approval' });
  } finally { db.close(); }
});

it('keeps unknown provider status visible without crashing the entire registry', () => {
  useStore.setState({ agents: [{ id: 'fixture', name: 'Unexpected status', status: 'future_status', capabilities: [], total_tasks: 0, completed_tasks: 0, failed_tasks: 0 }] as any });
  render(<MemoryRouter><AgentsPage /></MemoryRouter>);
  expect(screen.getByText('future_status')).toBeTruthy();
});

it('distinguishes an offline retired agent from temporary offline status', () => {
  useStore.setState({ agents: [{ id: 'fixture', name: 'Retired fixture', status: 'offline', retired_at: '2026-09-09T12:00:00Z', retirement_reason: 'Fixture decommission', capabilities: [], total_tasks: 0, completed_tasks: 0, failed_tasks: 0 }] as any });
  render(<MemoryRouter><AgentsPage /></MemoryRouter>);
  expect(screen.getByText('offline')).toBeTruthy();
  expect(screen.getByText(/Retired at/)).toBeTruthy();
  expect(screen.getByText(/Fixture decommission/)).toBeTruthy();
});
