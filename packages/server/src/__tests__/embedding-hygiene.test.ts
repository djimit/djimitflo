import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { VectorMemoryService } from '../services/vector-memory-service';
import { ingestKbPages, kbContext } from '../services/kb-corpus';
import { embeddingDimMismatch, resetEmbeddingDimMismatch } from '../services/embedding-dims';
import { buildEvolutionEvidence } from '../services/evolution-evidence';

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = ON'); resetEmbeddingDimMismatch(); });
afterEach(() => { vi.unstubAllEnvs(); db.close(); });

/** A provider whose dimension can change between calls (a model switch mid-life). */
const provider = (dim: { n: number }) => ({ name: 'test:embed', embed: async (t: string) => Array.from({ length: dim.n }, (_, i) => ((t.length + i) % 7) / 7 + 0.1) });

it('UX-21: new vector-memory writes carry the embedding dimension', async () => {
  const svc = new VectorMemoryService(db, provider({ n: 4 }));
  await svc.storeMemory({ content: 'retry budgets bound backoff' });
  expect(db.prepare('SELECT embedding_provider AS m, embedding_dim AS d FROM vector_memories').get()).toEqual({ m: 'test:embed', d: 4 });
});

it('UX-21: default mode keeps resampling a mismatched vector but counts the mismatch', async () => {
  const dim = { n: 4 };
  const svc = new VectorMemoryService(db, provider(dim));
  await svc.storeMemory({ content: 'retry budgets bound backoff' });
  dim.n = 8; // the query embedding now has another dimension
  const hits = await svc.search('retry budgets with backoff', 5, 0);
  expect(hits).toHaveLength(1); // unchanged: still scored (resampled)
  expect(embeddingDimMismatch()).toEqual({ vector_memories: 1 });
});

it('UX-21: strict mode refuses a mismatched vector instead of resampling it', async () => {
  vi.stubEnv('VECTOR_STRICT_DIM', 'true');
  const dim = { n: 4 };
  const svc = new VectorMemoryService(db, provider(dim));
  await svc.storeMemory({ content: 'retry budgets bound backoff' });
  dim.n = 8;
  expect(await svc.search('retry budgets with backoff', 5, 0)).toEqual([]);
  expect(embeddingDimMismatch()).toEqual({ vector_memories: 1 });
});

it('UX-21: KB pages store model + dim, a mismatched page is counted and never retrieved, and the evidence shows the counter', async () => {
  vi.stubEnv('NVIDIA_API_KEY', 'k'); vi.stubEnv('KB_CONTEXT_ENABLED', 'true');
  let dims = 2;
  const fake = vi.fn(async (url: string) => (String(url).endsWith('/embeddings')
    ? { ok: true, json: async () => ({ data: [{ embedding: Array.from({ length: dims }, () => 1) }] }) }
    : { ok: true, json: async () => ({ choices: [{ message: { content: 'User Safety: safe' } }] }) })) as unknown as typeof fetch;
  await ingestKbPages(db, 'workstation', [{ path: 'concepts/retry.md', title: 'Retry', body: 'retry backoff' }], fake);
  expect(db.prepare('SELECT embedding_model AS m, embedding_dim AS d FROM kb_pages').get()).toEqual({ m: 'nvidia/nemotron-3-embed-1b', d: 2 });
  dims = 3;
  expect(await kbContext(db, { type: 'panel', id: 'p1' }, 'retry', 3, fake)).toBeNull();
  expect(embeddingDimMismatch()).toEqual({ kb_pages: 1 });
  expect(buildEvolutionEvidence(db, {}, Date.now()).embedding_dim_mismatch).toEqual({ strict: false, by_store: { kb_pages: 1 } });
});
