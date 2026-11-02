import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import path from 'path';
import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { RemoteGymService } from '../services/remote-gym-service';
import { renderWorkAssignment } from '../services/loop-service';
import type { FailureTask } from '../services/gym-failure-tasks';
import { TG_ARMS, armAGoal, classifyTgFailure, freezeTg001, mcnemarExact, oneLine, pairedTable, productionArms, tg001Evidence, tgSchedule } from '../services/tg-001';

let db: Database.Database;
const NOW = '2026-10-11T12:00:00.000Z';
const FINDING = { id: 'f1', type: 'test_gap', severity: 'low', file: 'packages/server/src/services/w1.ts', message: 'w1.ts exports parse() without a unit test.',
  evidence: 'test-gap scan: 0 tests import w1.ts', suggested_fix: 'Write packages/server/src/__tests__/w1.test.ts covering parse().', metadata: { objective_mode: true } };

function seedTask(i: number, lane: 'test-gap' | 'exports' = 'exports'): FailureTask {
  const runId = `run-${i}`;
  const finding = { ...FINDING, file: `packages/server/src/services/w${i}.ts` };
  db.prepare('INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(runId, 'test-gap-loop', 'closed', 'completed', JSON.stringify([finding]), '{}', NOW, NOW);
  db.prepare('INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, finding_id, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(`lease-${i}`, runId, 'maker', 'remote', 'failed', 'f1', '{}', NOW, NOW);
  return { commit: `fail:${runId}`, kind: 'write_test', base: 'a'.repeat(40), source: `packages/server/src/__tests__/w${i}.test.ts`, tests: [`packages/server/src/__tests__/w${i}.test.ts`],
    target: `packages/server/src/services/w${i}.ts`, sourceLines: 10, run_id: runId, lane, mutants: [{ key: `mut:a:w${i}:1:1`, content: 'x' }], oracle: 'o' };
}

beforeEach(() => {
  // Keep the seeded engineering rule inside its freshness window on every calendar date.
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
  db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  vi.stubEnv('EVOLUTION_GYM_REMOTE_ENABLED', 'true'); vi.stubEnv('LOOP_DAEMON_REPOSITORY_PATH', '/repo-that-does-not-exist');
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); db.close(); });

it('TG-001 arm A is exactly the worker\'s gym goal; arms B/C/D differ as specified and B is the production assignment', async () => {
  const workerPath = path.resolve(__dirname, '../../../../scripts/gym-worker.mjs');
  const worker = await import(workerPath);
  const task = seedTask(1);
  expect(armAGoal(task)).toBe(worker.gymGoal(task, true, []));
  vi.stubEnv('LOOP_MEMORY_RULES_ENABLED', 'true');
  db.prepare(`INSERT INTO memory_candidates (id, title, content, memory_type, status, promotion_status, human_required, sensitivity, metadata, created_at, updated_at, store)
    VALUES ('r1', 't', 'Run the named test before you hand off.', 'engineering_rule', 'promoted', 'promoted', 0, 'normal', '{}', ?, ?, 'procedural')`).run(NOW, NOW);
  const arms = productionArms(db, task, '/repo-that-does-not-exist')!;
  expect(arms).not.toBeNull();
  // B = the production LOOP_WORK.md: ids, advisory past experience, the memory rule and the fixed rules template
  const rule = 'Run the named test before you hand off.';
  expect(arms.B).toBe(renderWorkAssignment({ id: 'run-1', loop_name: 'test-gap-loop' }, { ...FINDING, file: task.target } as never, 'remote', '',
    { examples: [], rules: [{ id: 'r1', text: rule, hash: createHash('sha256').update(rule).digest('hex') }] }));
  for (const part of ['Loop run: run-1', 'Runtime target: remote', 'Finding: f1', '## Advisory Past Experience', '## Rules', 'Run the named test before you hand off.', FINDING.message]) expect(arms.B).toContain(part);
  // C = B without ids, advisory and the policy template; the task content and the memory rule stay
  for (const gone of ['Loop run:', 'Runtime target:', 'Finding: f1', '## Advisory Past Experience', '## Rules']) expect(arms.C).not.toContain(gone);
  for (const kept of [FINDING.message, FINDING.evidence, FINDING.suggested_fix, 'Run the named test before you hand off.', `File: ${task.target}`]) expect(arms.C).toContain(kept);
  // D = A + only the production finding and suggested fix
  expect(arms.D).toBe(`${arms.A}\nFinding: ${FINDING.message}\nSuggested fix: ${FINDING.suggested_fix}`);
  // the freeze is read-only: rule sealing and memory-read logging are rolled back
  expect(db.prepare('SELECT COUNT(*) AS n FROM memory_access_log').get()).toEqual({ n: 0 });
  expect(db.prepare("SELECT content_hash FROM memory_candidates WHERE id = 'r1'").get()).toEqual({ content_hash: null });
  // the worker flattens the override with the same oneLine as a production maker job
  expect(worker.makerInput({ prompt_override: arms.B }, task, true)).toBe(`${oneLine(arms.B)}\n`);
  expect(oneLine(arms.B)).not.toContain('\n');
});

it('TG-001 schedule is a seeded Latin square: every (task, arm) once, every arm in every position equally often', () => {
  const keys = Array.from({ length: 20 }, (_, i) => `fail:run-${i}`);
  const s = tgSchedule(keys);
  expect(s).toHaveLength(80);
  expect(new Set(s.map((x) => `${x.task_key}|${x.arm}`)).size).toBe(80);
  for (const arm of TG_ARMS) for (let pos = 0; pos < 4; pos++) expect(s.filter((x, i) => i % 4 === pos && x.arm === arm)).toHaveLength(5);
  expect(tgSchedule(keys)).toEqual(s);
  expect(tgSchedule(keys, 7)).not.toEqual(s);
});

it('McNemar exact (two-sided) and the paired table', () => {
  expect(mcnemarExact(8, 1)).toBeCloseTo(0.0390625, 10);
  expect(mcnemarExact(0, 0)).toBe(1);
  expect(mcnemarExact(3, 3)).toBe(1);
  const rows = [
    ...['t1', 't2', 't3'].flatMap((t) => [{ task_key: t, arm: 'A', status: 'success' }, { task_key: t, arm: 'B', status: 'failure' }]),
    { task_key: 't4', arm: 'A', status: 'success' }, { task_key: 't4', arm: 'B', status: 'success' },
    { task_key: 't5', arm: 'A', status: 'failure' }, { task_key: 't5', arm: 'B', status: 'success' },
    { task_key: 't6', arm: 'A', status: 'success' }, { task_key: 't6', arm: 'B', status: 'invalid' }, // not a pair
  ];
  const t = pairedTable(rows, 'A', 'B');
  expect(t).toMatchObject({ n_pairs: 5, both_pass: 1, A_only: 3, B_only: 1, both_fail: 0, effect: 0.4, mcnemar_exact_p: 0.625 });
});

it('TG-001 failure categories come from recorded fields only', () => {
  expect(classifyTgFailure('success', 'tests green, source only', {})).toBeNull();
  expect(classifyTgFailure('failure', 'no change (maker gave up)', { termination: 'timeout' })).toBe('TIMEOUT');
  expect(classifyTgFailure('discarded', 'infra: npm ci failed', {})).toBe('INFRASTRUCTURE_FAILURE');
  expect(classifyTgFailure('discarded', 'task: test already green at base (gap closed)', {})).toBe('EVALUATOR_FAILURE');
  expect(classifyTgFailure('failure', 'out of scope: README.md', {})).toBe('CONTEXT_FAILURE');
  expect(classifyTgFailure('failure', 'prod_gate_failed:lint', {})).toBe('IMPLEMENTATION_FAILURE');
  expect(classifyTgFailure('failure', 'tests still red', {})).toBe('TEST_FAILURE');
  expect(classifyTgFailure('failure', 'no change (maker gave up)', { termination: 'exit:0', maker_ms: 12_000 })).toBe('UNDERSTANDING_FAILURE');
  expect(classifyTgFailure('failure', 'no change (maker gave up)', { failed_tool_calls: 3 })).toBe('TOOL_FAILURE');
  expect(classifyTgFailure('failure', 'no change (maker gave up)', { termination: 'exit:0', maker_ms: 400_000 })).toBe('UNKNOWN_FAILURE');
});

it('TG_001_MODE=on: the first capable claim freezes the experiment, later claims serve arms with the prompt; TG runs earn no gym outcome', () => {
  vi.stubEnv('TG_001_MODE', 'on'); vi.stubEnv('GYM_PROD_GATES', 'true'); vi.stubEnv('GYM_FAILURE_TASKS_ENABLED', 'true');
  const tasks = Array.from({ length: 12 }, (_, i) => seedTask(i + 1, i < 3 ? 'test-gap' : 'exports'));
  const svc = new RemoteGymService(db, () => []);
  svc.failureTasks = () => tasks;
  const caps = { capabilities: ['canary', 'write_test', 'prod_gates', 'prompt_override'] };
  // a worker without prompt_override gets no TG attempt, and frozen TG tasks are never served as ordinary work
  const plain = svc.claim('workstation', ['atomic@llama-router'], new Date(), { capabilities: ['write_test', 'prod_gates'] });
  expect(plain).toMatchObject({ task: { kind: 'write_test' } });
  expect((plain as { prompt_override?: string }).prompt_override).toBeUndefined();
  db.prepare("UPDATE loop_runs SET status = 'completed' WHERE loop_name = 'evolution-gym'").run();
  // B27: the freezing claim starts no TG attempt (the plan must strictly predate the first physical attempt)
  const freezing = svc.claim('workstation', ['atomic@llama-router'], new Date(Date.now() - 60_000), caps) as { tg?: unknown };
  expect(freezing.tg).toBeUndefined();
  db.prepare("UPDATE loop_runs SET status = 'completed' WHERE loop_name = 'evolution-gym'").run();
  const c = svc.claim('workstation', ['atomic@llama-router'], new Date(), caps) as { runId: string; task: FailureTask; prompt_override: string; tg: { arm: string } };
  expect(c.tg.arm).toMatch(/^[ABCD]$/);
  expect(typeof c.prompt_override).toBe('string');
  expect(db.prepare('SELECT COUNT(*) AS n FROM tg_attempts').get()).toEqual({ n: 48 }); // 12 tasks × 4 arms
  svc.record(c.runId, 'workstation', { status: 'success', reason: 'tests green, source only', durationMs: 90_000, tg_metrics: { termination: 'exit:0', files_modified: [c.task.source], tokens: 'lots', retries: 0 } });
  expect(db.prepare("SELECT COUNT(*) AS n FROM skill_outcomes WHERE evidence_refs_json LIKE ?").get(`%${c.runId}%`)).toEqual({ n: 0 });
  const done = db.prepare("SELECT status, result_json FROM tg_attempts WHERE run_id = ?").get(c.runId) as { status: string; result_json: string };
  expect(done.status).toBe('done');
  expect(JSON.parse(done.result_json).metrics).toMatchObject({ termination: 'exit:0', tokens: null, retries: 0 }); // a non-number token count is not stored
  const ev = tg001Evidence(db, process.env);
  expect(ev).toMatchObject({ status: 'collecting', mode: 'on' });
  expect(ev.arms.find((a) => a.arm === c.tg.arm)).toMatchObject({ n: 1, success: 1 });
  // an infra discard re-queues the attempt (kept in history), a task discard makes it invalid
  const c2 = svc.claim('workstation', ['atomic@llama-router'], new Date(), caps) as { runId: string };
  svc.record(c2.runId, 'workstation', { status: 'discarded', reason: 'infra: npm ci failed' });
  const back = db.prepare('SELECT status, retries, history_json FROM tg_attempts WHERE id = (SELECT id FROM tg_attempts WHERE history_json LIKE ?)').get(`%${c2.runId}%`) as { status: string; retries: number; history_json: string };
  expect(back).toMatchObject({ status: 'pending', retries: 1 });
  expect(JSON.parse(back.history_json)).toHaveLength(1);
});

it('freeze refuses with too few renderable tasks and never takes a reserved (holdout) task', () => {
  const tasks = [seedTask(1), seedTask(2)];
  expect(freezeTg001(db, tasks, { checkoutPath: '/x', species: 'atomic@llama-router', commit: null, harness: null, prodGates: null, reserved: new Set(), now: NOW }))
    .toMatchObject({ frozen: false });
  const many = Array.from({ length: 14 }, (_, i) => seedTask(i + 10));
  const r = freezeTg001(db, many, { checkoutPath: '/x', species: 'atomic@llama-router', commit: null, harness: null, prodGates: null, reserved: new Set([many[0].commit]), now: NOW });
  expect(r.frozen).toBe(true);
  expect(r.manifest!.tasks.map((t) => t.key)).not.toContain(many[0].commit);
  expect(r.manifest!.tasks).toHaveLength(13);
  for (const t of r.manifest!.tasks) expect(Object.keys(t.prompts).sort()).toEqual(['A', 'B', 'C', 'D']);
});
