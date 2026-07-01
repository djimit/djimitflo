import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { EmergentSpecializationService } from '../services/emergent-specialization-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let service: EmergentSpecializationService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  service = new EmergentSpecializationService(db);
});

afterEach(() => {
  db?.close();
});

describe('G104: Emergent Specialization', () => {
  it('records performance', () => {
    service.recordPerformance('agent-1', 'physics', 'quantum', true);
    const specs = service.getSpecializations('agent-1');
    expect(specs.length).toBe(1);
    expect(specs[0].nRuns).toBe(1);
  });

  it('calculates success rate', () => {
    service.recordPerformance('agent-1', 'physics', 'quantum', true);
    service.recordPerformance('agent-1', 'physics', 'quantum', false);
    service.recordPerformance('agent-1', 'physics', 'quantum', true);

    const specs = service.getSpecializations('agent-1');
    expect(specs[0].successRate).toBeCloseTo(0.67, 1);
  });

  it('promotes to established after threshold', () => {
    for (let i = 0; i < 5; i++) {
      service.recordPerformance('agent-1', 'physics', 'quantum', true);
    }

    const specs = service.getSpecializations('agent-1', 'established');
    expect(specs.length).toBe(1);
  });

  it('prunes low performance', () => {
    for (let i = 0; i < 10; i++) {
      service.recordPerformance('agent-1', 'physics', 'quantum', false);
    }

    const specs = service.getSpecializations('agent-1', 'pruned');
    expect(specs.length).toBe(1);
  });

  it('gets established specializations', () => {
    for (let i = 0; i < 5; i++) {
      service.recordPerformance('agent-1', 'physics', 'quantum', true);
    }

    const established = service.getEstablishedSpecializations();
    expect(established.length).toBe(1);
  });

  it('detects cross-domain transfer', () => {
    for (let i = 0; i < 5; i++) {
      service.recordPerformance('agent-1', 'physics', 'quantum', true);
      service.recordPerformance('agent-1', 'math', 'algebra', true);
    }

    const transfers = service.detectCrossDomainTransfer();
    expect(transfers.length).toBeGreaterThan(0);
  });

  it('recommends agent for domain', () => {
    for (let i = 0; i < 5; i++) {
      service.recordPerformance('agent-1', 'physics', 'quantum', true);
    }

    const rec = service.getRecommendation('agent-1', 'physics');
    expect(rec).toContain('agent-1');
    expect(rec).toContain('physics');
  });

  it('returns no specialization for unknown agent', () => {
    const specs = service.getSpecializations('unknown-agent');
    expect(specs).toEqual([]);
  });

  it('updates existing specialization', () => {
    service.recordPerformance('agent-1', 'physics', 'quantum', true);
    service.recordPerformance('agent-1', 'physics', 'quantum', true);

    const specs = service.getSpecializations('agent-1');
    expect(specs.length).toBe(1);
    expect(specs[0].nRuns).toBe(2);
  });
});
