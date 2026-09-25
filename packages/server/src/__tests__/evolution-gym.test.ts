import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { EvolutionGymService, prepareGymWorktree } from '../services/evolution-gym-service';
import type { GymTask } from '../services/gym-task-miner';
import type { LoopService } from '../services/loop-service';

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
const TASK: GymTask = { commit: 'c1', source: 'packages/server/src/services/x.ts', tests: ['packages/server/src/__tests__/x.test.ts'], sourceLines: 3 };

it('prepares the broken state: the commit, with the source restored to its parent and committed', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-git-'));
  git(repo, 'init', '-q', '-b', 'main');
  const src = path.join(repo, TASK.source); const tst = path.join(repo, TASK.tests[0]);
  fs.mkdirSync(path.dirname(src), { recursive: true }); fs.mkdirSync(path.dirname(tst), { recursive: true });
  fs.writeFileSync(src, 'v1'); fs.writeFileSync(tst, 't1'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'parent');
  fs.writeFileSync(src, 'v2'); fs.writeFileSync(tst, 't2'); git(repo, 'commit', '-qam', 'fix');
  const fix = git(repo, 'rev-parse', 'HEAD').trim();
  fs.writeFileSync(src, 'later'); git(repo, 'commit', '-qam', 'later');
  prepareGymWorktree(repo, { ...TASK, commit: fix });
  expect(fs.readFileSync(src, 'utf8')).toBe('v1'); // the fix is undone
  expect(fs.readFileSync(tst, 'utf8')).toBe('t2'); // the commit's test is the oracle
  expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe(`gym: restore parent of ${TASK.source}`);
  expect(git(repo, 'status', '--porcelain')).toBe(''); // the maker's diff will be its fix only
  fs.rmSync(repo, { recursive: true, force: true });
});

let db: Database.Database;
const env: Record<string, string | undefined> = {};
beforeEach(() => {
  n = 0;
  db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  for (const k of ['EVOLUTION_GYM_ENABLED', 'LOOP_DAEMON_REPOSITORY_PATH', 'LOOP_EVOLVE_SPECIES', 'LOOP_DAEMON_MAKER_RUNTIME']) { env[k] = process.env[k]; delete process.env[k]; }
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { db.close(); vi.restoreAllMocks(); for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

let n = 0;
function service(o: { green?: boolean[]; changed?: string[]; install?: boolean }) {
  const loops = {
    startLoop: vi.fn(() => { const id = `run-${++n}`; db.prepare("INSERT INTO loop_runs (id, loop_name, mode, status, metadata) VALUES (?, 'doc-drift-and-small-fix-loop', 'closed', 'running', '{}')").run(id); return { id }; }),
    continueLoopRun: vi.fn((runId: string) => {
      db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata) VALUES (?, ?, 'maker', 'opencode', 'prepared', '{\"runtime_usage\":{\"total_tokens\":1234}}'), (?, ?, 'checker', 'manual', 'prepared', '{}')").run(`m-${runId}`, runId, `c-${runId}`, runId);
      return { leases: [{ id: `m-${runId}`, role: 'maker', worktree_path: '/tmp/none' }] };
    }),
    executeWorker: vi.fn(async () => ({})),
    decideWorkerApproval: vi.fn(async () => null),
    awaitWorkerExecution: vi.fn(async () => 'completed'),
  };
  const oracle = vi.fn(); for (const g of o.green ?? []) oracle.mockReturnValueOnce(g);
  const svc = new EvolutionGymService(db, loops as unknown as LoopService, {
    mine: () => [TASK, { ...TASK, commit: 'c2' }], prepare: vi.fn(), install: () => o.install ?? true, oracle, changed: () => o.changed ?? [TASK.source],
  });
  return { svc, loops };
}
const outcomes = () => db.prepare("SELECT skill_id, success, tokens_used, domain FROM skill_outcomes").all();
const run = (id: string) => db.prepare("SELECT status, json_extract(metadata, '$.gym_result.status') AS r, json_extract(metadata, '$.gym.species') AS s FROM loop_runs WHERE id = ?").get(id);

it('success: red before, green after, source only → a gym outcome; the run settles and reviewer leases are cancelled', async () => {
  const { svc } = service({ green: [false, true] });
  expect(await svc.attempt('/repo', TASK, { runtime: 'opencode' })).toMatchObject({ status: 'success', reason: 'tests green, source only' });
  expect(outcomes()).toEqual([{ skill_id: 'loop-maker:gym:opencode', success: 1, tokens_used: 1234, domain: 'gym' }]);
  expect(run('run-1')).toEqual({ status: 'completed', r: 'success', s: 'opencode' });
  expect(db.prepare("SELECT status FROM worker_leases WHERE id = 'c-run-1'").get()).toEqual({ status: 'cancelled' });
});

it('a task already green before the attempt is discarded (no outcome), an out-of-scope change fails', async () => {
  expect(await service({ green: [true] }).svc.attempt('/repo', TASK, { runtime: 'opencode' })).toMatchObject({ status: 'discarded' });
  expect(outcomes()).toEqual([]);
  expect(await service({ green: [false, true], changed: [TASK.source, TASK.tests[0]] }).svc.attempt('/repo', TASK, { runtime: 'opencode' }))
    .toMatchObject({ status: 'failure', reason: expect.stringContaining('out of scope') });
});

it('an approval-gated maker is approved by the gym rule and then read back', async () => {
  const { svc, loops } = service({ green: [false, true] });
  loops.executeWorker.mockRejectedValueOnce(new Error('LOOP_WORKER_APPROVAL_REQUIRED'));
  loops.continueLoopRun.mockImplementationOnce((runId: string) => {
    db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata) VALUES (?, ?, 'maker', 'opencode', 'prepared', '{\"approval_id\":\"appr-g\"}')").run(`m-${runId}`, runId);
    return { leases: [{ id: `m-${runId}`, role: 'maker', worktree_path: '/tmp/none' }] };
  });
  expect((await svc.attempt('/repo', TASK, { runtime: 'opencode' })).status).toBe('success');
  expect(loops.decideWorkerApproval).toHaveBeenCalledWith('appr-g', true, 'autonomy:gym-rule-v1', expect.any(String));
  expect(loops.awaitWorkerExecution).toHaveBeenCalledWith('m-run-1');
  expect(loops.executeWorker).toHaveBeenCalledTimes(2);
});

it('runOne: off by default, never repeats a task for a species, and skips while production workers run', async () => {
  const { svc } = service({ green: [false, true, true] });
  expect((await svc.runOne()).reason).toBe('disabled');
  process.env.EVOLUTION_GYM_ENABLED = 'true'; process.env.LOOP_DAEMON_REPOSITORY_PATH = '/repo';
  expect((await svc.runOne()).task?.commit).toBe('c1');
  expect((await svc.runOne()).task?.commit).toBe('c2'); // c1 was tried (here: discarded as already green)
  expect((await svc.runOne()).reason).toBe('no untried task');
  db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata) VALUES ('busy', 'x', 'maker', 'opencode', 'running', '{}')").run();
  expect((await svc.runOne()).reason).toBe('production workers running');
});
