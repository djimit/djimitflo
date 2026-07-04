import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { ProactiveMemoryService } from '../services/proactive-memory-service';

describe('ProactiveMemoryService', () => {
  let db: Database.Database;
  let service: ProactiveMemoryService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    service = new ProactiveMemoryService(db);
  });

  it('stores a memory entry', () => {
    const entry = service.storeMemory({
      content: 'Test memory content',
      type: 'observation',
      metadata: { source: 'test' },
    });

    expect(entry.id).toBeDefined();
    expect(entry.content).toBe('Test memory content');
    expect(entry.status).toBe('candidate');
    expect(entry.relevanceScore).toBe(0.5);
  });

  it('accesses a memory and updates usage', () => {
    const entry = service.storeMemory({ content: 'Test', type: 'observation' });
    const accessed = service.accessMemory(entry.id);

    expect(accessed).toBeDefined();
    expect(accessed?.usageCount).toBe(1);
  });

  it('calculates relevance based on recency and usage', () => {
    const entry = service.storeMemory({ content: 'Test', type: 'observation' });

    // Access multiple times to increase relevance
    for (let i = 0; i < 10; i++) {
      service.accessMemory(entry.id);
    }

    const accessed = service.accessMemory(entry.id);
    expect(accessed?.relevanceScore).toBeGreaterThan(0.5);
  });

  it('runs maintenance cycle and promotes high-relevance memories', () => {
    // Store and access a memory many times
    const entry = service.storeMemory({ content: 'Important memory', type: 'observation' });
    for (let i = 0; i < 20; i++) {
      service.accessMemory(entry.id);
    }

    const result = service.runMaintenanceCycle();
    expect(result.evaluated).toBe(1);
    expect(result.promoted).toBe(1);
  });

  it('archives low-relevance memories', () => {
    service.storeMemory({ content: 'Unimportant', type: 'observation' });

    // Don't access — relevance stays low
    const result = service.runMaintenanceCycle();
    expect(result.evaluated).toBe(1);
  });

  it('creates relations between memories', () => {
    const a = service.storeMemory({ content: 'Memory A', type: 'observation' });
    const b = service.storeMemory({ content: 'Memory B', type: 'observation' });

    const relation = service.createRelation(a.id, b.id, 'supports', 0.8);
    expect(relation.id).toBeDefined();
    expect(relation.strength).toBe(0.8);
  });

  it('gets related memories', () => {
    const a = service.storeMemory({ content: 'Memory A', type: 'observation' });
    const b = service.storeMemory({ content: 'Memory B', type: 'observation' });
    service.createRelation(a.id, b.id, 'supports', 0.8);

    const related = service.getRelatedMemories(a.id);
    expect(related.length).toBe(1);
    expect(related[0].id).toBe(b.id);
  });

  it('searches memories by content', () => {
    const a = service.storeMemory({ content: 'Security vulnerability found in auth module', type: 'observation' });
    service.storeMemory({ content: 'Performance optimization applied', type: 'observation' });

    // Promote to active by accessing many times
    for (let i = 0; i < 25; i++) {
      service.accessMemory(a.id);
    }
    service.runMaintenanceCycle();

    const results = service.searchMemories('security vulnerability');
    expect(results.length).toBeGreaterThan(0);
  });

  it('provides memory statistics', () => {
    service.storeMemory({ content: 'Test', type: 'observation' });
    const stats = service.getStats();
    expect(stats.total).toBe(1);
    expect(stats.candidates).toBe(1);
  });
});
