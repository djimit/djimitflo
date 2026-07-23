import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from './helpers/test-db';
import type { Database } from 'better-sqlite3';

describe('registerGovernanceTools', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb() as unknown as Database;
  });

  afterEach(() => {
    db.close();
  });

  it('governance tools module exports registerGovernanceTools', async () => {
    const mod = await import('../../mcp-server/src/tools/governance');
    expect(mod.registerGovernanceTools).toBeDefined();
    expect(typeof mod.registerGovernanceTools).toBe('function');
  });

  it('governance tools module exports registerOrchestrationTools', async () => {
    const mod = await import('../../mcp-server/src/tools/governance');
    expect(mod.registerOrchestrationTools).toBeDefined();
    expect(typeof mod.registerOrchestrationTools).toBe('function');
  });
});
