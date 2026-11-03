import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type Database from 'better-sqlite3';
import { lureTargets, HEURISTIC_GAP } from '../services/agent-lure-service';
import { createTestDb } from './helpers/test-db';

describe('agent-lure-service exports (lureTargets, HEURISTIC_GAP)', () => {
  let db: Database.Database;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lure-exports-'));
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('exports the heuristic gap sentinel used to filter bookkeeping gaps', () => {
    expect(typeof HEURISTIC_GAP).toBe('string');
    expect(HEURISTIC_GAP).toContain('Knowledge gap: Sparse claim inventory');
  });

  it('returns agents whose heartbeat is older than the cutoff, ordered by id', () => {
    db.prepare("INSERT INTO agents (id, name, status, metadata) VALUES ('zeta', 'Zeta', 'active', '{}'), ('alpha', 'Alpha', 'idle', '{}')").run();
    const targets = lureTargets(db, '9999-12-31T00:00:00.000Z');
    expect(targets.map((t) => t.id)).toEqual(['alpha', 'zeta']);
    for (const t of targets) {
      expect(t.reach).toBe('never');
      expect(t.name).toBe(t.id === 'alpha' ? 'Alpha' : 'Zeta');
    }
  });

  it('excludes agents with a heartbeat newer than the cutoff', () => {
    db.prepare("INSERT INTO agents (id, name, status, metadata) VALUES ('live', 'Live', 'active', ?)").run(
      JSON.stringify({ social_runtime: { last_heartbeat_at: '2099-01-01T00:00:00.000Z' } }),
    );
    const targets = lureTargets(db, '2000-01-01T00:00:00.000Z');
    expect(targets.find((t) => t.id === 'live')).toBeUndefined();
  });

  it('skips agents that are paused (not active/idle)', () => {
    db.prepare("INSERT INTO agents (id, name, status, metadata) VALUES ('paused', 'Paused', 'paused', '{}')").run();
    const targets = lureTargets(db, '9999-12-31T00:00:00.000Z');
    expect(targets.find((t) => t.id === 'paused')).toBeUndefined();
  });

  it('never lures loop worker roles even when they have no social runtime', () => {
    db.prepare("INSERT INTO agents (id, name, status, capabilities_json, metadata) VALUES ('maker-1', 'Maker', 'active', '[\"maker\"]', '{}'), ('checker-1', 'Checker', 'idle', '[\"checker\"]', '{}'), ('sec-1', 'Sec', 'active', '[\"security_checker\"]', '{}')").run();
    const targets = lureTargets(db, '9999-12-31T00:00:00.000Z');
    expect(targets.find((t) => t.id === 'maker-1')).toBeUndefined();
    expect(targets.find((t) => t.id === 'checker-1')).toBeUndefined();
    expect(targets.find((t) => t.id === 'sec-1')).toBeUndefined();
  });

  it('marks lapsed agents (with social_runtime) as reach=lapsed and never agents as never', () => {
    db.prepare("INSERT INTO agents (id, name, status, metadata) VALUES ('lapsed', 'Lapsed', 'active', ?), ('never', 'Never', 'active', '{}')").run(
      JSON.stringify({ social_runtime: { enabled: true, last_heartbeat_at: '2000-01-01T00:00:00.000Z' } }),
    );
    const targets = lureTargets(db, '9999-12-31T00:00:00.000Z');
    const lapsed = targets.find((t) => t.id === 'lapsed');
    const never = targets.find((t) => t.id === 'never');
    expect(lapsed?.reach).toBe('lapsed');
    expect(never?.reach).toBe('never');
  });

  it('parses capabilities_json when capabilities column is absent and skips loop workers', () => {
    db.prepare("INSERT INTO agents (id, name, status, capabilities_json, metadata) VALUES ('worker', 'Worker', 'active', '[\"maker\"]', '{}')").run();
    const targets = lureTargets(db, '9999-12-31T00:00:00.000Z');
    expect(targets.find((t) => t.id === 'worker')).toBeUndefined();
  });

  it('an agent that is a loop worker but also has a social runtime is lured (social wins)', () => {
    db.prepare("INSERT INTO agents (id, name, status, capabilities_json, metadata) VALUES ('dual', 'Dual', 'active', '[\"maker\"]', ?)").run(
      JSON.stringify({ social_runtime: { enabled: true, last_heartbeat_at: '2000-01-01T00:00:00.000Z' } }),
    );
    const targets = lureTargets(db, '9999-12-31T00:00:00.000Z');
    const dual = targets.find((t) => t.id === 'dual');
    expect(dual).toBeDefined();
    expect(dual?.reach).toBe('lapsed');
  });

  it('returns an empty array when no agents match', () => {
    const targets = lureTargets(db, '9999-12-31T00:00:00.000Z');
    expect(targets).toEqual([]);
  });
});