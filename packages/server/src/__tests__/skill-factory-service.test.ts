import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
const packageState = vi.hoisted(() => ({ hash: 'verified-hash' }));
vi.mock('../services/executable-skills', async importOriginal => ({ ...await importOriginal<typeof import('../services/executable-skills')>(), ExecutableSkills: class { load() { return { contract: { test: 'run.test.mjs' }, skill: { contentHash: 'a'.repeat(64) }, contentHash: packageState.hash }; } } }));
let worktree: string;
import { SkillFactoryService } from '../services/skill-factory-service';
import type { LoopService } from '../services/loop-service';
import type { LoopRunRecord, WorkerLeaseRecord } from '../services/loop-types';

let db: Database.Database;
let run: LoopRunRecord;
let leases: WorkerLeaseRecord[];
const maker = () => ({ id: 'maker', role: 'maker', status: 'prepared', runtime: 'codex', worktree_path: worktree, metadata: { execution_task_id: 'maker-task' } } as WorkerLeaseRecord);
const checker = () => ({ id: 'checker', role: 'checker', status: 'prepared', runtime: 'manual', metadata: { maker_lease_id: 'maker' } } as WorkerLeaseRecord);
function harness() {
  const loops = {
    startObjectiveLoop: vi.fn(() => { db.prepare("INSERT INTO loop_runs VALUES ('run','goal','2026-10-31')").run(); return run; }),
    getLoopRun: vi.fn(() => run),
    listWorkerLeases: vi.fn(() => leases),
    continueLoopRun: vi.fn(() => { leases = [maker(), checker()]; return { run, leases }; }),
    executeMaker: vi.fn(async () => { leases[0].status = 'completed'; return {} as never; }),
    updateWorkerLeaseStatus: vi.fn((id: string, status: WorkerLeaseRecord['status'], metadata: Record<string, unknown> = {}) => { const lease = leases.find(l => l.id === id)!; lease.status = status; Object.assign(lease.metadata, metadata); }),
    runDeterministicChecks: vi.fn(() => { const checks = ['test','lint','type-check','test:skill-package'].map(name => ({name,status:'pass',exit_status:0})); leases[0].metadata.deterministic_checks = checks; return {run,lease:leases[0],checks}; }),
    executeChecker: vi.fn(async () => { leases[1].status = 'completed'; return {} as never; }),
    verifyLoopRun: vi.fn(() => { run.status = 'ready_for_human_merge'; return { run, leases, gates: [{ name: 'checker_verdict', status: 'pass' as const, evidence: 'fixture' }] }; }),
  } satisfies Pick<LoopService, 'startObjectiveLoop' | 'getLoopRun' | 'listWorkerLeases' | 'continueLoopRun' | 'executeMaker' | 'executeChecker' | 'verifyLoopRun' | 'runDeterministicChecks' | 'updateWorkerLeaseStatus'>;
  return { loops, factory: new SkillFactoryService(db, loops, async () => loops.runDeterministicChecks()) };
}
const prep = { repository_path: '/fixture/repo', runtime: 'codex' as const };
beforeEach(() => {
  vi.stubEnv('SKILL_FIRST_MODE', 'on');
  packageState.hash = 'verified-hash';
  worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-factory-'));
  fs.mkdirSync(path.join(worktree, 'skills'), {recursive:true});
  fs.writeFileSync(path.join(worktree, 'package.json'), JSON.stringify({scripts:{'test:skill-package':'node --test skills/fixture-v1-0-0/run.test.mjs'}}));
  db = new Database(':memory:');
  db.exec(`CREATE TABLE goals(id TEXT PRIMARY KEY,owner_user_id TEXT,status TEXT,metadata TEXT);
    CREATE TABLE loop_runs(id TEXT PRIMARY KEY,goal_id TEXT,created_at TEXT);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,status TEXT,metadata TEXT);
    CREATE TABLE execution_evidence(id TEXT PRIMARY KEY,task_id TEXT,execution_event_id TEXT,approval_id TEXT,evidence_type TEXT,severity TEXT,title TEXT,summary TEXT,details TEXT,source TEXT,captured_at TEXT,metadata TEXT,created_at TEXT,updated_at TEXT);`);
  db.prepare('INSERT INTO goals VALUES (?,?,?,?)').run('goal', 'owner', 'created', JSON.stringify({ skill_factory_key: 'skill-factory:fixture:owner', skill_factory_capability: 'fixture', skill_factory_package_id: 'fixture-v1-0-0' }));
  run = { id: 'run', goal_id: 'goal', status: 'running', metadata: {} } as LoopRunRecord;
  db.prepare("INSERT INTO tasks VALUES ('maker-task','completed','{}')").run();
  leases = [];
});
afterEach(() => { db.close(); fs.rmSync(worktree,{recursive:true,force:true}); vi.unstubAllEnvs(); });

