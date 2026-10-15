import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { MemoryCurator, type RawEpisode } from '../services/memory-curator';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let curator: MemoryCurator;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  curator = new MemoryCurator(db);
});

afterEach(() => { db?.close(); });

function ep(overrides: Partial<RawEpisode> & { id: string }): RawEpisode {
  return {
    type: 'episode',
    content: 'Test episode content',
    source: 'test',
    timestamp: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('G121: MemoryCurator', () => {
  describe('curate – new record', () => {
    it('stores a new episode with a generated id', () => {
      const result = curator.curate(ep({ id: 'ep-1', content: 'Test episode content' }));
      expect(result.isNew).toBe(true);
      expect(result.mergedWith).toBeUndefined();
      expect(result.record.id).toBeDefined();
      expect(typeof result.record.id).toBe('string');
      expect(result.record.createdAt).toBeDefined();
    });

    it('preserves episode metadata with originalId and timestamp', () => {
      const result = curator.curate(ep({
        id: 'ep-meta',
        content: 'Test',
        metadata: { custom: 'val', n: 7 },
      }));
      expect(result.record.metadata.custom).toBe('val');
      expect(result.record.metadata.n).toBe(7);
      expect(result.record.metadata.originalId).toBe('ep-meta');
      expect(result.record.metadata.timestamp).toBe('2024-01-01T00:00:00Z');
    });
  });

  describe('classifyType', () => {
    it('classifies skill type', () => {
      const result = curator.curate(ep({ id: 'ep-s', type: 'skill_episode', content: 'Skill' }));
      expect(result.record.type).toBe('skill');
    });

    it('classifies episode type', () => {
      const result = curator.curate(ep({ id: 'ep-e', type: 'episode', content: 'Episode' }));
      expect(result.record.type).toBe('episode');
    });

    it('classifies relation type', () => {
      const result = curator.curate(ep({ id: 'ep-r', type: 'relation_node', content: 'Relation' }));
      expect(result.record.type).toBe('relation');
    });

    it('classifies projection type', () => {
      const result = curator.curate(ep({ id: 'ep-p', type: 'projection_layer', content: 'Projection' }));
      expect(result.record.type).toBe('projection');
    });

    it('defaults to observation for unknown type', () => {
      const result = curator.curate(ep({ id: 'ep-o', type: 'unknown', content: 'Unknown' }));
      expect(result.record.type).toBe('observation');
    });
  });

  describe('calculateConfidence', () => {
    it('returns base 0.5 for short content without metadata or verified source', () => {
      const result = curator.curate(ep({ id: 'c0', content: 'x', source: 'test' }));
      expect(result.record.confidence).toBeCloseTo(0.5, 10);
    });

    it('does not add bonus for content length exactly 100', () => {
      const result = curator.curate(ep({ id: 'c100', content: 'x'.repeat(100), source: 'test' }));
      expect(result.record.confidence).toBeCloseTo(0.5, 10);
    });

    it('adds 0.1 for content length > 100', () => {
      const result = curator.curate(ep({ id: 'c101', content: 'x'.repeat(101), source: 'test' }));
      expect(result.record.confidence).toBeCloseTo(0.6, 10);
    });

    it('does not add bonus for content length exactly 500', () => {
      const result = curator.curate(ep({ id: 'c500', content: 'x'.repeat(500), source: 'test' }));
      expect(result.record.confidence).toBeCloseTo(0.6, 10);
    });

    it('adds 0.1 for content length > 500', () => {
      const result = curator.curate(ep({ id: 'c501', content: 'x'.repeat(501), source: 'test' }));
      expect(result.record.confidence).toBeCloseTo(0.7, 10);
    });

    it('adds 0.1 for non-empty metadata', () => {
      const result = curator.curate(ep({ id: 'cmeta', content: 'x'.repeat(101), source: 'test', metadata: { k: 1 } }));
      expect(result.record.confidence).toBeCloseTo(0.7, 10);
    });

    it('does not add bonus for empty metadata', () => {
      const result = curator.curate(ep({ id: 'cempty', content: 'x'.repeat(101), source: 'test', metadata: {} }));
      expect(result.record.confidence).toBeCloseTo(0.6, 10);
    });

    it('adds 0.2 for verified source', () => {
      const result = curator.curate(ep({ id: 'cver', content: 'x'.repeat(101), source: 'verified:test' }));
      expect(result.record.confidence).toBeCloseTo(0.8, 10);
    });

    it('does not add verified bonus for non-verified source', () => {
      const result = curator.curate(ep({ id: 'cnover', content: 'x'.repeat(101), source: 'verifi:test' }));
      expect(result.record.confidence).toBeCloseTo(0.6, 10);
    });

    it('caps confidence at 1.0', () => {
      const result = curator.curate(ep({
        id: 'ccap',
        content: 'x'.repeat(501),
        source: 'verified:test',
        metadata: { k: 1 },
      }));
      expect(result.record.confidence).toBeLessThanOrEqual(1);
      expect(result.record.confidence).toBeCloseTo(1, 5);
    });
  });

  describe('curate – merge', () => {
    it('merges similar episode with high-confidence existing record', () => {
      const first = curator.curate(ep({
        id: 'm1',
        content: 'alpha beta gamma delta epsilon '.repeat(4),
        source: 'verified:test',
      }));
      const second = curator.curate(ep({
        id: 'm2',
        content: 'alpha beta gamma delta epsilon',
        source: 'verified:test',
        timestamp: '2024-01-02T00:00:00Z',
      }));
      expect(second.isNew).toBe(false);
      expect(second.mergedWith).toBe(first.record.id);
      expect(second.record.id).toBe(first.record.id);
      expect(second.record.content).toBe(
        first.record.content + '\n\n--- Update ---\n\n' + 'alpha beta gamma delta epsilon',
      );
      expect(second.record.confidence).toBeCloseTo(0.85, 10);
    });

    it('updates the database row on merge', () => {
      const first = curator.curate(ep({
        id: 'm3',
        content: 'alpha beta gamma delta epsilon '.repeat(4),
        source: 'verified:test',
      }));
      curator.curate(ep({
        id: 'm4',
        content: 'alpha beta gamma delta epsilon',
        source: 'verified:test',
        timestamp: '2024-01-02T00:00:00Z',
      }));
      const row = db.prepare(
        'SELECT content, confidence, metadata_json FROM central_memories WHERE id = ?',
      ).get(first.record.id) as { content: string; confidence: number; metadata_json: string };
      expect(row.confidence).toBeCloseTo(0.85, 10);
      expect(row.content).toContain('--- Update ---');
      expect(row.content).toContain('alpha beta gamma delta epsilon');
      const meta = JSON.parse(row.metadata_json);
      expect(meta.lastMerge).toBe('2024-01-02T00:00:00Z');
    });

    it('does not merge when existing confidence is exactly 0.7', () => {
      curator.curate(ep({ id: 'm5', content: 'word '.repeat(101), source: 'test' }));
      const second = curator.curate(ep({ id: 'm6', content: 'word '.repeat(101), source: 'test' }));
      expect(second.isNew).toBe(true);
    });

    it('does not merge when similarity is exactly 0.8', () => {
      curator.curate(ep({
        id: 'm7',
        content: 'one two three four five '.repeat(5),
        source: 'verified:test',
      }));
      const second = curator.curate(ep({
        id: 'm8',
        content: 'one two three four',
        source: 'verified:test',
      }));
      expect(second.isNew).toBe(true);
    });

    it('does not merge when sources differ', () => {
      curator.curate(ep({ id: 'm9', content: 'same content here', source: 'src-a' }));
      const second = curator.curate(ep({ id: 'm10', content: 'same content here', source: 'src-b' }));
      expect(second.isNew).toBe(true);
    });

    it('does not merge when content is dissimilar', () => {
      curator.curate(ep({ id: 'm11', content: 'completely unique words foo', source: 'test' }));
      const second = curator.curate(ep({ id: 'm12', content: 'totally different bar baz', source: 'test' }));
      expect(second.isNew).toBe(true);
    });

    it('performs case-insensitive similarity matching', () => {
      curator.curate(ep({
        id: 'm13',
        content: 'Hello World '.repeat(10).trim(),
        source: 'verified:test',
      }));
      const second = curator.curate(ep({
        id: 'm14',
        content: 'hello world',
        source: 'verified:test',
      }));
      expect(second.isNew).toBe(false);
    });
  });

  describe('curateBatch', () => {
    it('curates each episode independently', () => {
      const results = curator.curateBatch([
        ep({ id: 'b1', content: 'Batch one', source: 'batch-a' }),
        ep({ id: 'b2', content: 'Batch two', source: 'batch-b' }),
      ]);
      expect(results).toHaveLength(2);
      expect(results[0].record.content).toBe('Batch one');
      expect(results[1].record.content).toBe('Batch two');
      expect(results[0].record.id).not.toBe(results[1].record.id);
    });
  });

  describe('getEpisodes', () => {
    it('returns only episode-type records', () => {
      curator.curate(ep({ id: 'g1', type: 'skill', content: 'Skill content', source: 'src-s' }));
      curator.curate(ep({ id: 'g2', type: 'episode', content: 'Episode content', source: 'src-e' }));
      const episodes = curator.getEpisodes(10);
      expect(episodes).toHaveLength(1);
      expect(episodes[0].type).toBe('episode');
    });

    it('defaults to limit 50', () => {
      for (let i = 0; i < 51; i++) {
        curator.curate(ep({
          id: `l${i}`,
          content: `unique content number ${i}`,
          source: `src-${i}`,
        }));
      }
      expect(curator.getEpisodes()).toHaveLength(50);
    });
  });
});