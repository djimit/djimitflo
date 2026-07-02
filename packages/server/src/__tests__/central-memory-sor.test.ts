import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { CentralMemorySOR } from '../services/central-memory-sor';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let sor: CentralMemorySOR;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  sor = new CentralMemorySOR(db);
});

afterEach(() => { db?.close(); });

describe('G130: Central Memory SOR', () => {
  it('ingests and retrieves', () => {
    const r = sor.ingest({ type: 'observation', content: 'Test', source: 'test', confidence: 0.8 });
    expect(sor.retrieve(r.id)).not.toBeNull();
  });

  it('queries by type', () => {
    sor.ingest({ type: 'observation', content: 'A', source: 'test', confidence: 0.9 });
    sor.ingest({ type: 'episode', content: 'B', source: 'test', confidence: 0.7 });
    expect(sor.query({ type: 'observation' }).length).toBe(1);
  });

  it('relates and graphs', () => {
    const a = sor.ingest({ type: 'observation', content: 'A', source: 'test', confidence: 0.8 });
    const b = sor.ingest({ type: 'observation', content: 'B', source: 'test', confidence: 0.7 });
    sor.relate(a.id, b.id, 'implies', 0.9);
    expect(sor.getGraph(a.id, 2).length).toBe(2);
  });

  it('gets stats', () => {
    sor.ingest({ type: 'observation', content: 'Test', source: 'test', confidence: 0.8 });
    expect(sor.getStats().totalRecords).toBe(1);
  });

  it('searches by similarity', () => {
    sor.ingest({ type: 'observation', content: 'quantum computing', source: 'test', confidence: 0.9 });
    expect(sor.searchBySimilarity('quantum physics', 5).length).toBeGreaterThan(0);
  });

  it('deletes record', () => {
    const r = sor.ingest({ type: 'observation', content: 'Test', source: 'test', confidence: 0.8 });
    expect(sor.deleteRecord(r.id)).toBe(true);
  });
});
