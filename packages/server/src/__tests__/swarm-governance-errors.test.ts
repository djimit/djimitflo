import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from 'better-sqlite3';
import { createGovernanceRoutes } from '../routes/swarm-governance';
import { createTestDb } from './helpers/test-db';

describe('swarm governance error mapping', () => {
  let db: Database | undefined;

  afterEach(() => db?.close());

  it.each([
    ['get', '/proof-runs/:id', { params: { id: 'missing' } }, 'PROOF_RUN_NOT_FOUND'],
    ['post', '/assurance/trace-spans', { body: {} }, 'ASSURANCE_TRACE_REQUIRED'],
    ['post', '/memory/candidates', { body: {} }, 'MEMORY_CANDIDATE_TITLE_REQUIRED'],
    ['post', '/cs-skill-intelligence/run', { body: { runtime: 'invalid' } }, 'CS_SKILL_SWARM_RUNTIME_INVALID'],
  ])('forwards one mapped error for %s %s', async (method, path, request, code) => {
    db = createTestDb();
    const router = createGovernanceRoutes(db);
    const layer = (router as any).stack.find((candidate: any) =>
      candidate.route?.path === path && candidate.route.methods[method],
    );
    const handler = layer.route.stack.at(-1).handle;
    const next = vi.fn();
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handler({ query: {}, params: {}, body: {}, ...request }, response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toMatchObject({ code });
  });
});
