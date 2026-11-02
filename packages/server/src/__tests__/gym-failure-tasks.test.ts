import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { failureDerivedTasks, failureTaskEvidence, qualifyingFailures, failureRows, targetMutants, WRITE_TEST_MUTANTS, type FailureTask, type GitLookup } from '../services/gym-failure-tasks';
import { RemoteGymService } from '../services/remote-gym-service';
import { holdout, mutantHoldoutKeys } from '../services/genome-registry';

const BASE = 'a'.repeat(40);
const TARGET_SRC = "export function clamp(n: number, max: number): number {\n  if (n > max) return max;\n  return n >= 0 ? n : 0;\n}\nexport const on = (x: string) => x === 'on' && true;\n";
const lookup: GitLookup = {
  baseAt: () => BASE,
  exists: (_c, f) => f.includes('/services/'), // target exists at base, the test artifact does not
  show: () => TARGET_SRC,
};
let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = ON'); });
afterEach(() => { vi.unstubAllEnvs(); db.close(); });

function proposal(id: string, status: string, ref: string, g: Record<string, string>, changed: string[] = [`packages/server/src/__tests__/${id}.test.ts`]) {
  db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, evidence_refs_json, grounding_json, created_at, updated_at)
    VALUES (?, 'feature', 't', 'd', 'r', 'gap_analysis', ?, ?, ?, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`).run(id, status, JSON.stringify([ref]), JSON.stringify(g));
  db.prepare(`INSERT INTO goals (id, objective, constraints_json, acceptance_criteria_json, risk_class, budget_json, status, improvement_id, created_at, updated_at)
    VALUES (?, 'o', '[]', '[]', 'low', '{}', 'failed', ?, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`).run(`g-${id}`, id);
  db.prepare(`INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES (?, ?, 'doc-drift-and-small-fix-loop', 'closed', 'completed', '[]', '{}', '[]', '[]', '{}', '2026-10-01T01:00:00Z', '2026-10-01T02:00:00Z')`).run(`r-${id}`, `g-${id}`);
  db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES (?, ?, 'maker', 'opencode', 'failed', ?, datetime('now'), datetime('now'))`)
    .run(`l-${id}`, `r-${id}`, JSON.stringify({ changed_files: changed }));
}
const grounding = (svc: string, kind = 'test') => ({
  target: `packages/server/src/services/${svc}.ts`, artifactPath: `packages/server/src/__tests__/${svc}.${kind}.ts`,
  runtimeCommand: `npx vitest run src/__tests__/${svc}.${kind}.ts`,
});

it('B8-FAIL: a regressed test-gap / exports proposal becomes a write_test task at the run base with the target and the one-command oracle', () => {
  proposal('p1', 'regressed', 'test-gap:widget', grounding('widget'));
  proposal('p2', 'regressed', 'test-gap:gadget#exports', grounding('gadget', 'exports.test'));
  const tasks = failureDerivedTasks(db, lookup);
  expect(tasks).toHaveLength(2);
  expect(tasks.find((t) => t.run_id === 'r-p1')).toMatchObject({
    commit: 'fail:r-p1', kind: 'write_test', base: BASE, lane: 'test-gap', target: 'packages/server/src/services/widget.ts',
    source: 'packages/server/src/__tests__/widget.test.ts', tests: ['packages/server/src/__tests__/widget.test.ts'], sourceLines: 6,
  });
  expect(tasks.find((t) => t.run_id === 'r-p2')?.lane).toBe('exports');
});

it('B8-FAIL: infra_failed, no_change and parked proposals are skipped; so are mutation lanes and non-deterministic oracles', () => {
  proposal('p1', 'infra_failed', 'test-gap:a', grounding('a'));
  proposal('p2', 'no_change', 'test-gap:b', grounding('b'));
  proposal('p3', 'needs_more_evidence', 'test-gap:c', grounding('c'));
  proposal('p4', 'regressed', 'mutation-gap:d', grounding('d'));
  proposal('p5', 'regressed', 'test-gap:e', { ...grounding('e'), runtimeCommand: 'npm test && curl http://x' });
  expect(failureDerivedTasks(db, lookup)).toEqual([]);
});

it('B8-FAIL: a run that touched auth/secret paths, or a sensitive target, is never replayed; a gap already closed at the base is skipped', () => {
  proposal('p1', 'regressed', 'test-gap:widget', grounding('widget'), ['packages/server/src/middleware/auth.ts']);
  proposal('p2', 'regressed', 'test-gap:spawn-token', grounding('spawn-token'));
  proposal('p3', 'regressed', 'test-gap:gizmo', grounding('gizmo'));
  expect(failureDerivedTasks(db, lookup).map((t) => t.run_id)).toEqual(['r-p3']);
  expect(failureDerivedTasks(db, { ...lookup, exists: () => true })).toEqual([]); // the test already exists at the base
  expect(qualifyingFailures(failureRows(db))).toHaveLength(1);
});

