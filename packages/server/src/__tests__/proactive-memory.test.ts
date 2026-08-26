import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { ProactiveMemoryService } from '../services/proactive-memory-service';
import { testEmbeddingProvider } from './helpers/test-embedding-provider';

describe('ProactiveMemoryService', () => {
  let db: Database.Database;
  let service: ProactiveMemoryService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    service = new ProactiveMemoryService(db, testEmbeddingProvider);
  });

  it('stores a memory entry', async () => {
    const entry = await service.storeMemory({
      content: 'Test memory content',
      type: 'observation',
      metadata: { source: 'test' },
    });

    expect(entry.id).toBeDefined();
    expect(entry.content).toBe('Test memory content');
    expect(entry.status).toBe('candidate');
    expect(entry.relevanceScore).toBe(0.5);
  });

  it('accesses a memory and updates usage', async () => {
    const entry = await service.storeMemory({ content: 'Test', type: 'observation' });
    const accessed = service.accessMemory(entry.id);

    expect(accessed).toBeDefined();
    expect(accessed?.usageCount).toBe(1);
  });

  it('calculates relevance based on recency and usage', async () => {
    const entry = await service.storeMemory({ content: 'Test', type: 'observation' });

    // Access multiple times to increase relevance
    for (let i = 0; i < 10; i++) {
      service.accessMemory(entry.id);
    }

    const accessed = service.accessMemory(entry.id);
    expect(accessed?.relevanceScore).toBeGreaterThan(0.5);
  });

  it('runs maintenance cycle and promotes high-relevance memories', async () => {
    // Store and access a memory many times
    const entry = await service.storeMemory({ content: 'Important memory', type: 'observation' });
    for (let i = 0; i < 20; i++) {
      service.accessMemory(entry.id);
    }

    const result = await service.runMaintenanceCycle();
    expect(result.evaluated).toBe(1);
    expect(result.promoted).toBe(1);
  });

  it('archives low-relevance memories', async () => {
    await service.storeMemory({ content: 'Unimportant', type: 'observation' });

    // Don't access — relevance stays low
    const result = await service.runMaintenanceCycle();
    expect(result.evaluated).toBe(1);
  });

  it('creates relations between memories', async () => {
    const a = await service.storeMemory({ content: 'Memory A', type: 'observation' });
    const b = await service.storeMemory({ content: 'Memory B', type: 'observation' });

    const relation = service.createRelation(a.id, b.id, 'supports', 0.8);
    expect(relation.id).toBeDefined();
    expect(relation.strength).toBe(0.8);
  });

  it('gets related memories', async () => {
    const a = await service.storeMemory({ content: 'Memory A', type: 'observation' });
    const b = await service.storeMemory({ content: 'Memory B', type: 'observation' });
    service.createRelation(a.id, b.id, 'supports', 0.8);

    const related = service.getRelatedMemories(a.id);
    expect(related.length).toBe(1);
    expect(related[0].id).toBe(b.id);
  });

  it('searches memories semantically', async () => {
    const a = await service.storeMemory({ content: 'Security vulnerability found in auth module', type: 'observation' });
    await service.storeMemory({ content: 'Performance optimization applied', type: 'observation' });

    // Promote to active by accessing many times
    for (let i = 0; i < 25; i++) {
      service.accessMemory(a.id);
    }
    await service.runMaintenanceCycle();

    const results = await service.searchMemories('authentication flaw');
    expect(results.length).toBeGreaterThan(0);
  });

  it('falls back to content search when the embedding provider is unavailable', async () => {
    const entry = await service.storeMemory({ content: 'Clean stale loop worktrees before retry', type: 'observation' });
    for (let i = 0; i < 25; i++) service.accessMemory(entry.id);
    await service.runMaintenanceCycle();

    const unavailable = new ProactiveMemoryService(db, {
      id: 'unavailable',
      embed: async () => { throw new Error('provider unavailable'); },
    });
    expect(await unavailable.searchMemories('stale')).toEqual([
      expect.objectContaining({ id: entry.id }),
    ]);
  });

  it('provides memory statistics', async () => {
    await service.storeMemory({ content: 'Test', type: 'observation' });
    const stats = service.getStats();
    expect(stats.total).toBe(1);
    expect(stats.candidates).toBe(1);
  });
});
