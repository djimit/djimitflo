import { createHash } from 'crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { RemoteGymService } from '../services/remote-gym-service';
import { buildEvolutionEvidence, EVOLUTION_FLAGS } from '../services/evolution-evidence';

// Phase SOUP baseline 09-10: the worker sends result.diff but nothing stored it — 0 (task, diff, oracle result) pairs.
const TASK = (commit: string) => ({ commit, source: 'packages/server/src/services/x.ts', tests: ['packages/server/src/__tests__/x.test.ts'], sourceLines: 5 });
const DIFF = 'diff --git a/packages/server/src/services/x.ts b/packages/server/src/services/x.ts\n-export const x = 1;\n+export const x = 2;\n';
let db: Database.Database; let svc: RemoteGymService;
beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  vi.stubEnv('EVOLUTION_GYM_REMOTE_ENABLED', 'true'); vi.stubEnv('LOOP_DAEMON_REPOSITORY_PATH', '/repo'); vi.stubEnv('GYM_STORE_DIFFS', 'true');
  svc = new RemoteGymService(db, () => [TASK('c1'), TASK('c2'), TASK('c3'), TASK('c4')]);
});
afterEach(() => { vi.unstubAllEnvs(); db.close(); });
const claim = () => (svc.claim('workstation', ['atomic']) as { runId: string }).runId;
const rows = () => db.prepare('SELECT run_id, task_key, status, sha256, diff, redacted FROM gym_attempt_diffs ORDER BY created_at, task_key').all() as Array<{ run_id: string; task_key: string; status: string; sha256: string; diff: string; redacted: number }>;

it('stores the diff of a scored attempt (success and failure) with its sha256 and a diff_ref on the run', () => {
  const a = claim(); svc.record(a, 'workstation', { status: 'success', reason: 'tests green, source only', diff: DIFF });
  const b = claim(); svc.record(b, 'workstation', { status: 'failure', reason: 'tests still red', diff: `${DIFF}+// more\n` });
  const stored = rows();
  expect(stored.map((r) => [r.run_id, r.task_key, r.status])).toEqual([[a, 'c1', 'success'], [b, 'c2', 'failure']]);
  expect(stored[0].diff).toBe(DIFF);
  expect(stored[0].sha256).toBe(createHash('sha256').update(DIFF).digest('hex'));
  expect(stored[0].redacted).toBe(0);
  const result = JSON.parse((db.prepare("SELECT json_extract(metadata, '$.gym_result') AS r FROM loop_runs WHERE id = ?").get(a) as { r: string }).r);
  expect(result.diff_ref).toBe(`sha256:${stored[0].sha256}`);
  expect(result.diff).toBeUndefined(); // the diff lives in the table, not in loop_runs.metadata
});

it('redacts secrets before storing and caps the stored diff at 50 KB', () => {
  const key = `ghp_${'a'.repeat(36)}`;
  const a = claim(); svc.record(a, 'workstation', { status: 'failure', reason: 'tests still red', diff: `${DIFF}+const token = "${key}";\n${'+x\n'.repeat(40_000)}` });
  const [row] = rows();
  expect(row.diff).not.toContain(key);
  expect(row.diff).toContain('[REDACTED:');
  expect(row.redacted).toBeGreaterThan(0);
  expect(Buffer.byteLength(row.diff, 'utf8')).toBeLessThanOrEqual(50_000);
  expect(row.sha256).toBe(createHash('sha256').update(row.diff).digest('hex'));
});

it('a discarded attempt, an attempt without a diff and the flag off store nothing', () => {
  svc.record(claim(), 'workstation', { status: 'discarded', reason: 'infra: npm ci failed', diff: DIFF });
  svc.record(claim(), 'workstation', { status: 'failure', reason: 'no change' });
  vi.stubEnv('GYM_STORE_DIFFS', 'false');
  svc.record(claim(), 'workstation', { status: 'success', reason: 'tests green, source only', diff: DIFF });
  expect(rows()).toEqual([]);
  expect(db.prepare("SELECT COUNT(*) AS n FROM loop_runs WHERE json_extract(metadata, '$.gym_result.diff_ref') IS NOT NULL").get()).toEqual({ n: 0 });
});

it('evolution evidence counts the stored pairs; GYM_STORE_DIFFS is a documented non-acting flag', () => {
  svc.record(claim(), 'workstation', { status: 'success', reason: 'tests green, source only', diff: DIFF });
  svc.record(claim(), 'workstation', { status: 'failure', reason: 'tests still red', diff: DIFF });
  svc.record(claim(), 'workstation', { status: 'failure', reason: 'tests still red', diff: `${DIFF}+y\n` });
  expect(buildEvolutionEvidence(db, process.env).gym_diffs).toEqual({ enabled: true, stored: 3, distinct_tasks: 3, successes: 1, failures: 2, redacted_attempts: 0 });
  expect(EVOLUTION_FLAGS).toContainEqual({ name: 'GYM_STORE_DIFFS', acting: false });
});
