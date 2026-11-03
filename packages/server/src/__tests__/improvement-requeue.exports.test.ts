import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { copyEmbedding } from '../services/improvement-requeue';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(schema);
  runMigrations(db);
});

afterEach(() => db.close());

const seedEmbedding = (id: string, vector: Float32Array, dim: number, model = 'nvidia/nemotron-3-embed-1b', createdAt = '2026-09-01T00:00:00Z') => {
  db.exec('CREATE TABLE IF NOT EXISTS proposal_embeddings (proposal_id TEXT PRIMARY KEY, model TEXT NOT NULL, vector BLOB NOT NULL, created_at TEXT NOT NULL)');
  const cols = (db.prepare('PRAGMA table_info(proposal_embeddings)').all() as Array<{ name: string }>).map((c) => c.name);
  if (!cols.includes('embedding_dim')) db.exec('ALTER TABLE proposal_embeddings ADD COLUMN embedding_dim INTEGER');
  db.prepare('INSERT OR REPLACE INTO proposal_embeddings (proposal_id, model, vector, created_at, embedding_dim) VALUES (?, ?, ?, ?, ?)').run(
    id, model, Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength), createdAt, dim,
  );
};

it('copies the original embedding to the requeued copy and returns true', () => {
  const vec = Float32Array.of(0.1, 0.2, 0.3, 0.4);
  seedEmbedding('orig', vec, vec.length);
  const now = '2026-10-11T00:00:00Z';
  const ok = copyEmbedding(db, 'orig', 'copy', now);
  expect(ok).toBe(true);
  const row = db.prepare('SELECT proposal_id, model, vector, created_at, embedding_dim FROM proposal_embeddings WHERE proposal_id = ?').get('copy') as
    { proposal_id: string; model: string; vector: Buffer; created_at: string; embedding_dim: number };
  expect(row.model).toBe('nvidia/nemotron-3-embed-1b');
  expect(row.created_at).toBe(now);
  expect(row.embedding_dim).toBe(vec.length);
  expect(Array.from(new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4))).toEqual(Array.from(vec));
});

it('returns false when the original has no embedding', () => {
  const ok = copyEmbedding(db, 'missing', 'copy');
  expect(ok).toBe(false);
  expect(db.prepare('SELECT COUNT(*) n FROM proposal_embeddings WHERE proposal_id = ?').get('copy')).toEqual({ n: 0 });
});

it('does not overwrite an existing embedding for the target (INSERT OR IGNORE)', () => {
  const origVec = Float32Array.of(1, 0, 0);
  seedEmbedding('orig', origVec, origVec.length);
  const copyVec = Float32Array.of(0, 1, 0);
  seedEmbedding('copy', copyVec, copyVec.length);
  const ok = copyEmbedding(db, 'orig', 'copy');
  expect(ok).toBe(false);
  const row = db.prepare('SELECT vector FROM proposal_embeddings WHERE proposal_id = ?').get('copy') as { vector: Buffer };
  const stored = Array.from(new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4));
  expect(stored).toEqual(Array.from(copyVec));
});

it('creates the proposal_embeddings table when it does not yet exist', () => {
  expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='proposal_embeddings'").get()).toBeUndefined();
  copyEmbedding(db, 'orig', 'copy');
  expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='proposal_embeddings'").get()).toEqual({ name: 'proposal_embeddings' });
});

it('returns false and swallows errors when the database call fails', () => {
  const broken = { prepare: () => { throw new Error('boom'); }, exec: () => { throw new Error('boom'); } } as unknown as Database.Database;
  const ok = copyEmbedding(broken, 'orig', 'copy');
  expect(ok).toBe(false);
});