import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { InMemoryMemoryStore, SqliteMemoryStore } from '../services/memory-store';
import type { MemoryStore } from '../services/memory-store';

const sample = { type: 'episode' as const, content: 'deploy succeeded on vps', source: 'loop', confidence: 0.9, metadata: { run: 'r1' } };

describe.each([
  ['SqliteMemoryStore', () => new SqliteMemoryStore(new Database(':memory:'))],
  ['InMemoryMemoryStore', () => new InMemoryMemoryStore()],
])('%s', (_name, make) => {
  let store: MemoryStore;

  beforeEach(() => {
    store = make();
  });

  afterEach(() => {
    const db = (store as unknown as { db?: Database.Database }).db;
    db?.close();
  });

  it('store returns the record with generated id and createdAt, retrieve round-trips it', () => {
    const rec = store.store(sample);
    expect(rec.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rec.createdAt).toBeTruthy();
    const got = store.retrieve(rec.id);
    expect(got).toMatchObject({ id: rec.id, type: 'episode', content: sample.content, source: 'loop', confidence: 0.9, metadata: { run: 'r1' } });
  });

  it('retrieve returns null for unknown id', () => {
    expect(store.retrieve('nope')).toBeNull();
  });

  it('store preserves provided metadata verbatim', () => {
    const rec = store.store({ ...sample, metadata: { nested: { a: 1 }, list: [1, 2] } });
    expect(store.retrieve(rec.id)!.metadata).toEqual({ nested: { a: 1 }, list: [1, 2] });
  });

  it('search filters by type, source, minConfidence, and query text', () => {
    store.store(sample);
    store.store({ type: 'skill', content: 'rollback procedure', source: 'manual', confidence: 0.4, metadata: {} });
    expect(store.search({ type: 'episode' })).toHaveLength(1);
    expect(store.search({ source: 'manual' })).toHaveLength(1);
    expect(store.search({ minConfidence: 0.8 })).toHaveLength(1);
    expect(store.search({ query: 'rollback' })).toHaveLength(1);
    expect(store.search({ query: 'absent-text' })).toHaveLength(0);
  });

  it('search orders by confidence descending and applies limit', () => {
    store.store({ ...sample, confidence: 0.3, content: 'low' });
    store.store({ ...sample, confidence: 0.9, content: 'high' });
    store.store({ ...sample, confidence: 0.6, content: 'mid' });
    const all = store.search({});
    expect(all.map(r => r.confidence)).toEqual([0.9, 0.6, 0.3]);
    expect(store.search({ limit: 2 })).toHaveLength(2);
  });

  it('relate creates a relation retrievable from both endpoints via getRelations', () => {
    const a = store.store(sample);
    const b = store.store({ ...sample, content: 'other' });
    const rel = store.relate(a.id, b.id, 'caused_by', 0.7);
    expect(rel).toMatchObject({ fromId: a.id, toId: b.id, relationType: 'caused_by', strength: 0.7 });
    expect(store.getRelations(a.id).map(r => r.id)).toContain(rel.id);
    expect(store.getRelations(b.id).map(r => r.id)).toContain(rel.id);
    expect(store.getRelations('unrelated')).toEqual([]);
  });

  it('project walks the relation graph up to the given depth', () => {
    const a = store.store({ ...sample, content: 'a' });
    const b = store.store({ ...sample, content: 'b' });
    const c = store.store({ ...sample, content: 'c' });
    store.relate(a.id, b.id, 'links', 0.5);
    store.relate(b.id, c.id, 'links', 0.5);
    expect(store.project(a.id, 0).map(r => r.content)).toEqual(['a']);
    expect(store.project(a.id, 1).map(r => r.content).sort()).toEqual(['a', 'b']);
    expect(store.project(a.id, 2).map(r => r.content).sort()).toEqual(['a', 'b', 'c']);
  });

  it('project does not revisit nodes in a cycle', () => {
    const a = store.store({ ...sample, content: 'a' });
    const b = store.store({ ...sample, content: 'b' });
    store.relate(a.id, b.id, 'links', 0.5);
    store.relate(b.id, a.id, 'links', 0.5);
    expect(store.project(a.id, 5)).toHaveLength(2);
  });

  it('project on an unknown id returns an empty array', () => {
    expect(store.project('nope', 3)).toEqual([]);
  });
});