it('B8-FAIL: flag off (or a worker without write_test) leaves the claim pool unchanged; flag on serves the failure task first, never in holdouts', () => {
  vi.stubEnv('EVOLUTION_GYM_REMOTE_ENABLED', 'true'); vi.stubEnv('LOOP_DAEMON_REPOSITORY_PATH', '/repo');
  proposal('p1', 'regressed', 'test-gap:widget', grounding('widget'));
  const mined = ['c1', 'c2', 'c3'].map((commit) => ({ commit, source: 'packages/server/src/services/x.ts', tests: ['packages/server/src/__tests__/x.test.ts'], sourceLines: 5 }));
  const svc = new RemoteGymService(db, () => mined);
  svc.failureTasks = () => failureDerivedTasks(db, lookup);
  const run = (caps: string[]) => { const c = svc.claim('workstation', ['atomic@llama-router'], new Date(), { capabilities: caps }) as { runId: string; task: { commit: string } }; svc.record(c.runId, 'workstation', { status: 'failure', reason: 'tests still red' }); return c.task.commit; };
  expect(run(['write_test'])).toBe('c1'); // flag off
  vi.stubEnv('GYM_FAILURE_TASKS_ENABLED', 'true');
  expect(run([])).toBe('c2'); // a worker that cannot run write_test never gets one
  expect(run(['write_test'])).toBe('fail:r-p1');
  const outcome = db.prepare("SELECT evidence_refs_json AS e FROM skill_outcomes WHERE evidence_refs_json LIKE '%gym:fail:r-p1%'").get() as { e: string };
  expect(outcome.e).toContain('gym:fail');
  expect([...holdout(db, mined), ...mutantHoldoutKeys(db)].some((k) => String(k).startsWith('fail:'))).toBe(false);
  expect(failureTaskEvidence(db, null)).toMatchObject({ enabled: true, qualifying_failures: 1, attempted: 1, solved: 0 });
});

it('B8 oracle: a served write_test task carries seeded, distinct, deterministic mutants of its target; only their keys are stored', () => {
  vi.stubEnv('EVOLUTION_GYM_REMOTE_ENABLED', 'true'); vi.stubEnv('LOOP_DAEMON_REPOSITORY_PATH', '/repo'); vi.stubEnv('GYM_FAILURE_TASKS_ENABLED', 'true');
  proposal('p1', 'regressed', 'test-gap:widget', grounding('widget'));
  const svc = new RemoteGymService(db, () => []);
  svc.failureTasks = () => failureDerivedTasks(db, lookup);
  const c = svc.claim('workstation', ['atomic@llama-router'], new Date(), { capabilities: ['write_test'] }) as { runId: string; task: FailureTask };
  expect(c.task.commit).toBe('fail:r-p1');
  const { mutants } = c.task;
  expect(mutants).toHaveLength(WRITE_TEST_MUTANTS);
  expect(new Set(mutants.map((m) => m.content)).size).toBe(mutants.length);
  for (const m of mutants) {
    expect(m.content).not.toBe(TARGET_SRC);
    expect(m.key).toMatch(/^mut:aaaaaaaaaaaa:packages\/server\/src\/services\/widget\.ts:1:\d+$/);
  }
  expect(targetMutants(TARGET_SRC, BASE, c.task.target)).toEqual(mutants); // same base + target → same mutants
  expect(c.task.oracle).toMatch(/at least one of <mutants>/);
  const meta = JSON.parse((db.prepare('SELECT metadata FROM loop_runs WHERE id = ?').get(c.runId) as { metadata: string }).metadata).gym;
  expect(meta.mutant_keys).toEqual(mutants.map((m) => m.key));
  expect(meta.mutants).toBeUndefined();
  svc.record(c.runId, 'workstation', { status: 'success', reason: 'tests green, kills 1/3 mutants', killed_mutants: [mutants[1].key, 'mut:forged'] });
  const result = JSON.parse((db.prepare("SELECT json_extract(metadata, '$.gym_result') AS r FROM loop_runs WHERE id = ?").get(c.runId) as { r: string }).r);
  expect(result.killed_mutants).toEqual([mutants[1].key]); // only keys the server handed out
});

it('B8 oracle: a target without a valid mutant (or unreadable at the base) is not served', () => {
  proposal('p1', 'regressed', 'test-gap:widget', grounding('widget'));
  expect(failureDerivedTasks(db, { ...lookup, show: () => 'export const widget = 1;\n' })).toEqual([]);
  expect(failureDerivedTasks(db, { ...lookup, show: () => null })).toEqual([]);
  expect(failureDerivedTasks(db, lookup)).toHaveLength(1);
});
