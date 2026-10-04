import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { checkProposalDuplicate, cosine } from '../services/proposal-dedupe';

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); });
afterEach(() => { vi.unstubAllEnvs(); db.close(); });
const vec = (v: number[]) => vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ embedding: v }] }) }) as unknown as typeof fetch;

it('cosine', () => {
  expect(cosine(Float32Array.from([1, 0]), Float32Array.from([1, 0]))).toBeCloseTo(1);
  expect(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBeCloseTo(0);
});

it('records a near-duplicate as a shadow judgment only; off by default; fail-open', async () => {
  const f = vec([1, 0, 0]);
  expect(await checkProposalDuplicate(db, { id: 'a', title: 't', description: 'd' }, f)).toBeNull();
  expect(f).not.toHaveBeenCalled();
  vi.stubEnv('PROPOSAL_DEDUPE_MODE', 'shadow'); vi.stubEnv('NVIDIA_API_KEY', 'k');
  expect(await checkProposalDuplicate(db, { id: 'a', title: 't', description: 'd' }, f)).toBeNull(); // first one: nothing to compare
  expect(await checkProposalDuplicate(db, { id: 'b', title: 't2', description: 'd' }, vec([0, 1, 0]))).toBeNull(); // unrelated
  const dup = await checkProposalDuplicate(db, { id: 'c', title: 't', description: 'd again' }, vec([0.99, 0.05, 0]));
  expect(dup?.id).toBe('a');
  expect(db.prepare('SELECT judgment, subject_id, mode, decision FROM judgments').all()).toEqual([{ judgment: 'proposal_near_duplicate', subject_id: 'c', mode: 'shadow', decision: 'yes' }]);
  expect(await checkProposalDuplicate(db, { id: 'd', title: 'x', description: 'y' }, vi.fn().mockRejectedValue(new Error('down')) as unknown as typeof fetch)).toBeNull();
});

it('does not flag a refinement as a duplicate of its parent (lineage, not duplication)', async () => {
  vi.stubEnv('PROPOSAL_DEDUPE_MODE', 'shadow'); vi.stubEnv('NVIDIA_API_KEY', 'k');
  db.pragma('foreign_keys = OFF');
  const ins = db.prepare("INSERT INTO self_improvements (id, type, title, description, rationale, source, status, evidence_refs_json, created_at, updated_at) VALUES (?, 'code', 't', 'd', 'r', ?, 'needs_grounding', ?, datetime('now'), datetime('now'))");
  ins.run('parent', 'reflection', '[]'); ins.run('child', 'refinement', '["refinement-of:parent"]');
  await checkProposalDuplicate(db, { id: 'parent', title: 't', description: 'd' }, vec([1, 0]));
  expect(await checkProposalDuplicate(db, { id: 'child', title: 't', description: 'd' }, vec([1, 0]))).toBeNull();
  expect(db.prepare("SELECT COUNT(*) n FROM judgments WHERE judgment = 'proposal_near_duplicate'").get()).toEqual({ n: 0 });
});
