/**
 * S2 — prepared-but-not-started work stays visible as not started and is never shown as success (E3).
 *
 * Three normal entries that leave work prepared without a start, each followed by the projections the dashboard reads:
 *  a) POST /api/loops/start + POST /api/swarms/spawns/root (runtime mock) → a prepared root lease (spawn tree open)
 *  b) POST /api/tasks (risk high) + POST /api/tasks/:id/execute {executor:mock} → the engine's approval gate holds it
 *  c) POST /api/work-items/integrations/import + POST /api/swarms/scheduler/tick {prepare_planned} → prepared maker/checker
 * Nothing is executed after the preparation; no DB writes by the test. Projections read: GET /api/swarms/spawns/:id/status,
 * GET /api/loops/runs/:id, GET /api/loops/runs, GET /api/tasks/:id, GET /api/tasks, GET /api/health/needs-you,
 * GET /api/health/cockpit, GET /api/swarms/intelligence/mission-control.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const fs = require('fs') as typeof import('fs'); const os = require('os') as typeof import('os'); const path = require('path') as typeof import('path');
  process.env.LOOP_EVIDENCE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-s02-evidence-'));
  process.env.LOOP_WORKTREE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-s02-worktrees-'));
});

import fs from 'fs';
import { startHarness, makeFixtureRepo, recordObs, type Harness } from './harness';

const SUCCESS = /^(completed|succeeded|success|done|verified|certified|passed)$/;

/** Every `status` value found anywhere under objects that mention `id` (deep), for a projection-wide "never success" check. */
function statusesMentioning(value: unknown, id: string): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if (Object.values(o).some((x) => x === id) && typeof o.status === 'string') out.push(o.status);
    Object.values(o).forEach(walk);
  };
  walk(value);
  return out;
}

const failing = process.env.SCENARIO_STRICT === '1' ? it : it.fails;
let s2c: { run_status: unknown; leases: Array<{ status: string }> } | null = null;

