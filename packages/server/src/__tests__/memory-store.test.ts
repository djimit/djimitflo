import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteMemoryStore, InMemoryMemoryStore, type MemoryStore } from '../services/memory-store';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

describe('G120: MemoryStore', () => {
  describe('InMemoryMemoryStore', () => {
    let store: InMemoryMemoryStore;

    beforeEach(() => { store = new InMemoryMemoryStore(); });

    it('stores and retrieves memory', () => {
      const record = store.store({ type: 'observation', content: 'Test', source: 'test', confidence: 0.8 });
      const retrieved = store.retrieve(record.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.content).toBe('Test');
    });

    it('searches by type', () => {
      store.store({ type: 'episode', content: 'Episode 1', source: 'test', confidence: 0.9 });
      store.store({ type: 'observation', content: 'Obs 1', source: 'test', confidence: 0.5 });
      const results = store.search({ type: 'episode' });
      expect(results.length).toBe(1);
    });

    it('searches by query', () => {
      store.store({ type: 'observation', content: 'quantum computing research', source: 'test', confidence: 0.7 });
      store.store({ type: 'observation', content: 'machine learning', source: 'test', confidence: 0.6 });
      const results = store.search({ query: 'quantum' });
      expect(results.length).toBe(1);
    });

    it('creates relations', () => {
      const a = store.store({ type: 'observation', content: 'A', source: 'test', confidence: 0.8 });
      const b = store.store({ type: 'observation', content: 'B', source: 'test', confidence: 0.7 });
      const rel = store.relate(a.id, b.id, 'implies', 0.9);
      expect(rel.id).toBeDefined();
      const relations = store.getRelations(a.id);
      expect(relations.length).toBe(1);
    });

    it('projects graph', () => {
      const a = store.store({ type: 'observation', content: 'A', source: 'test', confidence: 0.8 });
      const b = store.store({ type: 'observation', content: 'B', source: 'test', confidence: 0.7 });
      const c = store.store({ type: 'observation', content: 'C', source: 'test', confidence: 0.6 });
      store.relate(a.id, b.id, 'implies', 0.9);
      store.relate(b.id, c.id, 'implies', 0.8);
      const projection = store.project(a.id, 2);
      expect(projection.length).toBe(3);
    });
  });

  describe('SqliteMemoryStore', () => {
    let db: Database.Database;
    let store: SqliteMemoryStore;

    beforeEach(() => {
      db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      db.exec(schema);
      runMigrations(db);
      store = new SqliteMemoryStore(db);
    });

    afterEach(() => { db?.close(); });

    it('stores and retrieves memory', () => {
      const record = store.store({ type: 'episode', content: 'Test episode', source: 'test', confidence: 0.9, metadata: {} });
      const retrieved = store.retrieve(record.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.type).toBe('episode');
    });

    it('searches with filters', () => {
      store.store({ type: 'episode', content: 'E1', source: 'swarm', confidence: 0.9, metadata: {} });
      store.store({ type: 'skill', content: 'S1', source: 'gym', confidence: 0.7, metadata: {} });
      expect(store.search({ type: 'episode' }).length).toBe(1);
      expect(store.search({ source: 'swarm' }).length).toBe(1);
      expect(store.search({ minConfidence: 0.8 }).length).toBe(1);
    });
  });
});
