/**
 * S1 — normal entry → real start → stored result → independent check → cost row → dashboard projection (E3).
 *
 * Leg A (verified work, chain C01): POST /api/goals (the dashboard's goal entry) → LoopDaemon.tick() (the scheduler the
 * autonomous profile runs, src/index.ts:140) → objective loop → maker lease on the mock runtime → deterministic checks
 * (test/lint/type-check in the maker's worktree) → automated checker lease → verifyLoopRun → model-call ledger rows →
 * GET /api/goals/:id, GET /api/loops/runs/:id.
 * Leg B (engine leg): POST /api/tasks → POST /api/tasks/:id/execute {executor:'mock'} → ExecutionEngine task 'running'
 * → 'completed' → GET /api/tasks/:id + /events.
 *
 * Configuration is process env of this test only (no runtime.env, no prod flags). No real runtime is started: the
 * maker/checker are the built-in deterministic mock commands (process.execPath -e …) and the engine runs MockExecutor.
 *
 * Tests named "FAIL D-…" assert the expected behaviour and currently fail; they are declared `it.fails` so the suite
 * stays green while the defect is open (they turn red once it is fixed). SCENARIO_STRICT=1 runs them as plain `it` to
 * see the raw assertion failure.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const fs = require('fs') as typeof import('fs'); const os = require('os') as typeof import('os'); const path = require('path') as typeof import('path');
  process.env.LOOP_EVIDENCE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-s01-evidence-')); // read at module load
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import { startHarness, makeFixtureRepo, until, envSnapshot, recordObs, type Harness } from './harness';
import { LoopDaemon } from '../../services/loop-daemon';
import { LoopService } from '../../services/loop-service';

const failing = process.env.SCENARIO_STRICT === '1' ? it : it.fails;
const ENV_KEYS = ['SELF_IMPROVEMENT_OBJECTIVE_LOOP_ENABLED', 'LOOP_DAEMON_MAKER_RUNTIME', 'LOOP_DAEMON_REPOSITORY_PATH',
  'LOOP_DAEMON_AUTOMATED_CHECKER_ENABLED', 'LOOP_DAEMON_AUTOMATED_SECURITY_CHECKER_ENABLED', 'LOOP_WORKTREE_ROOT',
  'DJIMITFLO_CONTROL_URL', 'LOOP_BANDIT_ENABLED', 'AUTHORITY_GATE'];

type Lease = { id: string; role: string; runtime: string; status: string; metadata: Record<string, any> };

describe('S1 normal entry (E3, mock executor)', { timeout: 120_000 }, () => {
  let h: Harness;
  let restore: () => void;
  let repo: string;
  let worktreeRoot: string;

  // one server + DB per file, as in production (one process, one DB): services built by createRoutes subscribe to the
  // process-wide swarmEventBus with their DB handle, so a second harness in the same module graph would see the first's
  beforeAll(async () => { h = await startHarness(); });
  afterAll(async () => { await h.close(); });

  beforeEach(async () => {
    restore = envSnapshot(ENV_KEYS);
    for (const k of ENV_KEYS) delete process.env[k];
    h.outbound.length = 0;
    repo = makeFixtureRepo('djimitflo-s01-repo-');
    worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-s01-worktrees-'));
    process.env.SELF_IMPROVEMENT_OBJECTIVE_LOOP_ENABLED = 'true';
    process.env.LOOP_DAEMON_MAKER_RUNTIME = 'mock';
    process.env.LOOP_DAEMON_REPOSITORY_PATH = repo;
    process.env.LOOP_DAEMON_AUTOMATED_CHECKER_ENABLED = 'true';
    process.env.LOOP_WORKTREE_ROOT = worktreeRoot;
  });

  afterEach(async () => {
    restore();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  });

  /** POST /api/goals → one LoopDaemon tick → wait (via GET /api/goals/:id) until the goal leaves its queue states. */
  async function runGoal(objective: string) {
    const created = await h.api('POST', '/goals', {
      objective, acceptance_criteria: ['test, lint and type-check pass'], risk_class: 'low', metadata: { source: 'self-improvement' },
    });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('created');
    const goalId = created.body.id as string;

    const daemon = new LoopDaemon(h.db, new LoopService(h.db), { pollMs: 3_600_000, maxConcurrentGoals: 1 });
    await daemon.tick();
    daemon.stop();
    const goal = await until(async () => {
      const g = await h.api('GET', `/goals/${goalId}`);
      return ['completed', 'failed', 'blocked'].includes(g.body.status) ? g.body : null;
    }, 90_000, 250);

    const runId = (h.db.prepare('SELECT id FROM loop_runs WHERE goal_id = ? ORDER BY created_at DESC LIMIT 1').get(goalId) as { id: string }).id;
    const leases = (h.db.prepare('SELECT id, role, runtime, status, metadata FROM worker_leases WHERE loop_run_id = ? ORDER BY created_at').all(runId) as Array<Lease & { metadata: string }>)
      .map((l) => ({ ...l, metadata: JSON.parse(l.metadata || '{}') })) as Lease[];
    const ledger = h.db.prepare('SELECT consumer, model, provider, ok, tokens_in, tokens_out, list_price_cost, marginal_cost, cost_basis, status FROM llm_model_calls WHERE run_id = ? ORDER BY consumer').all(runId) as Array<Record<string, any>>;
    const events = (h.db.prepare('SELECT event_type, level, message FROM loop_events WHERE loop_run_id = ? ORDER BY created_at').all(runId) as Array<{ event_type: string; level: string; message: string }>)
      .map((e) => `${e.event_type}:${e.level}:${e.message.slice(0, 140)}`);
    const run = (await h.api('GET', `/loops/runs/${runId}`)).body;
    const obs = {
      goal_status: goal.status, run_status: run.status,
      gates: (run.gates ?? []).map((g: { name: string; status: string }) => `${g.name}:${g.status}`),
      leases: leases.map((l) => ({ role: l.role, runtime: l.runtime, status: l.status, started_at: l.metadata.started_at ?? null,
        exit_status: l.metadata.exit_status ?? null, execution_task_id: l.metadata.execution_task_id ?? null, verdict: l.metadata.verdict ?? null,
        runtime_usage: l.metadata.runtime_usage ?? null })),
      ledger, events, outbound: [...h.outbound],
    };
    return { goalId, runId, goal, run, leases, ledger, events, obs };
  }

  it('S1-A chain: POST /api/goals → LoopDaemon.tick → mock maker started + result stored → checks + checker → ledger rows', async () => {
    const r = await runGoal('S1 scenario: document the fixture README');
    recordObs('S1-A', r.obs);
    const maker = r.leases.find((l) => l.role === 'maker')!;
    const checker = r.leases.find((l) => l.role === 'checker');

    // real start: the maker lease went running (started_at) and its runtime process exited 0
    expect(maker.runtime).toBe('mock');
    expect(maker.metadata.started_at).toBeTruthy();
    expect(maker.metadata.exit_status).toBe(0);
    expect(maker.status).toBe('completed');
    // result stored: maker stdout evidence persisted on disk
    expect(fs.readFileSync(maker.metadata.stdout_path, 'utf8')).toContain('[mock-worker] starting');
    // independent check: deterministic checks (test/lint/type-check in the worktree) passed, and a separate checker lease ran
    expect(r.events.some((e) => e.startsWith('deterministic_checks_completed:info'))).toBe(true);
    expect(r.obs.gates).toContain('tests_lint_typecheck:pass');
    expect(checker?.status).toBe('completed');
    expect(checker?.metadata.verdict).toBe('accepted');
    expect(r.obs.gates.filter((g: string) => g.endsWith(':fail') || g.endsWith(':unknown'))).toEqual([]);
    // cost accounting: a maker and a checker ledger row; no price for the mock → cost NULL with basis 'unknown' (never 0)
    expect(r.ledger.map((x) => x.consumer)).toEqual(['checker', 'maker']);
    for (const row of r.ledger) { expect(row.list_price_cost).toBeNull(); expect(row.marginal_cost).toBeNull(); expect(row.cost_basis).toBe('unknown'); }
    expect(r.obs.outbound).toEqual([]);
  });

  failing('FAIL D-S1-1 projection: a run with 0 failed gates (security review skipped: not high-risk) is shown as goal "failed" / run "blocked"', async () => {
    const r = await runGoal('S1 scenario: document the fixture README');
    // the product's own verification says ready_for_human_merge with nothing failed, and the ledger says verified …
    expect(r.events.some((e) => e.startsWith('loop_verified:info:Verification status: ready_for_human_merge; 0 gate(s)'))).toBe(true);
    expect(r.ledger.find((x) => x.consumer === 'maker')?.status).toBe('verified');
    // … so the dashboard projection must not call it failed
    expect(r.goal.status).not.toBe('failed');
    expect(r.run.status).not.toBe('blocked');
  });

  failing('FAIL D-S1-2 cost: the maker ledger row loses the in/out token split the lease recorded (prompt/completion keys)', async () => {
    const r = await runGoal('S1 scenario: document the fixture README');
    const maker = r.leases.find((l) => l.role === 'maker')!;
    const makerRow = r.ledger.find((x) => x.consumer === 'maker')!;
    expect(maker.metadata.runtime_usage).toMatchObject({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
    // the checker row for the same mock usage is (1, 2); the maker row must be too
    expect(r.ledger.find((x) => x.consumer === 'checker')).toMatchObject({ tokens_in: 1, tokens_out: 2 });
    expect(makerRow).toMatchObject({ tokens_in: 1, tokens_out: 2 });
  });

  it('S1-A control: the same entry reaches goal "completed" when the run is high-risk and the security checker is dispatched', async () => {
    process.env.LOOP_DAEMON_AUTOMATED_SECURITY_CHECKER_ENABLED = 'true';
    // 'auth' in the objective makes the finding sensitive (loop-service.ts SENSITIVE_CONTENT) → security review required
    const r = await runGoal('S1 control: document the auth flow in the fixture README');
    recordObs('S1-A-control', r.obs);
    expect(r.obs.gates).toContain('security_checker_verdict:pass');
    expect(r.goal.status).toBe('completed');
    expect(r.run.status).toBe('completed');
    expect(r.obs.outbound).toEqual([]);
  });

  it('S1-A engine leg: on the loop path the mock maker never becomes an ExecutionEngine task (no execution_task_id, no tasks row)', async () => {
    const r = await runGoal('S1 scenario: document the fixture README');
    // recorded as an observation, not a pass/fail of the product: loop-worker-executor-service.ts:344 runs runtime 'mock'
    // through executeMockWorker, every other runtime through executeViaEngine (tasks row + approval policy)
    expect(r.leases.every((l) => l.metadata.execution_task_id === undefined)).toBe(true);
    expect((h.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE id LIKE 'loop-worker-%'").get() as { n: number }).n).toBe(0);
  });

  it('S1-B engine leg: POST /api/tasks + /execute {executor:mock} → engine task running → completed, events + projection', async () => {
    const created = await h.api('POST', '/tasks', {
      title: 'S1 engine leg', description: 'echo from the S1 scenario', risk_level: 'low', execution_mode: 'local', use_swarm_context: false,
    });
    expect([200, 201]).toContain(created.status);
    const taskId = created.body.id as string;

    const executed = await h.api('POST', `/tasks/${taskId}/execute`, { executor: 'mock' });
    expect(executed.status).toBe(200);
    const statuses: string[] = [];
    const final = await until(async () => {
      const t = await h.api('GET', `/tasks/${taskId}`);
      if (statuses[statuses.length - 1] !== t.body.status) statuses.push(t.body.status);
      return ['completed', 'failed', 'cancelled', 'awaiting_approval', 'denied'].includes(t.body.status) ? t.body : null;
    }, 60_000, 100);
    const events = await h.api('GET', `/tasks/${taskId}/events`);
    const row = h.db.prepare('SELECT status, started_at, completed_at, token_usage, execution_time_ms FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown>;
    const ledger = (h.db.prepare('SELECT COUNT(*) AS n FROM llm_model_calls').get() as { n: number }).n;
    const evidence = h.db.prepare('SELECT evidence_type, title FROM execution_evidence WHERE task_id = ?').all(taskId);
    recordObs('S1-B', { execute_response: executed.body.status, statuses, row, events: (events.body.events ?? []).length, evidence, llm_model_calls: ledger, outbound: h.outbound });

    expect(statuses).toContain('running');
    expect(final.status).toBe('completed');
    expect(row.started_at).toBeTruthy();
    expect((events.body.events ?? []).length).toBeGreaterThan(0);
    expect(h.outbound).toEqual([]);
  });
});
