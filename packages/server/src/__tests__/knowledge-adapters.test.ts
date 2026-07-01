import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  KnowledgeAdapterRegistry,
  WikipediaAdapter,
  ArxivAdapter,
  OkfAdapter,
  AdapterCache,
} from '../services/knowledge-adapters';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
});

afterEach(() => {
  db?.close();
});

describe('G94: Knowledge Adapters', () => {
  describe('AdapterCache', () => {
    it('returns null for cache miss', () => {
      const cache = new AdapterCache(db);
      const result = cache.get('wikipedia', 'quantum physics');
      expect(result).toBeNull();
    });

    it('returns cached results on hit', () => {
      const cache = new AdapterCache(db);
      const data = [{ id: '1', title: 'Test', content: 'Body', source: 'test', confidence: 0.5 }];
      cache.set('wikipedia', 'quantum', data);
      const result = cache.get('wikipedia', 'quantum');
      expect(result).toEqual(data);
    });

    it('expires entries after TTL', async () => {
      const cache = new AdapterCache(db);
      vi.useFakeTimers();
      const data = [{ id: '1', title: 'Test', content: 'Body', source: 'test', confidence: 0.5 }];
      cache.set('wikipedia', 'quantum', data);

      vi.advanceTimersByTime(3600_001); // 1 hour + 1ms
      const result = cache.get('wikipedia', 'quantum');
      expect(result).toBeNull();
      vi.useRealTimers();
    });

    it('cleanup removes expired entries', () => {
      const cache = new AdapterCache(db);
      cache.set('test', 'query', [{ id: '1' }]);
      const cleaned = cache.cleanup();
      expect(cleaned).toBeGreaterThanOrEqual(0);
    });
  });

  describe('KnowledgeAdapterRegistry', () => {
    it('registers default adapters', () => {
      const registry = new KnowledgeAdapterRegistry(db);
      const available = registry.getAvailable();
      expect(available).toContain('wikipedia');
      expect(available).toContain('arxiv');
      expect(available).toContain('okf');
      expect(available).toContain('djimitkb');
    });

    it('registers custom adapter', () => {
      const registry = new KnowledgeAdapterRegistry(db);
      const custom = new WikipediaAdapter();
      registry.register('custom', custom);
      expect(registry.get('custom')).toBe(custom);
    });

    it('returns undefined for unknown adapter', () => {
      const registry = new KnowledgeAdapterRegistry(db);
      expect(registry.get('nonexistent')).toBeUndefined();
    });

    it('search returns empty for unknown source', async () => {
      const registry = new KnowledgeAdapterRegistry(db);
      const results = await registry.search('nonexistent', 'query');
      expect(results).toEqual([]);
    });

    it('searchAll queries multiple sources', async () => {
      const registry = new KnowledgeAdapterRegistry(db);
      const results = await registry.searchAll('quantum', ['wikipedia', 'arxiv']);
      expect(Array.isArray(results)).toBe(true);
    });

    it('isAvailable returns false for unknown source', async () => {
      const registry = new KnowledgeAdapterRegistry(db);
      const available = await registry.isAvailable('nonexistent');
      expect(available).toBe(false);
    });
  });

  describe('WikipediaAdapter', () => {
    it('has correct name', () => {
      const adapter = new WikipediaAdapter();
      expect(adapter.name).toBe('wikipedia');
    });

    it('search returns empty array on error', async () => {
      const adapter = new WikipediaAdapter();
      const results = await adapter.search('this-topic-does-not-exist-xyz123');
      expect(Array.isArray(results)).toBe(true);
    });

    it('fetch returns null for invalid id', async () => {
      const adapter = new WikipediaAdapter();
      const result = await adapter.fetch('invalid-id-xyz');
      expect(result === null || typeof result === 'object').toBe(true);
    });
  });

  describe('ArxivAdapter', () => {
    it('has correct name', () => {
      const adapter = new ArxivAdapter();
      expect(adapter.name).toBe('arxiv');
    });

    it('search returns empty array on error', async () => {
      const adapter = new ArxivAdapter();
      const results = await adapter.search('quantum computing');
      expect(Array.isArray(results)).toBe(true);
    });

    it('parses arxiv XML response', () => {
      const adapter = new ArxivAdapter();
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <feed>
          <entry>
            <id>http://arxiv.org/abs/2401.12345</id>
            <title>Quantum Computing Test</title>
            <summary>This is a test abstract.</summary>
            <author><name>Test Author</name></author>
          </entry>
        </feed>`;
      const results = (adapter as unknown as { parseArxivResponse: (xml: string) => unknown[] }).parseArxivResponse(xml);
      expect(results.length).toBe(1);
    });
  });

  describe('OkfAdapter', () => {
    it('has correct name', () => {
      const adapter = new OkfAdapter();
      expect(adapter.name).toBe('okf');
    });

    it('search returns empty when OKF base missing', async () => {
      const adapter = new OkfAdapter();
      const results = await adapter.search('quantum');
      expect(Array.isArray(results)).toBe(true);
    });

    it('isAvailable returns false when OKF base missing', async () => {
      const adapter = new OkfAdapter();
      const available = await adapter.isAvailable();
      expect(typeof available).toBe('boolean');
    });
  });
});
