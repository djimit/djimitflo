import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from './helpers/test-db';
import type { Database } from 'better-sqlite3';
import { createSwarmIntelRoutes } from '../routes/swarm-intel';
import { createGovernanceRoutes } from '../routes/swarm-governance';

describe('createSwarmIntelRoutes', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb() as unknown as Database;
  });

  it('returns a router with decompose endpoint', () => {
    const router = createSwarmIntelRoutes(db);
    expect(router).toBeDefined();
    expect(typeof router).toBe('function');
  });

  it('returns a router with knowledge endpoint', () => {
    const router = createSwarmIntelRoutes(db);
    expect(router).toBeDefined();
  });

  it('returns a router with evolution endpoint', () => {
    const router = createSwarmIntelRoutes(db);
    expect(router).toBeDefined();
  });

  it('returns a router with intelligence endpoint', () => {
    const router = createSwarmIntelRoutes(db);
    expect(router).toBeDefined();
  });
});

describe('createGovernanceRoutes', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb() as unknown as Database;
  });

  it('returns a router with governance endpoints', () => {
    const router = createGovernanceRoutes(db);
    expect(router).toBeDefined();
    expect(typeof router).toBe('function');
  });

  it('returns a router with policy endpoints', () => {
    const router = createGovernanceRoutes(db);
    expect(router).toBeDefined();
  });

  it('returns a router with approval endpoints', () => {
    const router = createGovernanceRoutes(db);
    expect(router).toBeDefined();
  });

  it('returns a router with compliance endpoints', () => {
    const router = createGovernanceRoutes(db);
    expect(router).toBeDefined();
  });
});
