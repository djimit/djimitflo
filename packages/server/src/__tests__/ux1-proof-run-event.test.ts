import { expect, it, vi } from 'vitest';
import { WebSocketEventType } from '@djimitflo/shared';
import { emitProofRunUpdated } from '../routes/swarm-governance';

it('UX-1: a proof-run update is broadcast with the enum event type the dashboard subscribes to', () => {
  const broadcastToAuthenticated = vi.fn();
  emitProofRunUpdated({ broadcastToAuthenticated } as never, { id: 'p1', status: 'completed', passed: true, rollback_safe: true, runtime: 'mock' } as never);
  expect(broadcastToAuthenticated).toHaveBeenCalledWith(expect.objectContaining({ type: WebSocketEventType.PROOF_RUN_UPDATED, payload: expect.objectContaining({ id: 'p1' }) }));
  expect(WebSocketEventType.PROOF_RUN_UPDATED).toBe('proof_run.updated');
});
