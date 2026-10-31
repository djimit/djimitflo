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

});
