/**
 * L-F06 / L-F07 (forensic audit 2026-10-26, roadmap rank 6):
 * - an expired vector memory is unreadable through every supported read path;
 * - a delete removes the durable row regardless of cache state, and a restart does not revive it;
 * - duplicate unconfirmed evidence does not raise a curated memory's confidence.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { VectorMemoryService } from '../services/vector-memory-service';
import { MemoryCurator, type RawEpisode } from '../services/memory-curator';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { TestEmbeddingProvider } from './helpers/test-embedding-provider';

const EXPIRED_AT = '2000-01-01T00:00:00.000Z';

describe('L-F06: vector memory TTL and deletion', () => {
  let db: Database.Database;
  let service: VectorMemoryService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    service = new VectorMemoryService(db, new TestEmbeddingProvider());
  });
  afterEach(() => db.close());

  async function storeExpired(content: string) {
    const mem = await service.storeMemory({ content, ttl: 1 });
    mem.createdAt = EXPIRED_AT; // the cached object is the one the service holds
    db.prepare('UPDATE vector_memories SET created_at = ? WHERE id = ?').run(EXPIRED_AT, mem.id);
    return mem;
  }

  it('does not return an expired memory from a direct read', async () => {
    const mem = await storeExpired('typescript expired memory');
    expect(service.getMemory(mem.id)).toBeNull();
  });

  it('does not return an expired memory after a restart', async () => {
    const mem = await storeExpired('typescript expired memory');
    const restarted = new VectorMemoryService(db, new TestEmbeddingProvider());
    expect(restarted.getMemory(mem.id)).toBeNull();
    expect(await restarted.search('typescript', 10, 0)).toEqual([]);
  });

  it('excludes expired memories from search, clusters and stats', async () => {
    await storeExpired('typescript expired one');
    await storeExpired('typescript expired two');
    const live = await service.storeMemory({ content: 'python live memory' });

    // stats and clusters first: on the pre-fix code only search() evicted expired items from the cache
    const stats = service.getStats();
    expect(stats.totalMemories).toBe(1);
    expect(stats.oldestMemory).toBe(live.id);
    expect(await service.getClusters(0)).toEqual([]);
    expect((await service.search('typescript', 10, 0)).map((r) => r.id)).toEqual([live.id]);
  });

  it('still returns a memory whose TTL has not elapsed', async () => {
    const mem = await service.storeMemory({ content: 'typescript fresh', ttl: 3600 });
    expect(service.getMemory(mem.id)?.content).toBe('typescript fresh');
  });

  it('deletes the durable row even after search evicted the expired item from cache', async () => {
    const mem = await storeExpired('typescript expired memory');
    await service.search('typescript', 10, 0);
    expect(service.deleteMemory(mem.id)).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM vector_memories WHERE id = ?').get(mem.id)).toEqual({ n: 0 });
  });

  it('deletes a row that was never loaded into this instance cache', async () => {
    const mem = await service.storeMemory({ content: 'typescript other instance' });
    // a second instance with a different embedding provider never loads this row into its cache
    const other = new VectorMemoryService(db, { name: 'test:other', embed: async () => [1, 0] });
    expect(other.deleteMemory(mem.id)).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM vector_memories WHERE id = ?').get(mem.id)).toEqual({ n: 0 });
    // the original instance must not keep serving the deleted row from its cache
    expect(service.getMemory(mem.id)).toBeNull();
  });

  it('drops a row deleted through another instance from search, clusters and stats', async () => {
    const a = await service.storeMemory({ content: 'typescript deleted elsewhere one' });
    const b = await service.storeMemory({ content: 'typescript deleted elsewhere two' });
    const other = new VectorMemoryService(db, new TestEmbeddingProvider());
    expect(other.deleteMemory(a.id)).toBe(true);
    expect(other.deleteMemory(b.id)).toBe(true);
    // no getMemory() first: that path reconciles on its own and would hide a stale cache
    expect(service.getStats().totalMemories).toBe(0);
    expect(await service.getClusters(0)).toEqual([]);
    expect(await service.search('typescript', 10, 0)).toEqual([]);
  });

  it('deletes a memory that has feedback rows and a restart does not revive it', async () => {
    const mem = await service.storeMemory({ content: 'typescript with feedback' });
    service.recordFeedback(mem.id, 1);
    expect(service.deleteMemory(mem.id)).toBe(true);
    const restarted = new VectorMemoryService(db, new TestEmbeddingProvider());
    expect(restarted.getMemory(mem.id)).toBeNull();
    expect(await restarted.search('typescript', 10, 0)).toEqual([]);
  });

  it('reports false when deleting an unknown id', () => {
    expect(service.deleteMemory('mem-unknown')).toBe(false);
  });
});

describe('L-F07: duplicate unconfirmed evidence', () => {
  let db: Database.Database;
  let curator: MemoryCurator;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    curator = new MemoryCurator(db);
  });
  afterEach(() => db.close());

  const content = Array.from({ length: 30 }, (_, i) => `unverified-statement-${i}`).join(' ');
  const episode = (id: string, source = 'audit-source'): RawEpisode => ({
    id, type: 'episode', source, timestamp: '2026-10-26T00:00:00Z', content,
    // verified episodes carry no metadata so their initial confidence (0.9) stays below the 1.0 cap
    metadata: source.startsWith('verified:') ? undefined : { synthetic: true },
  });

  it('does not raise confidence when the same episode is curated again', () => {
    const initial = curator.curate(episode('same-episode')).record;
    let latest = initial;
    for (let i = 0; i < 5; i++) latest = curator.curate(episode('same-episode')).record;
    expect(latest.id).toBe(initial.id);
    expect(latest.confidence).toBe(initial.confidence);
    // re-ingesting the same episode must not grow the content either
    expect(latest.content).toBe(initial.content);
  });

  it('does not raise confidence for distinct but unverified repeats from the same source', () => {
    const initial = curator.curate(episode('ep-1')).record;
    let latest = initial;
    for (let i = 2; i <= 6; i++) latest = curator.curate(episode(`ep-${i}`)).record;
    expect(latest.confidence).toBe(initial.confidence);
    const row = db.prepare('SELECT confidence, metadata_json FROM central_memories WHERE id = ?')
      .get(initial.id) as { confidence: number; metadata_json: string };
    expect(row.confidence).toBe(initial.confidence);
    // provenance of every merged episode is preserved
    expect(JSON.parse(row.metadata_json).episodeIds).toEqual(['ep-1', 'ep-2', 'ep-3', 'ep-4', 'ep-5', 'ep-6']);
  });

  it('does not raise confidence for identical fresh-id replays from a verified-labelled source', () => {
    const initial = curator.curate(episode('v-1', 'verified:audit')).record;
    let latest = initial;
    for (let i = 2; i <= 4; i++) latest = curator.curate(episode(`v-${i}`, 'verified:audit')).record;
    expect(latest.id).toBe(initial.id);
    expect(latest.confidence).toBe(initial.confidence);
    expect(latest.content).toBe(initial.content);
  });

  it('keeps a contradictory update visible without changing confidence', () => {
    const initial = curator.curate(episode('c-1', 'verified:audit')).record;
    // same source, high word overlap, one statement negated
    const contradiction = content.replace('unverified-statement-0', 'NOT-unverified-statement-0');
    const merged = curator.curate({ ...episode('c-2', 'verified:audit'), content: contradiction }).record;
    expect(merged.id).toBe(initial.id);
    expect(merged.content).toContain(initial.content);
    expect(merged.content).toContain('NOT-unverified-statement-0');
    expect(merged.confidence).toBe(initial.confidence);
  });
});