describe('SkillFactoryService existing loop continuation', () => {
  it('prepares actual existing-loop methods once and reuses persisted run after constructing another service', () => {
    const { factory, loops } = harness();
    expect(factory.prepare('goal', 'owner', prep).run_id).toBe('run');
    new SkillFactoryService(db, loops).prepare('goal', 'owner', prep);
    expect(loops.startObjectiveLoop).toHaveBeenCalledOnce();
    expect(loops.continueLoopRun).toHaveBeenCalledExactlyOnceWith('run', { runtime: 'codex', max_assignments: 1, max_maker_workers: 1 });
  });

  it('checks mode, owner and factory marker before creating any run', () => {
    const { factory, loops } = harness();
    expect(() => factory.prepare('goal', 'other', prep)).toThrow('SKILL_FACTORY_OWNER_REQUIRED');
    vi.stubEnv('SKILL_FIRST_MODE', 'shadow');
    expect(() => factory.prepare('goal', 'owner', prep)).toThrow('SKILL_FACTORY_DISABLED');
    vi.stubEnv('SKILL_FIRST_MODE', 'on');
    db.prepare("UPDATE goals SET metadata='{}'").run();
    expect(() => factory.prepare('goal', 'owner', prep)).toThrow('SKILL_FACTORY_GOAL_REQUIRED');
    expect(loops.startObjectiveLoop).not.toHaveBeenCalled();
  });

  it('advances maker, then independently selected checker, then existing verification without approval or publication', async () => {
    const { factory, loops } = harness();
    factory.prepare('goal', 'owner', prep);
    expect((await factory.advance('goal', 'owner')).status).toBe('worker_completed');
    expect(loops.executeMaker).toHaveBeenCalledExactlyOnceWith('run', { lease_id: 'maker', timeout_ms: undefined, skip_permissions: false });
    expect((await factory.advance('goal', 'owner')).status).toBe('checks_completed');
    expect(loops.runDeterministicChecks).toHaveBeenCalledOnce();
    await expect(factory.advance('goal', 'owner')).rejects.toThrow('SKILL_FACTORY_CHECKER_RUNTIME_REQUIRED');
    await factory.advance('goal', 'owner', { checker_runtime: 'claude' });
    expect(loops.executeChecker).toHaveBeenCalledExactlyOnceWith('run', { lease_id: 'checker', runtime: 'claude', timeout_ms: undefined, skip_permissions: false });
    expect((await factory.advance('goal', 'owner')).status).toBe('awaiting_package_admission');
    expect(JSON.parse((db.prepare('SELECT details FROM execution_evidence').get() as {details:string}).details).skill_package_hash).toBe('verified-hash');
    await factory.advance('goal', 'owner');
    expect(db.prepare('SELECT count(*) n FROM execution_evidence').get()).toEqual({n:1});
    expect(loops.verifyLoopRun).toHaveBeenCalledTimes(2);
    expect(loops.executeMaker).toHaveBeenCalledOnce();
  });

  it('binds canonical variation parent into the package verification receipt without promoting it', async () => {
    const parent = {capability_id:'skill:fixture-v1-0-0@1.0.0',content_hash:'b'.repeat(64)};
    db.prepare("UPDATE goals SET metadata=json_set(metadata,'$.skill_factory_parent',json(?))").run(JSON.stringify(parent));
    const {factory}=harness(); factory.prepare('goal','owner',prep);
    await factory.advance('goal','owner'); await factory.advance('goal','owner');
    await factory.advance('goal','owner',{checker_runtime:'claude'});
    expect((await factory.advance('goal','owner')).status).toBe('awaiting_package_admission');
    const details=JSON.parse((db.prepare('SELECT details FROM execution_evidence').get() as {details:string}).details);
    expect(details).toMatchObject({skill_parent:parent,skill_factory_run_id:'run',maker_lease_id:'maker',skill_package_hash:'verified-hash'});
  });

  it('retains pending approval and recovery without redispatch or auto-approval', async () => {
    const { factory, loops } = harness(); factory.prepare('goal', 'owner', prep);
    leases[0].metadata.execution_task_id = 'task';
    db.prepare('INSERT INTO tasks VALUES (?,?,?)').run('task', 'awaiting_approval', '{}');
    expect((await factory.advance('goal', 'owner')).status).toBe('awaiting_approval');
    db.prepare("UPDATE tasks SET metadata=? WHERE id='task'").run(JSON.stringify({ execution_recovery_hold: true }));
    await expect(factory.advance('goal', 'owner')).rejects.toThrow('SKILL_FACTORY_EXECUTION_RECOVERY_REQUIRED');
    expect(loops.executeMaker).not.toHaveBeenCalled();
  });

  it('does not dispatch a prepared lease while its durable execution task is running', async () => {
    const { factory, loops } = harness(); factory.prepare('goal', 'owner', prep);
    leases[0].metadata.execution_task_id = 'task';
    db.prepare("INSERT INTO tasks VALUES ('task','running','{}')").run();
    expect((await factory.advance('goal', 'owner')).status).toBe('in_progress');
    expect(loops.executeMaker).not.toHaveBeenCalled();
  });

  it('serializes concurrent requests across service instances with a durable claim', async () => {
    const { factory, loops } = harness(); factory.prepare('goal', 'owner', prep);
    let finish!: () => void;
    loops.executeMaker.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({} as never); }));
    const pending = factory.advance('goal', 'owner');
    await expect(new SkillFactoryService(db, loops).advance('goal', 'owner')).rejects.toThrow('SKILL_FACTORY_DISPATCH_HELD');
    expect(loops.executeMaker).toHaveBeenCalledOnce();
    finish(); await pending;
    expect(JSON.parse((db.prepare('SELECT metadata FROM goals').get() as {metadata:string}).metadata).skill_factory_dispatch).toBeUndefined();
  });

  it('does not expire a crash-left dispatch claim and guess external work stopped', async () => {
    const { factory, loops } = harness(); factory.prepare('goal', 'owner', prep);
    db.prepare("UPDATE goals SET metadata=json_set(metadata,'$.skill_factory_dispatch','old-process')").run();
    await expect(factory.advance('goal', 'owner')).rejects.toThrow('SKILL_FACTORY_DISPATCH_HELD');
    expect(loops.executeMaker).not.toHaveBeenCalled();
  });

  it('preserves executor refusal and releases only its own claim', async () => {
    const { factory, loops } = harness(); factory.prepare('goal', 'owner', prep);
    loops.executeMaker.mockRejectedValueOnce(new Error('POLICY_APPROVAL_REQUIRED'));
    await expect(factory.advance('goal', 'owner')).rejects.toThrow('POLICY_APPROVAL_REQUIRED');
    expect(JSON.parse((db.prepare('SELECT metadata FROM goals').get() as {metadata:string}).metadata).skill_factory_dispatch).toBeUndefined();
    expect(loops.executeChecker).not.toHaveBeenCalled();
  });

  it('leaves failed maker and unknown verification blocked rather than creating more workers', async () => {
    const { factory, loops } = harness(); factory.prepare('goal', 'owner', prep);
    leases[0].status = 'failed';
    expect((await factory.advance('goal', 'owner')).status).toBe('blocked');
    expect(loops.verifyLoopRun).not.toHaveBeenCalled();
    leases.forEach(l => { l.status = 'completed'; });
    await factory.advance('goal', 'owner');
    loops.verifyLoopRun.mockImplementationOnce(() => ({ run: { ...run, status: 'blocked' }, leases, gates: [] }));
    expect((await factory.advance('goal', 'owner')).status).toBe('blocked');
    expect(loops.executeMaker).not.toHaveBeenCalled();
  });
  it('requires the explicit package test and refuses changed bytes around checks', async () => {
    const { factory, loops } = harness(); factory.prepare('goal', 'owner', prep);
    leases[0].status = 'completed';
    fs.writeFileSync(path.join(worktree, 'package.json'), '{}');
    await expect(factory.advance('goal', 'owner')).rejects.toThrow('SKILL_FACTORY_PACKAGE_TEST_REQUIRED');
    expect(loops.runDeterministicChecks).not.toHaveBeenCalled();
    fs.writeFileSync(path.join(worktree, 'package.json'), JSON.stringify({scripts:{'test:skill-package':'node --test skills/fixture-v1-0-0/run.test.mjs'}}));
    loops.runDeterministicChecks.mockImplementationOnce(() => { packageState.hash = 'changed'; return {run,lease:leases[0],checks:['test','lint','type-check','test:skill-package'].map(name=>({name,status:'pass',exit_status:0}))}; });
    await expect(factory.advance('goal', 'owner')).rejects.toThrow('SKILL_FACTORY_PACKAGE_CHANGED_DURING_CHECKS');
    expect(loops.updateWorkerLeaseStatus).not.toHaveBeenCalled();
    expect(loops.executeChecker).not.toHaveBeenCalled();
  });

  it('does not mint a receipt for empty gates or a package changed after checking', async () => {
    const { factory, loops } = harness(); factory.prepare('goal', 'owner', prep);
    leases.forEach(l => { l.status = 'completed'; });
    await factory.advance('goal', 'owner');
    loops.verifyLoopRun.mockImplementationOnce(() => { run.status = 'ready_for_human_merge'; return {run, leases, gates:[]}; });
    expect((await factory.advance('goal', 'owner')).status).toBe('blocked');
    expect(db.prepare('SELECT count(*) n FROM execution_evidence').get()).toEqual({n:0});
    packageState.hash = 'changed';
    await expect(factory.advance('goal', 'owner')).rejects.toThrow('SKILL_FACTORY_PACKAGE_CHANGED_AFTER_CHECKS');
    expect(db.prepare('SELECT count(*) n FROM execution_evidence').get()).toEqual({n:0});
  });

  it('rejects simulated runtimes in requests and previously persisted leases', async () => {
    const {factory, loops} = harness();
    expect(() => factory.prepare('goal', 'owner', {...prep, runtime:'mock' as never})).toThrow();
    factory.prepare('goal', 'owner', prep);
    leases[0].runtime = 'mock';
    await expect(factory.advance('goal','owner')).rejects.toThrow('SKILL_FACTORY_REAL_RUNTIME_REQUIRED');
    expect(loops.executeMaker).not.toHaveBeenCalled();
  });

  it('throws when the goal does not exist', () => {
    const { factory } = harness();
    expect(() => factory.prepare('missing', 'owner', prep)).toThrow('SKILL_FACTORY_GOAL_NOT_FOUND');
  });

  it('rejects terminal goals (failed and cancelled)', () => {
    const { factory } = harness();
    for (const status of ['failed', 'cancelled'] as const) {
      db.prepare('UPDATE goals SET status=?').run(status);
      expect(() => factory.prepare('goal', 'owner', prep)).toThrow('SKILL_FACTORY_GOAL_TERMINAL');
    }
  });

  it('rejects operator-paused goals', () => {
    const { factory } = harness();
    db.prepare('UPDATE goals SET metadata=?').run(JSON.stringify({ skill_factory_key: 'skill-factory:fixture:owner', skill_factory_capability: 'fixture', skill_factory_package_id: 'fixture-v1-0-0', operator_paused: true }));
    expect(() => factory.prepare('goal', 'owner', prep)).toThrow('SKILL_FACTORY_PAUSED');
  });

  it('requires both skill_factory_key and skill_factory_capability individually', () => {
    const { factory } = harness();
    const base = JSON.stringify({ skill_factory_key: 'k', skill_factory_capability: 'c', skill_factory_package_id: 'fixture-v1-0-0' });
    db.prepare('UPDATE goals SET metadata=?').run(JSON.stringify({ skill_factory_key: 'k', skill_factory_capability: 'c', skill_factory_package_id: 'fixture-v1-0-0' }));
    db.prepare("UPDATE goals SET metadata=json_set(metadata,'$.skill_factory_key',null)").run();
    expect(() => factory.prepare('goal', 'owner', prep)).toThrow('SKILL_FACTORY_GOAL_REQUIRED');
    db.prepare('UPDATE goals SET metadata=?').run(base);
    db.prepare("UPDATE goals SET metadata=json_set(metadata,'$.skill_factory_capability',null)").run();
    expect(() => factory.prepare('goal', 'owner', prep)).toThrow('SKILL_FACTORY_GOAL_REQUIRED');
  });

  it('refuses to prepare a terminal run', () => {
    const { factory } = harness();
    db.prepare("INSERT INTO loop_runs VALUES ('run','goal','2026-10-31')").run();
    for (const status of ['failed', 'cancelled', 'completed', 'escalated'] as const) {
      run.status = status;
      expect(() => factory.prepare('goal', 'owner', prep)).toThrow('SKILL_FACTORY_RUN_TERMINAL');
    }
  });

  it('reports next_action for running and ready_for_human_merge states', async () => {
    const { factory } = harness();
    expect(factory.prepare('goal', 'owner', prep).next_action).toContain('Continue');
    leases.forEach(l => { l.status = 'completed'; });
    await factory.advance('goal', 'owner');
    await factory.advance('goal', 'owner', { checker_runtime: 'claude' });
    const result = await factory.advance('goal', 'owner');
    expect(result.next_action).toContain('no approval');
  });

  it('refuses advance without a prior prepared run', async () => {
    const { factory } = harness();
    await expect(factory.advance('goal', 'owner')).rejects.toThrow('SKILL_FACTORY_NOT_PREPARED');
  });

  it('refuses advance on a terminal run', async () => {
    const { factory } = harness(); factory.prepare('goal', 'owner', prep);
    for (const status of ['failed', 'cancelled', 'completed', 'escalated'] as const) {
      run.status = status;
      await expect(factory.advance('goal', 'owner')).rejects.toThrow('SKILL_FACTORY_RUN_TERMINAL');
    }
  });

  it('refuses advance when leases are empty', async () => {
    const { factory } = harness(); factory.prepare('goal', 'owner', prep);
    leases.length = 0;
    await expect(factory.advance('goal', 'owner')).rejects.toThrow('SKILL_FACTORY_NOT_PREPARED');
  });

  it('reports in_progress for running maker leases and queued tasks', async () => {
    const { factory } = harness(); factory.prepare('goal', 'owner', prep);
    leases[0].status = 'running';
    expect((await factory.advance('goal', 'owner')).status).toBe('in_progress');
    leases[0].status = 'prepared';
    leases[0].metadata.execution_task_id = 'task';
    db.prepare("INSERT INTO tasks VALUES ('task','queued','{}')").run();
    expect((await factory.advance('goal', 'owner')).status).toBe('in_progress');
  });

  it('rejects superseded maker leases and requires a maker', async () => {
    const { factory } = harness(); factory.prepare('goal', 'owner', prep);
    leases[0].metadata.superseded_by_maker_lease_id = 'new-maker';
    await expect(factory.advance('goal', 'owner')).rejects.toThrow('SKILL_FACTORY_MAKER_REQUIRED');
    leases[0].metadata.superseded_by_maker_lease_id = undefined;
    leases[0].role = 'checker';
    await expect(factory.advance('goal', 'owner')).rejects.toThrow('SKILL_FACTORY_MAKER_REQUIRED');
  });

  it('requires a non-empty package id on completed maker', async () => {
    const { factory } = harness(); factory.prepare('goal', 'owner', prep);
    leases[0].status = 'completed';
    db.prepare("UPDATE goals SET metadata=json_set(metadata,'$.skill_factory_package_id','')").run();
    await expect(factory.advance('goal', 'owner')).rejects.toThrow('SKILL_FACTORY_PACKAGE_ID_REQUIRED');
    db.prepare("UPDATE goals SET metadata=json_set(metadata,'$.skill_factory_package_id',null)").run();
    await expect(factory.advance('goal', 'owner')).rejects.toThrow('SKILL_FACTORY_PACKAGE_ID_REQUIRED');
  });

  it('requires a worktree path on completed maker', async () => {
    const { factory } = harness(); factory.prepare('goal', 'owner', prep);
    leases[0].status = 'completed';
    (leases[0] as WorkerLeaseRecord).worktree_path = null;
    await expect(factory.advance('goal', 'owner')).rejects.toThrow('SKILL_FACTORY_WORKTREE_REQUIRED');
  });

  it('refuses skills directory outside the worktree', async () => {
    const { factory } = harness(); factory.prepare('goal', 'owner', prep);
    leases[0].status = 'completed';
    fs.rmSync(path.join(worktree, 'skills'), { recursive: true, force: true });
    fs.symlinkSync(os.tmpdir(), path.join(worktree, 'skills'));
    await expect(factory.advance('goal', 'owner')).rejects.toThrow('SKILL_FACTORY_PACKAGE_OUTSIDE_WORKTREE');
  });

  it('refuses unsafe test paths', async () => {
    const { factory } = harness(); factory.prepare('goal', 'owner', prep);
    leases[0].status = 'completed';
    db.prepare("UPDATE goals SET metadata=json_set(metadata,'$.skill_factory_package_id','fixture v1')").run();
    await expect(factory.advance('goal', 'owner')).rejects.toThrow('SKILL_FACTORY_TEST_PATH_UNSAFE');
  });

  it('blocks when required checks are missing even if existing ones pass', async () => {
    const { factory, loops } = harness(); factory.prepare('goal', 'owner', prep);
    leases[0].status = 'completed';
    loops.runDeterministicChecks.mockImplementationOnce(() => ({ run, lease: leases[0], checks: [{ name: 'test', status: 'pass', exit_status: 0 }] }));
    expect((await factory.advance('goal', 'owner')).status).toBe('blocked');
  });

  it('blocks when any extra check fails even if required ones pass', async () => {
    const { factory, loops } = harness(); factory.prepare('goal', 'owner', prep);
    leases[0].status = 'completed';
    const checks = ['test','lint','type-check','test:skill-package'].map(name => ({ name, status: 'pass', exit_status: 0 }));
    checks.push({ name: 'extra', status: 'fail', exit_status: 1 });
    loops.runDeterministicChecks.mockImplementationOnce(() => ({ run, lease: leases[0], checks }));
    expect((await factory.advance('goal', 'owner')).status).toBe('blocked');
  });

  it('requires all deterministic checks on second advance', async () => {
    const { factory } = harness(); factory.prepare('goal', 'owner', prep);
    await factory.advance('goal', 'owner');
    await factory.advance('goal', 'owner');
    leases[0].metadata.deterministic_checks = [{ name: 'test', status: 'pass', exit_status: 0 }];
    await expect(factory.advance('goal', 'owner')).rejects.toThrow('SKILL_FACTORY_PACKAGE_CHECKS_REQUIRED');
    delete leases[0].metadata.deterministic_checks;
    await expect(factory.advance('goal', 'owner')).rejects.toThrow('SKILL_FACTORY_PACKAGE_CHECKS_REQUIRED');
  });

  it('requires reviewers for admission and validates maker_lease_id', async () => {
    const { factory } = harness(); factory.prepare('goal', 'owner', prep);
    await factory.advance('goal', 'owner');
    await factory.advance('goal', 'owner');
    leases.splice(1);
    await expect(factory.advance('goal', 'owner')).rejects.toThrow('SKILL_FACTORY_REVIEWER_REQUIRED');
  });

  it('only counts reviewers matching the maker lease id', async () => {
    const { factory } = harness(); factory.prepare('goal', 'owner', prep);
    await factory.advance('goal', 'owner');
    await factory.advance('goal', 'owner');
    leases[1].metadata.maker_lease_id = 'other-maker';
    await expect(factory.advance('goal', 'owner')).rejects.toThrow('SKILL_FACTORY_REVIEWER_REQUIRED');
  });

  it('rejects mock reviewer runtimes among real ones', async () => {
    const { factory } = harness(); factory.prepare('goal', 'owner', prep);
    await factory.advance('goal', 'owner');
    await factory.advance('goal', 'owner');
    leases[1].status = 'completed';
    leases.push({ id: 'sec', loop_run_id: 'run', role: 'security_checker', status: 'completed', runtime: 'mock', finding_id: null, worktree_path: null, branch_name: null, budget: {}, metadata: { maker_lease_id: 'maker' }, created_at: '', updated_at: '', parent_lease_id: null, spawn_tree_id: null, depth: 0, spawned_by_agent_id: null } as WorkerLeaseRecord);
    await expect(factory.advance('goal', 'owner')).rejects.toThrow('SKILL_FACTORY_REAL_RUNTIME_REQUIRED');
  });

  it('blocks when reviewers are not completed', async () => {
    const { factory } = harness(); factory.prepare('goal', 'owner', prep);
    await factory.advance('goal', 'owner');
    await factory.advance('goal', 'owner');
    leases[1].status = 'failed';
    expect((await factory.advance('goal', 'owner')).status).toBe('blocked');
  });

  it('requires a completed execution task for admission', async () => {
    const { factory } = harness(); factory.prepare('goal', 'owner', prep);
    await factory.advance('goal', 'owner');
    await factory.advance('goal', 'owner');
    await factory.advance('goal', 'owner', { checker_runtime: 'claude' });
    db.prepare("UPDATE tasks SET status='pending' WHERE id='maker-task'").run();
    await expect(factory.advance('goal', 'owner')).rejects.toThrow('SKILL_FACTORY_COMPLETED_TASK_REQUIRED');
  });

  it('detects package changes after verification passes', async () => {
    const { factory, loops } = harness(); factory.prepare('goal', 'owner', prep);
    await factory.advance('goal', 'owner');
    await factory.advance('goal', 'owner');
    await factory.advance('goal', 'owner', { checker_runtime: 'claude' });
    loops.verifyLoopRun.mockImplementationOnce(() => { run.status = 'ready_for_human_merge'; packageState.hash = 'changed-after-verify'; return { run, leases, gates: [{ name: 'checker_verdict', status: 'pass' as const, evidence: 'fixture' }] }; });
    await expect(factory.advance('goal', 'owner')).rejects.toThrow('SKILL_FACTORY_PACKAGE_CHANGED_AFTER_CHECKS');
  });

  it('validates prepare and advance input schemas strictly', async () => {
    const { factory } = harness();
    expect(() => factory.prepare('goal', 'owner', { repository_path: '', runtime: 'codex' })).toThrow();
    expect(() => factory.prepare('goal', 'owner', { repository_path: '  ', runtime: 'codex' })).toThrow();
    expect(() => factory.prepare('goal', 'owner', { repository_path: 'x'.repeat(4097), runtime: 'codex' })).toThrow();
    expect(() => factory.prepare('goal', 'owner', { repository_path: 'x', runtime: 'codex', model: 'y'.repeat(201) })).toThrow();
    expect(() => factory.prepare('goal', 'owner', { repository_path: 'x', runtime: 'codex', extra: true } as never)).toThrow();
    factory.prepare('goal', 'owner', prep);
    await expect(factory.advance('goal', 'owner', { timeout_ms: 100 } as never)).rejects.toThrow();
    await expect(factory.advance('goal', 'owner', { timeout_ms: 600001 } as never)).rejects.toThrow();
    await expect(factory.advance('goal', 'owner', { extra: true } as never)).rejects.toThrow();
  });

});
