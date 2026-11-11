import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LurePanel, OpenDoorPanel } from './LureAndDoorPanels';
import type { JoinRequest, LureCast, LureStatus } from '../../lib/api';

vi.mock('../../lib/api', () => ({
  api: { getAgentReputation: vi.fn() },
}));

import { api } from '../../lib/api';

const baseLureStatus: LureStatus = {
  lures: [
    {
      id: 'lure-1', topic: 'find the silence bug', topic_ref: 'gap-42', created_by: 'operator',
      created_at: '2026-11-10T10:00:00Z', expires_at: '2026-11-11T10:00:00Z', bites: 1,
      invitees: [
        { agent_id: 'a-1', name: 'Alpha', state: 'bit', bit_at: '2026-11-10T11:00:00Z' },
        { agent_id: 'a-2', name: 'Beta', state: 'invited', bit_at: null },
        { agent_id: 'a-3', name: 'Gamma', state: 'expired', bit_at: null },
      ],
    },
  ],
  probes: [{ id: 'p-1', agent_id: 'rogue', ip: '10.0.0.9', reason: 'no key', created_at: '2026-11-10T12:00:00Z' }],
  probe_count: 1,
};

const baseCast: LureCast = {
  lure: { id: 'lure-1', topic: 'find the silence bug', topic_ref: 'gap-42', created_at: '2026-11-10T10:00:00Z', expires_at: '2026-11-11T10:00:00Z', invited: ['a-2'] },
  invitations: [
    { agent_id: 'a-2', name: 'Beta', token: 'tok-secret-123456', expires_at: '2026-11-11T10:00:00Z', poller_env: 'RUNNER_TOKEN=tok-secret-123456 node poller.js' },
  ],
};

const pendingRequest: JoinRequest = {
  agent_id: 'ext-1', name: 'Outsider', description: 'a wandering agent', capabilities: ['research'], contact: 'ops@ext.org',
  invite_label: 'web', status: 'pending', requested_at: '2026-11-10T09:00:00Z', decided_at: null, decided_by: null, ip: '192.0.2.1',
};

afterEach(() => { cleanup(); vi.resetAllMocks(); });

beforeEach(() => {
  vi.mocked(api.getAgentReputation).mockResolvedValue({ agent_id: 'x', score: 0.5, task_completion_rate: null, probe_count: 0, bite_count: 0, sample_size: 0 });
  vi.stubGlobal('navigator', {
    ...navigator,
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

describe('LurePanel', () => {
  it('renders the heading and lures with bite counts and invitee states', () => {
    render(<LurePanel lures={baseLureStatus} cast={null} />);
    expect(screen.getByText('Lure and honeypot')).toBeTruthy();
    expect(screen.getByText('find the silence bug')).toBeTruthy();
    expect(screen.getByText('1/3 bitten')).toBeTruthy();
    expect(screen.getByText(/Alpha · bitten/)).toBeTruthy();
    expect(screen.getByText(/Beta · invited/)).toBeTruthy();
    expect(screen.getByText(/Gamma · expired/)).toBeTruthy();
  });

  it('shows the empty state when no lures have been cast', () => {
    render(<LurePanel lures={null} cast={null} />);
    expect(screen.getByText('No lure cast yet.')).toBeTruthy();
    expect(screen.getByText('Nobody has knocked without a key.')).toBeTruthy();
  });

  it('redacts tokens by default and reveals them on toggle', () => {
    render(<LurePanel lures={null} cast={baseCast} />);
    expect(screen.getByText('show tokens')).toBeTruthy();
    expect(screen.getByText(/RUNNER_TOKEN=•{24} node poller\.js/)).toBeTruthy();
    expect(screen.queryByText('tok-secret-123456')).toBeNull();
    fireEvent.click(screen.getByText('show tokens'));
    expect(screen.getByText('hide tokens')).toBeTruthy();
    expect(screen.getByText(/RUNNER_TOKEN=tok-secret-123456 node poller\.js/)).toBeTruthy();
  });

  it('copies the poller command and shows a copied label', async () => {
    render(<LurePanel lures={null} cast={baseCast} />);
    fireEvent.click(screen.getByText('copy poller command'));
    await waitFor(() => expect(screen.getByText('copied')).toBeTruthy());
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(baseCast.invitations[0].poller_env);
  });
});

describe('OpenDoorPanel', () => {
  it('calls onInvite when the create invitation button is clicked', () => {
    const onInvite = vi.fn();
    render(<OpenDoorPanel requests={[]} invite={null} onInvite={onInvite} onDecide={vi.fn()} busy={false} />);
    fireEvent.click(screen.getByText('Create invitation code'));
    expect(onInvite).toHaveBeenCalledOnce();
  });

  it('disables actions while busy', () => {
    render(<OpenDoorPanel requests={[pendingRequest]} invite={null} onInvite={vi.fn()} onDecide={vi.fn()} busy={true} />);
    expect((screen.getByText('Create invitation code') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText('Admit') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText('Reject') as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders the invitation code and a knock example, and copies it', async () => {
    const invite = { code: 'CODE-1', label: 'web', expires_at: '2026-11-12T00:00:00Z', max_uses: 3, join_url: 'http://localhost/api/swarm-v2/social-runtime/knock' };
    render(<OpenDoorPanel requests={[]} invite={invite} onInvite={vi.fn()} onDecide={vi.fn()} busy={false} />);
    expect(screen.getByText(/Code for "web"/)).toBeTruthy();
    fireEvent.click(screen.getByText('copy knock example'));
    await waitFor(() => expect(screen.getByText('copied')).toBeTruthy());
  });

  it('calls onDecide with admit/reject for pending requests and shows the waiting badge', async () => {
    const onDecide = vi.fn();
    vi.mocked(api.getAgentReputation).mockResolvedValue({ agent_id: 'ext-1', score: 0.8, task_completion_rate: 0.9, probe_count: 0, bite_count: 1, sample_size: 5 });
    render(<OpenDoorPanel requests={[pendingRequest]} invite={null} onInvite={vi.fn()} onDecide={onDecide} busy={false} />);
    expect(screen.getByText('1 waiting')).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/reputation 0\.80/)).toBeTruthy());
    fireEvent.click(screen.getByText('Admit'));
    fireEvent.click(screen.getByText('Reject'));
    expect(onDecide).toHaveBeenNthCalledWith(1, 'ext-1', true);
    expect(onDecide).toHaveBeenNthCalledWith(2, 'ext-1', false);
  });

  it('shows the empty state when nobody has knocked', () => {
    render(<OpenDoorPanel requests={[]} invite={null} onInvite={vi.fn()} onDecide={vi.fn()} busy={false} />);
    expect(screen.getByText('Nobody from outside has knocked yet.')).toBeTruthy();
  });
});
