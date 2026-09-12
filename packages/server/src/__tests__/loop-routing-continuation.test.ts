import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';
import { MetaOrchestrationService } from '../services/meta-orchestration-service';
import { NestedSpawnService } from '../services/nested-spawn-service';
import { OperatorInterventionService } from '../services/operator-intervention';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';

let root: string;
let db: Database.Database;
let loops: LoopService;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-routing-continuation-'));
  vi.stubEnv('LOOP_WORKTREE_ROOT', path.join(root, 'worktrees'));
  vi.stubEnv('PI_OFFLINE', '0');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'A disposable documentation fixture\n');
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture'], { cwd: repo, stdio: 'ignore' });
  db = new Database(':memory:'); db.exec(schema); runMigrations(db);
  loops = new LoopService(db, path.join(root, 'evidence'));
  db.prepare(`INSERT INTO loop_runs (id,loop_name,mode,status,repository_path,findings_json,metadata)
    VALUES ('routing-run','doc-drift-and-small-fix-loop','closed','planning',?,?,?)`).run(repo,
    JSON.stringify([{ id: 'finding', type: 'todo_marker', severity: 'low', file: 'README.md', message: 'Improve wording', evidence: 'Small text', suggested_fix: 'Clarify wording' }]),
    JSON.stringify({ risk_class: 'low' }));
});
afterEach(() => { db.close(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

function capability(id = 'todo_marker', overrides: Record<string, unknown> = {}) {
  db.prepare(`INSERT INTO swarm_capabilities (id,kind,owner,version,status,risk_ceiling,input_schema_ref,output_schema_ref,allowed_actions_json,
    forbidden_actions_json,required_evidence_json,eval_score,eval_threshold,removal_strategy,cost_model_json,metadata)
    VALUES (?,'runtime_adapter','fixture','1','validated','low','fixture-input','fixture-output','["spawn_runtime_worker"]','["deploy"]','["fixture-proof"]',1,0.8,'manual-review','{}','{}')`).run(id);
  for (const [column, value] of Object.entries(overrides)) {
    if (!['status', 'eval_score', 'risk_ceiling', 'forbidden_actions_json', 'cost_model_json', 'metadata'].includes(column)) throw new Error('Invalid fixture column');
    db.prepare(`UPDATE swarm_capabilities SET ${column} = ? WHERE id = ?`).run(value, id);
  }
}

function history(runtime: string, status: string, count = 1) {
  db.prepare("INSERT OR IGNORE INTO loop_runs (id,loop_name,mode,status) VALUES ('history-run','fixture','closed','completed')").run();
  for (let i = 0; i < count; i++) db.prepare(`INSERT INTO worker_leases (id,loop_run_id,role,runtime,status,capability_id,metadata)
    VALUES (?,'history-run','maker',?,?,'todo_marker','{}')`).run(`history-${runtime}-${status}-${i}`, runtime, status);
}

it('does not convert a model-only recommendation into an implicit mock runtime', () => {
  loops.setMetaOrchestration(new MetaOrchestrationService(db));
  const result = loops.continueLoopRun('routing-run');
  expect(result.leases.find(lease => lease.role === 'maker')?.runtime).toBe('manual');
  expect(db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 0 });
});

it('carries per-finding advisory planning into explicit mock execution without relabelling execution evidence', async () => {
  capability(); history('claude', 'completed', 3); history('codex', 'failed', 3);
  const plan = loops.planLoopRun('routing-run');
  expect(plan[0]).toMatchObject({ findingId: 'finding', capabilityId: 'todo_marker', runtime: 'claude' });
  const result = loops.continueLoopRun('routing-run', { runtime: 'mock' });
  const maker = result.leases.find(lease => lease.finding_id === 'finding' && lease.role === 'maker')!;
  expect(maker).toMatchObject({ runtime: 'mock', metadata: { requested_runtime: 'mock', effective_runtime: 'mock', routing_recommendation: plan[0] } });
  expect(db.prepare('SELECT capability_id FROM worker_leases WHERE id = ?').get(maker.id)).toEqual({ capability_id: null });
  expect(db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 0 });
  expect(loops.listLoopEvents('routing-run').find(event => event.event_type === 'worker_leases_prepared')?.metadata)
    .toMatchObject({ routing_recommendations: plan });
  const execution = await loops.executeMaker('routing-run', { lease_id: maker.id });
  expect(execution.lease).toMatchObject({ runtime: 'mock', status: 'completed', metadata: { runtime_adapter: 'mock', routing_recommendation: plan[0] } });
  expect(fs.existsSync(execution.stdout_path)).toBe(true);
  expect(db.prepare('SELECT capability_id FROM worker_leases WHERE id = ?').get(maker.id)).toEqual({ capability_id: null });
});

it('persists explicit Astra model and reasoning choices on a loop maker lease', () => {
  const result = loops.continueLoopRun('routing-run', {
    runtime: 'mock', model: 'gpt-6-astra', reasoningEffort: 'max', max_assignments: 1,
  });
  expect(result.leases.find(lease => lease.role === 'maker')).toMatchObject({
    runtime: 'mock', metadata: { model: 'gpt-6-astra', reasoningEffort: 'max' },
  });
});

it('carries explicit Astra choices onto a retry maker lease', () => {
  const prepared = loops.continueLoopRun('routing-run', { runtime: 'mock', model: 'gpt-6-astra', reasoningEffort: 'max' });
  const maker = prepared.leases.find(lease => lease.role === 'maker')!;
  loops.updateWorkerLeaseStatus(maker.id, 'failed', { failure: 'fixture' });
  const retried = loops.retryLoopRun('routing-run', {
    maker_lease_id: maker.id, runtime: 'mock',
  });
  expect(retried.retry_maker).toMatchObject({
    runtime: 'mock', metadata: { model: 'gpt-6-astra', reasoningEffort: 'max', retry_of_maker_lease_id: maker.id },
  });
});

it.each([
  [{ model: '' }, 'INVALID_EXECUTION_MODEL'],
  [{ model: 'x'.repeat(201) }, 'INVALID_EXECUTION_MODEL'],
  [{ reasoningEffort: 'unbounded' }, 'INVALID_REASONING_EFFORT'],
])('rejects invalid explicit runtime selection before worktree creation', (input, error) => {
  expect(() => loops.continueLoopRun('routing-run', { ...input, runtime: 'mock' } as any)).toThrow(error);
  expect(loops.listWorkerLeases('routing-run')).toEqual([]);
  expect(fs.existsSync(path.join(root, 'worktrees'))).toBe(false);
});

it.each([
  ['disabled', { status: 'disabled' }], ['unevaluated', { eval_score: 0 }],
  ['forbidden', { forbidden_actions_json: '["spawn_runtime_worker"]' }],
])('does not recommend a %s capability', (_label, overrides) => {
  capability('todo_marker', overrides); history('codex', 'completed', 3);
  expect(loops.planLoopRun('routing-run')[0]).toMatchObject({ capabilityId: '', runtime: 'manual' });
});

it('does not claim the newest unrelated capability matches a finding', () => {
  capability('unrelated-capability');
  expect(loops.planLoopRun('routing-run')[0]).toMatchObject({ capabilityId: '', runtime: 'manual' });
});

it('does not infer a provider from capability-wide cheap token counts or success metadata', () => {
  capability('todo_marker', { cost_model_json: '{"learned":true,"p50_tokens":1000}', metadata: '{"competence":{"success_rate":0.99}}' });
  expect(loops.planLoopRun('routing-run')[0]).toMatchObject({ capabilityId: 'todo_marker', runtime: 'manual' });
});

it('does not promote mock completion history into a runtime recommendation', () => {
  capability(); history('mock', 'completed', 4);
  expect(loops.planLoopRun('routing-run')[0]).toMatchObject({ capabilityId: 'todo_marker', runtime: 'manual' });
});

it('keeps sovereign Pi advice advisory and preserves an explicit manual choice', () => {
  db.prepare('UPDATE loop_runs SET metadata = ? WHERE id = ?').run('{"risk_class":"low","sovereign":true}', 'routing-run');
  expect(loops.planLoopRun('routing-run')[0].runtime).toBe('pi');
  const maker = loops.continueLoopRun('routing-run', { runtime: 'manual' }).leases.find(lease => lease.role === 'maker');
  expect(maker).toMatchObject({ runtime: 'manual', metadata: { routing_recommendation: { runtime: 'pi' } } });
});

it('rejects an unavailable explicitly selected runtime before preparing any worktree or lease', () => {
  vi.stubEnv('CODEX_BIN_PATH', path.join(root, 'unavailable-codex'));
  expect(() => loops.continueLoopRun('routing-run', { runtime: 'codex' })).toThrow('RUNTIME_UNAVAILABLE');
  expect(loops.listWorkerLeases('routing-run')).toEqual([]);
  expect(fs.existsSync(path.join(root, 'worktrees'))).toBe(false);
});

it('does not recommend a capability below the run risk ceiling', () => {
  capability(); history('codex', 'completed', 3);
  db.prepare('UPDATE loop_runs SET metadata = ? WHERE id = ?').run('{"risk_class":"high"}', 'routing-run');
  expect(loops.planLoopRun('routing-run')[0]).toMatchObject({ capabilityId: '', runtime: 'manual' });
});

it.each(['continue', 'retry', 'split'])('blocks %s before writes when the run or owning goal is explicitly operator-paused', (action) => {
  const goal = loops.createGoal({ objective: 'Fixture goal', acceptance_criteria: ['Fixture'] });
  db.prepare('UPDATE goals SET metadata = ? WHERE id = ?').run('{"operator_paused":true}', goal.id);
  for (const pausedOwner of ['run', 'goal']) {
    db.prepare('UPDATE loop_runs SET goal_id = ?, metadata = ? WHERE id = ?').run(
      pausedOwner === 'goal' ? goal.id : null, JSON.stringify({ operator_paused: pausedOwner === 'run', provenance: 'keep' }), 'routing-run');
    const before = db.prepare('SELECT * FROM loop_runs WHERE id = ?').get('routing-run');
    const actions = {
      continue: () => loops.continueLoopRun('routing-run', { runtime: 'mock' }),
      retry: () => loops.retryLoopRun('routing-run', { runtime: 'mock' }),
      split: () => loops.splitLoopFinding('routing-run', { finding_id: 'finding', reason: 'Fixture', children: [{ message: 'First', suggested_fix: 'First' }, { message: 'Second', suggested_fix: 'Second' }] }),
    };
    expect(actions[action as keyof typeof actions]).toThrow('LOOP_OPERATOR_PAUSED');
    expect(db.prepare('SELECT * FROM loop_runs WHERE id = ?').get('routing-run')).toEqual(before);
    expect(loops.listWorkerLeases('routing-run')).toEqual([]);
  }
});

it('preserves a blocked goal review workflow when no operator-pause flag exists', () => {
  const goal = loops.createGoal({ objective: 'Fixture goal', acceptance_criteria: ['Fixture'] });
  loops.updateGoal(goal.id, { status: 'blocked' });
  db.prepare('UPDATE loop_runs SET goal_id = ? WHERE id = ?').run(goal.id, 'routing-run');
  expect(loops.continueLoopRun('routing-run', { runtime: 'manual' }).leases).toHaveLength(2);
});

it('blocks nested root and direct lease materialization after a quiescent operator pause', async () => {
  const intelligence = new SwarmIntelligenceService(db);
  const goal = loops.createGoal({ objective: 'Nested fixture', acceptance_criteria: ['No provider'] });
  db.prepare('UPDATE loop_runs SET goal_id = ? WHERE id = ?').run(goal.id, 'routing-run');
  await new OperatorInterventionService(db, loops, intelligence).pauseGoal(goal.id);
  const spawns = new NestedSpawnService(db, loops, { intelligence, secret: 'disposable-fixture-only' });
  expect(() => spawns.createRoot({ loop_run_id: 'routing-run', runtime: 'manual', role: 'maker', prompt: 'Fixture root' })).toThrow('LOOP_OPERATOR_PAUSED');
  expect(() => loops.prepareNestedLease({ loopRunId: 'routing-run', runtime: 'manual', role: 'maker', prompt: 'Fixture direct', parentLeaseId: null, spawnTreeId: 'fixture-tree', depth: 0, allowNestedSpawn: false, depthBudget: 0 })).toThrow('LOOP_OPERATOR_PAUSED');
  expect(loops.listWorkerLeases('routing-run')).toEqual([]);
  expect(db.prepare('SELECT COUNT(*) AS count FROM spawn_trees').get()).toEqual({ count: 0 });
  expect(fs.existsSync(path.join(root, 'worktrees'))).toBe(false);
});

it('audits a paused nested child denial without creating a worktree, lease or budget grant', async () => {
  const intelligence = new SwarmIntelligenceService(db);
  const goal = loops.createGoal({ objective: 'Nested fixture', acceptance_criteria: ['No provider'] });
  db.prepare('UPDATE loop_runs SET goal_id = ? WHERE id = ?').run(goal.id, 'routing-run');
  const spawns = new NestedSpawnService(db, loops, { intelligence, secret: 'disposable-fixture-only' });
  const parent = spawns.createRoot({ loop_run_id: 'routing-run', runtime: 'manual', role: 'maker', prompt: 'Fixture root', depth_budget: 2 });
  loops.updateWorkerLeaseStatus(parent.root_lease_id, 'completed', { notes: 'Manual fixture state; no runtime was executed' });
  await new OperatorInterventionService(db, loops, intelligence).pauseGoal(goal.id);
  const tree = spawns.getSpawnTree(parent.spawn_tree_id);
  const worktrees = fs.readdirSync(path.join(root, 'worktrees', 'routing-run'));
  const result = spawns.requestSpawn({ spawn_tree_id: parent.spawn_tree_id, parent_lease_id: parent.root_lease_id,
    requested_by_lease_id: parent.root_lease_id, runtime: 'manual', role: 'checker', prompt: 'Fixture child', token: parent.control_token });
  expect(result).toMatchObject({ status: 'gated_out', reject_reason: 'operator_paused' });
  expect(loops.listWorkerLeases('routing-run')).toHaveLength(1);
  expect(spawns.getSpawnTree(parent.spawn_tree_id)).toEqual(tree);
  expect(fs.readdirSync(path.join(root, 'worktrees', 'routing-run'))).toEqual(worktrees);
  expect(db.prepare('SELECT status,reject_reason,child_lease_id,token_budget_grant,wall_budget_ms FROM sub_agent_spawns WHERE id = ?').get(result.spawn_id))
    .toEqual({ status: 'gated_out', reject_reason: 'operator_paused', child_lease_id: null, token_budget_grant: null, wall_budget_ms: null });
});