describe('S2 prepared-but-not-started (E3)', { timeout: 120_000 }, () => {
  let h: Harness;
  let repo: string; // README has a TODO → the loop run has a finding and stays 'planning'
  let cleanRepo: string; // nothing to find → the loop run is 'completed' (no_change_required) at start
  beforeAll(async () => {
    h = await startHarness();
    repo = makeFixtureRepo('djimitflo-s02-repo-', 'TODO: document the S2 fixture\n');
    cleanRepo = makeFixtureRepo('djimitflo-s02-clean-');
  });
  afterAll(async () => { await h.close(); for (const r of [repo, cleanRepo]) fs.rmSync(r, { recursive: true, force: true }); });

  async function preparedRoot(name: string, repositoryPath: string) {
    const run = await h.api('POST', '/loops/start', { repository_path: repositoryPath });
    expect(run.status).toBe(201);
    const root = await h.api('POST', '/swarms/spawns/root', { loop_run_id: run.body.id, runtime: 'mock', role: 'maker', prompt: 'S2 prepared root (never started)', depth_budget: 0 });
    expect(root.status).toBe(201);
    const leaseId = root.body.root_lease_id as string;

    // give any in-process scheduler a chance; nothing in this process starts a prepared root lease
    await new Promise((r) => setTimeout(r, 1500));
    const spawn = await h.api('GET', `/swarms/spawns/${leaseId}/status`);
    const runView = await h.api('GET', `/loops/runs/${run.body.id}`);
    const runs = await h.api('GET', '/loops/runs');
    const cockpit = await h.api('GET', '/health/cockpit');
    const needsYou = await h.api('GET', '/health/needs-you');
    const mission = await h.api('GET', '/swarms/intelligence/mission-control');
    const lease = (runView.body.leases ?? []).find((l: { id: string }) => l.id === leaseId)
      ?? h.db.prepare('SELECT id, status, metadata FROM worker_leases WHERE id = ?').get(leaseId);
    const obs = {
      spawn_status: spawn.status === 200 ? { status: spawn.body.status, lease_status: spawn.body.lease_status ?? spawn.body.child_status ?? null } : spawn,
      run_status: runView.body.status, lease_status: lease?.status, lease_started_at: (typeof lease?.metadata === 'string' ? JSON.parse(lease.metadata) : lease?.metadata ?? {}).started_at ?? null,
      runs_list_status: (runs.body.runs ?? []).find((r: { id: string }) => r.id === run.body.id)?.status,
      statuses_mentioning_lease: {
        spawn: statusesMentioning(spawn.body, leaseId), run: statusesMentioning(runView.body, leaseId), cockpit: statusesMentioning(cockpit.body, leaseId),
        needs_you: statusesMentioning(needsYou.body, leaseId), mission: statusesMentioning(mission.body, leaseId),
      },
      statuses_mentioning_run: { runs: statusesMentioning(runs.body, run.body.id), cockpit: statusesMentioning(cockpit.body, run.body.id), mission: statusesMentioning(mission.body, run.body.id) },
      http: { spawn: spawn.status, run: runView.status, runs: runs.status, cockpit: cockpit.status, needs_you: needsYou.status, mission: mission.status },
      outbound: [...h.outbound],
    };
    recordObs(name, obs);
    return { obs, spawn, run: run.body };
  }

  it('S2-a prepared spawn root on an open (planning) run: lease stays prepared in every projection, never success', async () => {
    const { obs, spawn } = await preparedRoot('S2-a', repo);
    expect(obs.run_status).toBe('planning');
    expect(obs.lease_status).toBe('prepared');
    expect(obs.lease_started_at).toBeNull();
    expect(spawn.status).toBe(200);
    expect(spawn.body.status).toBe('prepared');
    for (const list of [...Object.values(obs.statuses_mentioning_lease), ...Object.values(obs.statuses_mentioning_run)]) {
      expect((list as string[]).filter((s) => SUCCESS.test(s))).toEqual([]);
    }
    expect(h.outbound).toEqual([]);
  });

  failing('FAIL D-S2-1 a prepared spawn root attached to a run that is already "completed" leaves the run shown as completed', async () => {
    const { obs } = await preparedRoot('S2-a-terminal-run', cleanRepo);
    expect(obs.lease_status).toBe('prepared');
    expect(obs.lease_started_at).toBeNull();
    // expected: either the root is refused for a terminal run, or the run is no longer projected as a success
    expect(SUCCESS.test(String(obs.run_status))).toBe(false);
    expect((obs.statuses_mentioning_run.runs as string[]).filter((s) => SUCCESS.test(s))).toEqual([]);
  });

  it('S2-b task held by the approval gate: awaiting_approval, not started, visible in needs-you, never success', async () => {
    const created = await h.api('POST', '/tasks', { title: 'S2 approval-held task', description: 'deploy to production (S2 scenario, mock)', risk_level: 'high', execution_mode: 'local', use_swarm_context: false });
    expect([200, 201]).toContain(created.status);
    const taskId = created.body.id as string;
    const executed = await h.api('POST', `/tasks/${taskId}/execute`, { executor: 'mock' });
    await new Promise((r) => setTimeout(r, 1500));
    const task = await h.api('GET', `/tasks/${taskId}`);
    const tasks = await h.api('GET', '/tasks');
    const approvals = await h.api('GET', `/tasks/${taskId}/approvals`);
    const needsYou = await h.api('GET', '/health/needs-you');
    const cockpit = await h.api('GET', '/health/cockpit');
    const approvalIds = (approvals.body.approvals ?? []).map((a: { id: string }) => a.id);
    const needsYouText = JSON.stringify(needsYou.body);
    const obs = {
      execute: { http: executed.status, status: executed.body.status, message: executed.body.message },
      task_status: task.body.status, started_at: task.body.started_at ?? null, completed_at: task.body.completed_at ?? null,
      list_status: (tasks.body.tasks ?? tasks.body ?? []).find?.((t: { id: string }) => t.id === taskId)?.status,
      approvals: (approvals.body.approvals ?? []).map((a: { id: string; status: string }) => ({ id: a.id, status: a.status })),
      needs_you_mentions_task_or_approval: needsYouText.includes(taskId) || approvalIds.some((id: string) => needsYouText.includes(id)),
      needs_you_count: Array.isArray(needsYou.body.needs_you) ? needsYou.body.needs_you.length : needsYou.body.needs_you,
      statuses_mentioning_task: { tasks: statusesMentioning(tasks.body, taskId), needs_you: statusesMentioning(needsYou.body, taskId), cockpit: statusesMentioning(cockpit.body, taskId) },
      outbound: [...h.outbound],
    };
    recordObs('S2-b', obs);

    expect(executed.status).toBe(200);
    expect(executed.body.status).toBe('awaiting_approval');
    expect(task.body.status).toBe('awaiting_approval');
    expect(obs.started_at).toBeNull();
    expect(obs.approvals.some((a: { status: string }) => a.status === 'pending')).toBe(true);
    expect((obs.needs_you_count as { approvals: number }).approvals).toBeGreaterThanOrEqual(1); // needs-you is counts, not ids
    for (const list of Object.values(obs.statuses_mentioning_task)) expect(list.filter((s) => SUCCESS.test(s))).toEqual([]);
    expect(h.outbound).toEqual([]);
  });

  it('S2-c work item prepared by the scheduler tick: leases prepared, mission control shows no completed/successful run', async () => {
    const imported = await h.api('POST', '/work-items/integrations/import', {
      source: 'dashboard_action', source_ref: 'dashboard:s2-prepared', title: 'S2 prepared work item', description: 'Prepared by the tick, never drained.',
      risk_class: 'low', recommended_loop: 'doc-drift-and-small-fix-loop',
      metadata: { repository_path: repo, integration: { requested_runtime: 'mock', production_pilot: true, manual_interventions: 0 } },
    });
    expect(imported.status).toBe(201);
    const workItemId = imported.body.work_item.id as string;
    const tick = await h.api('POST', '/swarms/scheduler/tick', { max_items: 1, plan_triaged: true, prepare_planned: true, runtime: 'mock', work_item_ids: [workItemId] });
    expect(tick.status).toBe(200);
    const loopRunId = tick.body.prepared_work_items?.[0]?.metadata?.loop_run_id as string;
    expect(loopRunId).toBeTruthy();

    await new Promise((r) => setTimeout(r, 1500));
    const mission = await h.api('GET', '/swarms/intelligence/mission-control');
    const workItem = await h.api('GET', `/work-items/${workItemId}`);
    const runView = await h.api('GET', `/loops/runs/${loopRunId}`);
    const leases = (h.db.prepare('SELECT role, runtime, status FROM worker_leases WHERE loop_run_id = ? ORDER BY role').all(loopRunId)) as Array<{ role: string; runtime: string; status: string }>;
    const spine = mission.body.integration_spine?.latest ?? null;
    const obs = {
      tick_prepared: tick.body.prepared_work_items?.map((w: { id: string; status: string }) => ({ id: w.id, status: w.status })),
      leases, run_status: runView.body.status, work_item_status: workItem.body.status ?? workItem.body.work_item?.status,
      mission_spine: spine ? { work_item_status: spine.work_item?.status, leases: spine.leases, next_safe_action: spine.next_safe_action } : null,
      production_pilot_metrics: mission.body.production_pilot?.metrics ?? null,
      statuses_mentioning_run: statusesMentioning(mission.body, loopRunId), statuses_mentioning_work_item: statusesMentioning(mission.body, workItemId),
      http: { mission: mission.status, work_item: workItem.status, run: runView.status },
      outbound: [...h.outbound],
    };
    recordObs('S2-c', obs);
    s2c = obs;

    expect(leases.map((l) => l.status)).toEqual(['prepared', 'prepared']);
    expect(mission.status).toBe(200);
    expect(SUCCESS.test(String(obs.run_status))).toBe(false);
    expect(SUCCESS.test(String(obs.work_item_status))).toBe(false);
    expect(obs.statuses_mentioning_run.filter((s) => SUCCESS.test(s))).toEqual([]);
    expect(obs.statuses_mentioning_work_item.filter((s) => SUCCESS.test(s))).toEqual([]);
    const m = obs.production_pilot_metrics as Record<string, number> | null;
    if (m) {
      expect(m.completed_runs ?? 0).toBe(0);
      expect(m.success_rate ?? 0).not.toBe(1);
    }
    expect(h.outbound).toEqual([]);
  });

  failing('FAIL D-S2-2 the loop run of S2-c is projected as "running" while none of its leases has started', () => {
    expect(s2c, 'S2-c ran first').toBeTruthy();
    expect(s2c!.leases.every((l) => l.status === 'prepared')).toBe(true);
    expect(s2c!.run_status).not.toBe('running');
  });
});
