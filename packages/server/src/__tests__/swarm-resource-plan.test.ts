import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { execFileSync } from 'child_process';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { createWorkItemRoutes } from '../routes/work-items';
import { createSwarmRoutes } from '../routes/swarms';
import { createMemoryRoutes } from '../routes/memory';
import { errorHandler } from '../middleware/error-handler';
import { SwarmStatusService } from '../services/swarm-status-service';

let db: Database.Database;
let server: Server;
let baseUrl: string;
let previousOkfBase: string | undefined;
let tempOkfBase: string;

const auth = {
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
} as any;

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/work-items', createWorkItemRoutes(db, auth));
  app.use('/swarms', createSwarmRoutes(db, auth));
  app.use('/memory', createMemoryRoutes(db, auth));
  app.use(errorHandler);

  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
}

describe('workstation swarm resource plan', () => {
  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    previousOkfBase = process.env.OKF_BASE;
    tempOkfBase = fs.mkdtempSync(`${os.tmpdir()}/djimitflo-okf-memory-`);
    process.env.OKF_BASE = tempOkfBase;
    await startApp();
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
    db.close();
    if (previousOkfBase) {
      process.env.OKF_BASE = previousOkfBase;
    } else {
      delete process.env.OKF_BASE;
    }
    fs.rmSync(tempOkfBase, { recursive: true, force: true });
  });

  it('keeps backlog candidates in Djimitflo DB as canonical work items', async () => {
    const createResponse = await fetch(`${baseUrl}/work-items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Validate Qdrant swarm memory ingestion',
        description: 'Check whether completed task outputs get embedded and searchable.',
        source: 'scheduler',
        source_ref: 'loop:abc',
        risk_class: 'medium',
        value_score: 82,
        confidence: 0.74,
        recommended_loop: 'okf-synchronization-loop',
        metadata: { evidence_path: 'agent-evidence/abc/LOOP_STATE.md' },
      }),
    });

    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as any;
    expect(created).toMatchObject({
      title: 'Validate Qdrant swarm memory ingestion',
      status: 'candidate',
      risk_class: 'medium',
      source: 'scheduler',
      recommended_loop: 'okf-synchronization-loop',
    });
    expect(created.id).toEqual(expect.any(String));

    const listResponse = await fetch(`${baseUrl}/work-items?status=candidate`);
    expect(listResponse.status).toBe(200);
    const listed = await listResponse.json() as any;
    expect(listed.work_items).toHaveLength(1);
    expect(listed.work_items[0].metadata).toMatchObject({ evidence_path: 'agent-evidence/abc/LOOP_STATE.md' });

    const updateResponse = await fetch(`${baseUrl}/work-items/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'triaged', assigned_runtime: 'codex' }),
    });
    expect(updateResponse.status).toBe(200);
    const updated = await updateResponse.json() as any;
    expect(updated).toMatchObject({ status: 'triaged', assigned_runtime: 'codex' });
  });

  it('reports swarm reality counts without treating registry rows as live workers', async () => {
    const now = new Date();
    const recent = now.toISOString();
    const stale = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

    db.prepare(`
      INSERT INTO agents (id, name, description, status, capabilities, metadata, last_active_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('agent-live', 'Live Agent', 'recent heartbeat', 'idle', '["coding"]', '{}', recent, recent, recent);
    db.prepare(`
      INSERT INTO agents (id, name, description, status, capabilities, metadata, last_active_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('agent-stale', 'Stale Agent', 'old heartbeat', 'idle', '["research"]', '{}', stale, stale, stale);
    db.prepare(`
      INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('loop-1', 'doc-drift-and-small-fix-loop', 'closed', 'ready_for_human_merge', '[]', '{}', '[]', '[]', '{"risk_class":"low"}', recent, recent);
    db.prepare(`
      INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('lease-1', 'loop-1', 'maker', 'codex', 'running', '{"pid":123,"artifact_path":"agent-evidence/loop-1/worker-output"}', recent, recent);
    db.prepare(`
      INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('lease-2', 'loop-1', 'maker', 'mock', 'prepared', '{}', recent, recent);
    db.prepare(`
      INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('lease-3', 'loop-1', 'checker', 'mock', 'completed', '{"runtime_usage":{"total_tokens":12}}', recent, recent);
    db.prepare(`
      INSERT INTO work_items (id, title, description, source, risk_class, value_score, confidence, status, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('wi-1', 'Follow up', 'candidate', 'test', 'low', 50, 0.6, 'candidate', '{}', recent, recent);

    const response = await fetch(`${baseUrl}/swarms/status`);
    expect(response.status).toBe(200);
    const status = await response.json() as any;

    expect(status.registry_agent_count).toBe(2);
    expect(status.live_agent_count).toBe(1);
    expect(status.worker_lease_count).toBe(2);
    expect(status.active_execution_count).toBe(1);
    expect(status.task_count.open_work_items).toBe(1);
    expect(status.task_count.open_loop_runs).toBe(1);
    expect(status.stale_agents).toEqual([expect.objectContaining({ id: 'agent-stale' })]);
    expect(status.reality_check.agent_count_is_registry_only).toBe(true);
    const mockPool = status.fleet_pools.find((pool: any) => pool.runtime === 'mock');
    expect(mockPool).toMatchObject({
      prepared_leases: 1,
      queued_leases: 1,
      running_leases: 0,
      completed_24h: 1,
      failed_24h: 0,
      tokens_used_24h: 12,
      tokens_per_successful_worker: 12,
      queue_depth_by_risk: { low: 1 },
    });
    expect(mockPool.available).toEqual(expect.any(Boolean));
    expect(mockPool.recommended_concurrency).toBeGreaterThanOrEqual(0);
    expect(status.fleet_topology).toEqual(expect.arrayContaining([
      expect.objectContaining({
        loop_run_id: 'loop-1',
        lease_id: 'lease-2',
        role: 'maker',
      }),
    ]));
  }, 15000);

  it('creates and accepts agent handoffs through the swarm message queue', async () => {
    const now = new Date().toISOString();
    for (const [id, name] of [['agent-maker', 'Maker Agent'], ['agent-memory', 'Memory Agent']]) {
      db.prepare(`
        INSERT INTO agents (id, name, description, status, capabilities, metadata, last_active_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, name, 'handoff test agent', 'idle', '[]', '{}', now, now, now);
    }
    db.prepare(`
      INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('loop-handoff', 'doc-drift-and-small-fix-loop', 'closed', 'running', '[]', '{}', '[]', '[]', '{"risk_class":"low"}', now, now);
    db.prepare(`
      INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('lease-handoff', 'loop-handoff', 'maker', 'codex', 'completed', '{"stdout_path":"agent-evidence/stdout.log"}', now, now);

    const response = await fetch(`${baseUrl}/swarms/handoffs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from_agent_id: 'agent-maker',
        to_agent_id: 'agent-memory',
        source_lease_id: 'lease-handoff',
        target_role: 'memory_curator',
        summary: 'Promote the completed worker evidence into durable memory.',
        evidence_ref: 'agent-evidence/stdout.log',
        priority: 'high',
      }),
    });
    expect(response.status).toBe(201);
    const handoff = await response.json() as any;
    expect(handoff).toMatchObject({
      from_agent_id: 'agent-maker',
      to_agent_id: 'agent-memory',
      type: 'task_delegation',
      priority: 'high',
      payload: {
        kind: 'swarm_handoff',
        source_lease_id: 'lease-handoff',
        loop_run_id: 'loop-handoff',
        target_role: 'memory_curator',
      },
    });

    const lease = db.prepare('SELECT metadata FROM worker_leases WHERE id = ?').get('lease-handoff') as any;
    expect(JSON.parse(lease.metadata)).toMatchObject({
      handoff_message_id: handoff.id,
      handed_off_to_agent_id: 'agent-memory',
    });

    const statusResponse = await fetch(`${baseUrl}/swarms/status`);
    const status = await statusResponse.json() as any;
    expect(status.open_handoffs).toEqual([
      expect.objectContaining({
        id: handoff.id,
        to_agent_id: 'agent-memory',
        source_lease_id: 'lease-handoff',
        loop_run_id: 'loop-handoff',
        target_role: 'memory_curator',
      }),
    ]);

    const acceptMemoryResponse = await fetch(`${baseUrl}/swarms/handoffs/${handoff.id}/accept`, { method: 'POST' });
    expect(acceptMemoryResponse.status).toBe(200);
    const acceptedMemory = await acceptMemoryResponse.json() as any;
    expect(acceptedMemory).toMatchObject({
      action: 'memory_candidate_created',
      memory_candidate: {
        source_ref: `handoff:${handoff.id}`,
        memory_type: 'operational_memory',
      },
      message: {
        read_at: expect.any(String),
        payload: {
          accepted_action: 'memory_candidate_created',
          accepted_ref: expect.stringMatching(/^memory_candidate:/),
        },
      },
    });

    const plannerResponse = await fetch(`${baseUrl}/swarms/handoffs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from_agent_id: 'agent-maker',
        to_agent_id: 'agent-memory',
        source_lease_id: 'lease-handoff',
        target_role: 'planner',
        summary: 'Plan the next follow-up task from completed worker evidence.',
        evidence_ref: 'agent-evidence/stdout.log',
      }),
    });
    const plannerHandoff = await plannerResponse.json() as any;
    const acceptPlannerResponse = await fetch(`${baseUrl}/swarms/handoffs/${plannerHandoff.id}/accept`, { method: 'POST' });
    expect(acceptPlannerResponse.status).toBe(200);
    const acceptedPlanner = await acceptPlannerResponse.json() as any;
    expect(acceptedPlanner).toMatchObject({
      action: 'work_item_created',
      work_item: {
        source: 'swarm_handoff',
        source_ref: `handoff:${plannerHandoff.id}`,
        assigned_agent_id: 'agent-memory',
        recommended_loop: 'repo-maintenance-loop',
      },
    });

    const finalStatusResponse = await fetch(`${baseUrl}/swarms/status`);
    const finalStatus = await finalStatusResponse.json() as any;
    expect(finalStatus.open_handoffs).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) as count FROM agent_trace_spans WHERE trace_id LIKE ?').get('handoff-%')).toMatchObject({ count: 2 });
  });

  it('drains open handoffs into memory candidates and prepared worker leases', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-handoff-drain-repo-'));
    const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-handoff-drain-worktrees-'));
    const previousWorktreeRoot = process.env.LOOP_WORKTREE_ROOT;
    process.env.LOOP_WORKTREE_ROOT = worktreeRoot;
    try {
      fs.writeFileSync(path.join(repo, 'README.md'), 'TODO: document handoff drain\n');
      fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }, null, 2));
      execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'handoff-drain@example.invalid'], { cwd: repo });
      execFileSync('git', ['config', 'user.name', 'Handoff Drain Test'], { cwd: repo });
      execFileSync('git', ['add', 'README.md', 'package.json'], { cwd: repo });
      execFileSync('git', ['commit', '-m', 'Initial handoff drain repo'], { cwd: repo, stdio: 'ignore' });

      const now = new Date().toISOString();
      for (const [id, name] of [['agent-maker', 'Maker Agent'], ['agent-memory', 'Memory Agent']]) {
        db.prepare(`
          INSERT INTO agents (id, name, description, status, capabilities, metadata, last_active_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, name, 'handoff drain test agent', 'idle', '[]', '{}', now, now, now);
      }
      db.prepare(`
        INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('loop-handoff-drain', 'doc-drift-and-small-fix-loop', 'closed', 'running', '[]', '{}', '[]', '[]', '{"risk_class":"low"}', now, now);
      db.prepare(`
        INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('lease-handoff-drain', 'loop-handoff-drain', 'maker', 'codex', 'completed', '{"stdout_path":"agent-evidence/stdout.log"}', now, now);

      for (const target_role of ['memory_curator', 'planner']) {
        const response = await fetch(`${baseUrl}/swarms/handoffs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            from_agent_id: 'agent-maker',
            to_agent_id: 'agent-memory',
            source_lease_id: 'lease-handoff-drain',
            target_role,
            summary: `Drain ${target_role} handoff from completed worker evidence.`,
            evidence_ref: 'agent-evidence/stdout.log',
          }),
        });
        expect(response.status).toBe(201);
      }

      const drainResponse = await fetch(`${baseUrl}/swarms/handoffs/drain`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          max_handoffs: 5,
          plan: true,
          prepare: true,
          runtime: 'mock',
          repository_path: repo,
        }),
      });
      expect(drainResponse.status).toBe(200);
      const drain = await drainResponse.json() as any;
      expect(drain.accepted).toHaveLength(2);
      expect(drain.failed).toHaveLength(0);
      expect(drain.memory_candidate_ids).toHaveLength(1);
      expect(drain.work_item_ids).toHaveLength(1);
      expect(drain.scheduler_tick).toMatchObject({
        leases_created: 2,
        planned_work_items: [expect.objectContaining({ status: 'planned' })],
        prepared_work_items: [expect.objectContaining({ status: 'leased', assigned_runtime: 'mock' })],
      });
      expect(drain.worker_pool_drain).toBeNull();

      const statusResponse = await fetch(`${baseUrl}/swarms/status`);
      const status = await statusResponse.json() as any;
      expect(status.open_handoffs).toHaveLength(0);
    } finally {
      if (previousWorktreeRoot) {
        process.env.LOOP_WORKTREE_ROOT = previousWorktreeRoot;
      } else {
        delete process.env.LOOP_WORKTREE_ROOT;
      }
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(worktreeRoot, { recursive: true, force: true });
    }
  });

  it('passes headless approval bypass requests from worker pool to real worker execution', async () => {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('loop-worker-pool-skip', 'repo-maintenance-loop', 'closed', 'running', '[]', '{}', '[]', '[]', '{"risk_class":"low"}', now, now);
    db.prepare(`
      INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, worktree_path, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('lease-worker-pool-skip', 'loop-worker-pool-skip', 'maker', 'codex', 'prepared', '/tmp/worker-pool-skip', '{}', now, now);

    const service = new SwarmStatusService(db) as any;
    let workerInput: any = null;
    service.loops.executeWorker = async (_loopRunId: string, input: any) => {
      workerInput = input;
      db.prepare('UPDATE worker_leases SET status = ?, metadata = ?, updated_at = ? WHERE id = ?')
        .run('completed', JSON.stringify({ runtime_usage: { total_tokens: 12 } }), new Date().toISOString(), input.lease_id);
      return {
        run: service.loops.getLoopRun('loop-worker-pool-skip'),
        lease: service.loops.getWorkerLease(input.lease_id),
        gates: [],
        stdout_path: '/tmp/stdout.log',
        stderr_path: '/tmp/stderr.log',
        checkpoint_before: {},
        checkpoint_after: {},
        trace: { trace_id: 'trace-worker-pool-skip', spans: [], edges: [], roots: [] },
      };
    };
    service.loops.runDeterministicChecks = () => null;

    const result = await service.startNextWorker({
      skip_permissions: true,
      timeout_ms: 12_000,
      diff_max_lines: 40,
      ignore_capacity: true,
    });

    expect(result.action).toBe('started');
    expect(workerInput).toMatchObject({
      lease_id: 'lease-worker-pool-skip',
      skip_permissions: true,
      timeout_ms: 12_000,
      diff_max_lines: 40,
    });
  });

  it('scheduler tick projects loop findings into backlog candidates without leasing workers', async () => {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'loop-findings',
      'skill-quality-loop',
      'closed',
      'completed',
      JSON.stringify([
        {
          id: 'finding-1',
          type: 'draft_loop_skill',
          severity: 'info',
          file: 'packages/knowledge/skills/example.md',
          message: 'Loop skill is still draft/proposed and cannot orchestrate live workers.',
          evidence: 'trust_level: proposed',
          suggested_fix: 'Run skill validation and governance review.',
        },
      ]),
      JSON.stringify({ proposed_tasks: [] }),
      '[]',
      '[]',
      JSON.stringify({ scheduler_projected_at: null }),
      now,
      now,
      now
    );

    const response = await fetch(`${baseUrl}/swarms/scheduler/tick`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ max_items: 5 }),
    });
    expect(response.status).toBe(200);
    const tick = await response.json() as any;

    expect(tick.created_work_items).toHaveLength(1);
    expect(tick.created_work_items[0]).toMatchObject({
      source: 'loop_finding',
      source_ref: 'loop-findings:finding-1',
      status: 'candidate',
      recommended_loop: 'skill-quality-loop',
    });
    expect(tick.leases_created).toBe(0);

    const statusResponse = await fetch(`${baseUrl}/swarms/status`);
    const status = await statusResponse.json() as any;
    expect(status.backlog_count.candidate).toBe(1);
    expect(status.worker_lease_count).toBe(0);
  });

  it('classifies memory candidates without promoting secrets or policy changes', async () => {
    const fakeKeyName = ['OPENAI', 'API', 'KEY'].join('_');
    const fakeKeyValue = `${['s', 'k'].join('')}-${'1234567890abcdef'}`;
    const operationalResponse = await fetch(`${baseUrl}/swarms/memory/candidates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Fixture retry note',
        content: 'The loop-service retry test can fail when old worktrees are left behind.',
        memory_type: 'operational_memory',
        source_ref: 'test:retry-fixture',
      }),
    });
    expect(operationalResponse.status).toBe(201);
    const operational = await operationalResponse.json() as any;
    expect(operational).toMatchObject({
      status: 'candidate',
      promotion_status: 'proposed',
      human_required: false,
    });

    const policyResponse = await fetch(`${baseUrl}/swarms/memory/candidates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Allow policy update',
        content: 'Agents may bypass approval for policy changes.',
        memory_type: 'policy_rule',
        source_ref: 'test:policy',
      }),
    });
    expect(policyResponse.status).toBe(201);
    const policy = await policyResponse.json() as any;
    expect(policy).toMatchObject({
      status: 'review_required',
      promotion_status: 'blocked_pending_human',
      human_required: true,
    });

    const secretResponse = await fetch(`${baseUrl}/swarms/memory/candidates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Leaked credential',
        content: `"${fakeKeyName}": "${fakeKeyValue}"`,
        memory_type: 'operational_memory',
        source_ref: 'test:secret',
      }),
    });
    expect(secretResponse.status).toBe(400);
    const secret = await secretResponse.json() as any;
    expect(secret.error.code).toBe('MEMORY_CANDIDATE_SECRET_DETECTED');
  });

  it('promotes approved memory candidates and retrieves them through memory search fallback', async () => {
    const createResponse = await fetch(`${baseUrl}/swarms/memory/candidates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Retry fixture cleanup',
        content: 'Clean stale loop worktrees before retry validation to avoid branch conflicts.',
        memory_type: 'operational_memory',
        source_ref: 'test:retry-cleanup',
      }),
    });
    expect(createResponse.status).toBe(201);
    const candidate = await createResponse.json() as any;

    const promoteResponse = await fetch(`${baseUrl}/swarms/memory/candidates/${candidate.id}/promote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sinks: ['okf'], approved_by: 'test-operator' }),
    });
    expect(promoteResponse.status).toBe(200);
    const promoted = await promoteResponse.json() as any;
    expect(promoted.candidate).toMatchObject({
      id: candidate.id,
      promotion_status: 'promoted',
      status: 'promoted',
    });
    expect(promoted.sinks).toEqual([
      expect.objectContaining({ sink: 'okf', status: 'pass' }),
    ]);

    const searchResponse = await fetch(`${baseUrl}/memory/search?q=stale+loop+worktrees`);
    expect(searchResponse.status).toBe(200);
    const search = await searchResponse.json() as any;
    expect(search.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: 'Retry fixture cleanup',
        trust_level: 'validated',
      }),
    ]));

    const policyResponse = await fetch(`${baseUrl}/swarms/memory/candidates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Policy needs approval',
        content: 'Policy changes require human approval.',
        memory_type: 'policy_rule',
        source_ref: 'test:policy-promotion',
      }),
    });
    const policyCandidate = await policyResponse.json() as any;
    const blockedPromotion = await fetch(`${baseUrl}/swarms/memory/candidates/${policyCandidate.id}/promote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sinks: ['okf'] }),
    });
    expect(blockedPromotion.status).toBe(409);
    const blocked = await blockedPromotion.json() as any;
    expect(blocked.error.code).toBe('MEMORY_PROMOTION_HUMAN_APPROVAL_REQUIRED');
  });

  it('scheduler can convert triaged backlog candidates into goals without worker leases', async () => {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO work_items (id, title, description, source, source_ref, risk_class, value_score, confidence, status, recommended_loop, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'wi-triaged',
      'Validate skill governance',
      'Validate draft loop skills before orchestration.',
      'test',
      'test:triaged',
      'medium',
      80,
      0.8,
      'triaged',
      'skill-quality-loop',
      '{}',
      now,
      now
    );

    const response = await fetch(`${baseUrl}/swarms/scheduler/tick`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ max_items: 5, plan_triaged: true }),
    });
    expect(response.status).toBe(200);
    const tick = await response.json() as any;
    expect(tick.planned_work_items).toHaveLength(1);
    expect(tick.planned_work_items[0]).toMatchObject({
      id: 'wi-triaged',
      status: 'planned',
      parent_goal_id: expect.any(String),
    });
    expect(tick.leases_created).toBe(0);

    const goals = db.prepare('SELECT * FROM goals').all() as any[];
    expect(goals).toHaveLength(1);
    expect(goals[0]).toMatchObject({
      objective: 'Validate skill governance',
      risk_class: 'medium',
      status: 'created',
    });
  });

  it('scheduler can plan selected triaged work items as a batch', async () => {
    const now = new Date().toISOString();
    for (const id of ['wi-selected', 'wi-skipped']) {
      db.prepare(`
        INSERT INTO work_items (id, title, description, source, source_ref, risk_class, value_score, confidence, status, recommended_loop, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        `Selected batch ${id}`,
        'Convert only explicitly selected backlog items.',
        'test',
        `test:${id}`,
        'low',
        60,
        0.8,
        'triaged',
        'doc-drift-and-small-fix-loop',
        '{}',
        now,
        now
      );
    }

    const response = await fetch(`${baseUrl}/swarms/scheduler/tick`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plan_triaged: true, work_item_ids: ['wi-selected'] }),
    });
    expect(response.status).toBe(200);
    const tick = await response.json() as any;

    expect(tick.planned_work_items).toHaveLength(1);
    expect(tick.planned_work_items[0]).toMatchObject({ id: 'wi-selected', status: 'planned' });
    expect(db.prepare('SELECT status FROM work_items WHERE id = ?').get('wi-skipped')).toMatchObject({ status: 'triaged' });
  });

  it('scheduler can prepare planned backlog candidates into worker leases without starting workers', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-scheduler-repo-'));
    const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-scheduler-worktrees-'));
    const previousWorktreeRoot = process.env.LOOP_WORKTREE_ROOT;
    process.env.LOOP_WORKTREE_ROOT = worktreeRoot;
    try {
      fs.writeFileSync(path.join(repo, 'README.md'), 'TODO: document setup\n');
      fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }, null, 2));
      execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'scheduler@example.invalid'], { cwd: repo });
      execFileSync('git', ['config', 'user.name', 'Scheduler Test'], { cwd: repo });
      execFileSync('git', ['add', 'README.md', 'package.json'], { cwd: repo });
      execFileSync('git', ['commit', '-m', 'Initial scheduler repo'], { cwd: repo, stdio: 'ignore' });

      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO work_items (id, title, description, source, source_ref, risk_class, value_score, confidence, status, recommended_loop, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'wi-prepare',
        'Prepare doc fix worker',
        'Prepare a bounded doc-drift worker lease.',
        'test',
        'test:prepare',
        'low',
        75,
        0.8,
        'triaged',
        'doc-drift-and-small-fix-loop',
        JSON.stringify({ repository_path: repo }),
        now,
        now
      );

      const response = await fetch(`${baseUrl}/swarms/scheduler/tick`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ max_items: 5, plan_triaged: true, prepare_planned: true, runtime: 'mock' }),
      });
      expect(response.status).toBe(200);
      const tick = await response.json() as any;
      expect(tick.planned_work_items).toHaveLength(1);
      expect(tick.prepared_work_items).toHaveLength(1);
      expect(tick.prepared_work_items[0]).toMatchObject({
        id: 'wi-prepare',
        status: 'leased',
        assigned_runtime: 'mock',
      });
      expect(tick.prepared_work_items[0].metadata.loop_run_id).toEqual(expect.any(String));
      expect(tick.leases_created).toBe(2);

      const leases = db.prepare('SELECT * FROM worker_leases WHERE loop_run_id = ? ORDER BY role ASC').all(tick.prepared_work_items[0].metadata.loop_run_id) as any[];
      expect(leases).toHaveLength(2);
      const maker = leases.find((lease) => lease.role === 'maker');
      expect(maker).toMatchObject({ runtime: 'mock', status: 'prepared' });
      const makerMetadata = JSON.parse(maker.metadata);
      expect(fs.existsSync(makerMetadata.assignment_file)).toBe(true);
      expect(makerMetadata.assignment_file).toContain(`${path.sep}.djimitflo${path.sep}LOOP_WORK.md`);

      const statusResponse = await fetch(`${baseUrl}/swarms/status`);
      const status = await statusResponse.json() as any;
      const mockPool = status.fleet_pools.find((pool: any) => pool.runtime === 'mock');
      expect(mockPool).toMatchObject({
        prepared_leases: 1,
        queued_leases: 1,
      });
    } finally {
      if (previousWorktreeRoot) {
        process.env.LOOP_WORKTREE_ROOT = previousWorktreeRoot;
      } else {
        delete process.env.LOOP_WORKTREE_ROOT;
      }
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(worktreeRoot, { recursive: true, force: true });
    }
  });

  it('worker pool runner drains allowed low-risk maker and checker leases with trace evidence', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-runner-repo-'));
    const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-runner-worktrees-'));
    const previousWorktreeRoot = process.env.LOOP_WORKTREE_ROOT;
    process.env.LOOP_WORKTREE_ROOT = worktreeRoot;
    try {
      fs.writeFileSync(path.join(repo, 'README.md'), 'TODO: document setup\n');
      fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({
        scripts: {
          test: 'node -e "process.exit(0)"',
          lint: 'node -e "process.exit(0)"',
          'type-check': 'node -e "process.exit(0)"',
        },
      }, null, 2));
      execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'runner@example.invalid'], { cwd: repo });
      execFileSync('git', ['config', 'user.name', 'Runner Test'], { cwd: repo });
      execFileSync('git', ['add', 'README.md', 'package.json'], { cwd: repo });
      execFileSync('git', ['commit', '-m', 'Initial runner repo'], { cwd: repo, stdio: 'ignore' });

      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO work_items (id, title, description, source, source_ref, risk_class, value_score, confidence, status, recommended_loop, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'wi-runner',
        'Run bounded doc worker',
        'Prepare and run a bounded doc worker.',
        'test',
        'test:runner',
        'low',
        82,
        0.85,
        'triaged',
        'doc-drift-and-small-fix-loop',
        JSON.stringify({ repository_path: repo }),
        now,
        now
      );
      const tickResponse = await fetch(`${baseUrl}/swarms/scheduler/tick`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ max_items: 5, plan_triaged: true, prepare_planned: true, runtime: 'mock' }),
      });
      const tick = await tickResponse.json() as any;
      const loopRunId = tick.prepared_work_items[0].metadata.loop_run_id;

      const planResponse = await fetch(`${baseUrl}/swarms/worker-pool/plan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runtime: 'mock', checker_runtime: 'mock', ignore_capacity: true }),
      });
      expect(planResponse.status).toBe(200);
      const plan = await planResponse.json() as any;
      expect(plan.eligible_count).toBeGreaterThanOrEqual(1);
      expect(plan.decisions).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'maker', eligible: true, next_action: 'execute_maker' }),
      ]));

      const drainResponse = await fetch(`${baseUrl}/swarms/worker-pool/drain`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runtime: 'mock', checker_runtime: 'mock', ignore_capacity: true, max_workers: 2, timeout_ms: 10_000, diff_max_lines: 20 }),
      });
      expect(drainResponse.status).toBe(200);
      const drain = await drainResponse.json() as any;
      expect(drain.started).toHaveLength(2);
      expect(drain.started.map((item: any) => item.decision.next_action)).toEqual(['execute_maker', 'execute_checker']);

      const leases = db.prepare('SELECT role, runtime, status, metadata FROM worker_leases WHERE loop_run_id = ? ORDER BY role ASC').all(loopRunId) as any[];
      expect(leases).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'maker', runtime: 'mock', status: 'completed' }),
        expect.objectContaining({ role: 'checker', runtime: 'mock', status: 'completed' }),
      ]));
      const spans = db.prepare('SELECT * FROM agent_trace_spans WHERE loop_run_id = ? AND name LIKE ?').all(loopRunId, 'worker-pool:%') as any[];
      expect(spans.length).toBeGreaterThanOrEqual(4);
      const events = db.prepare('SELECT event_type FROM loop_events WHERE loop_run_id = ?').all(loopRunId) as any[];
      expect(events.map((event) => event.event_type)).toEqual(expect.arrayContaining(['worker_pool_worker_started']));
      const workItem = db.prepare('SELECT status, metadata FROM work_items WHERE id = ?').get('wi-runner') as any;
      expect(workItem.status).toBe('done');
      expect(JSON.parse(workItem.metadata).fleet_outcome).toMatchObject({
        loop_run_id: loopRunId,
        status: 'done',
        reason: 'ready_for_human_merge',
      });
    } finally {
      if (previousWorktreeRoot) {
        process.env.LOOP_WORKTREE_ROOT = previousWorktreeRoot;
      } else {
        delete process.env.LOOP_WORKTREE_ROOT;
      }
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(worktreeRoot, { recursive: true, force: true });
    }
  });

  it('fleet smoke drives selected backlog items to auditable closure', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-fleet-smoke-repo-'));
    const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-fleet-smoke-worktrees-'));
    const previousWorktreeRoot = process.env.LOOP_WORKTREE_ROOT;
    process.env.LOOP_WORKTREE_ROOT = worktreeRoot;
    try {
      fs.writeFileSync(path.join(repo, 'README.md'), 'TODO: document setup\n');
      fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({
        scripts: {
          test: 'node -e "process.exit(0)"',
          lint: 'node -e "process.exit(0)"',
          'type-check': 'node -e "process.exit(0)"',
        },
      }, null, 2));
      execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'fleet@example.invalid'], { cwd: repo });
      execFileSync('git', ['config', 'user.name', 'Fleet Smoke Test'], { cwd: repo });
      execFileSync('git', ['add', 'README.md', 'package.json'], { cwd: repo });
      execFileSync('git', ['commit', '-m', 'Initial fleet smoke repo'], { cwd: repo, stdio: 'ignore' });

      const now = new Date().toISOString();
      const ids = ['wi-fleet-1', 'wi-fleet-2', 'wi-fleet-3'];
      for (const id of ids) {
        db.prepare(`
          INSERT INTO work_items (id, title, description, source, source_ref, risk_class, value_score, confidence, status, recommended_loop, metadata, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id,
          `Fleet closure ${id}`,
          'Prepare, execute, check, and close one bounded fleet item.',
          'test',
          `test:${id}`,
          'low',
          80,
          0.9,
          'triaged',
          'doc-drift-and-small-fix-loop',
          JSON.stringify({ repository_path: repo }),
          now,
          now
        );
      }

      const tickResponse = await fetch(`${baseUrl}/swarms/scheduler/tick`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          max_items: 3,
          plan_triaged: true,
          prepare_planned: true,
          runtime: 'mock',
          work_item_ids: ids,
        }),
      });
      expect(tickResponse.status).toBe(200);
      const tick = await tickResponse.json() as any;
      expect(tick.planned_work_items).toHaveLength(3);
      expect(tick.prepared_work_items).toHaveLength(3);
      expect(tick.leases_created).toBe(6);

      const drainResponse = await fetch(`${baseUrl}/swarms/worker-pool/drain`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runtime: 'mock', checker_runtime: 'mock', ignore_capacity: true, max_workers: 6, timeout_ms: 10_000, diff_max_lines: 20 }),
      });
      expect(drainResponse.status).toBe(200);
      const drain = await drainResponse.json() as any;
      expect(drain.started).toHaveLength(6);
      expect(drain.started.filter((item: any) => item.decision.next_action === 'execute_maker')).toHaveLength(3);
      expect(drain.started.filter((item: any) => item.decision.next_action === 'execute_checker')).toHaveLength(3);

      const syncResponse = await fetch(`${baseUrl}/swarms/backlog/sync`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(syncResponse.status).toBe(200);
      const sync = await syncResponse.json() as any;
      expect(sync.updated_work_items).toHaveLength(0);

      const rows = db.prepare('SELECT id, status, metadata FROM work_items WHERE id IN (?, ?, ?) ORDER BY id ASC').all(...ids) as any[];
      expect(rows.map((row) => row.status)).toEqual(['done', 'done', 'done']);
      for (const row of rows) {
        const metadata = JSON.parse(row.metadata);
        expect(metadata.loop_run_id).toEqual(expect.any(String));
        expect(metadata.fleet_outcome).toMatchObject({
          status: 'done',
          reason: 'ready_for_human_merge',
        });
        expect(metadata.fleet_outcome.evidence.leases).toEqual(expect.arrayContaining([
          expect.objectContaining({ role: 'maker', status: 'completed', stdout_path: expect.any(String) }),
          expect.objectContaining({ role: 'checker', status: 'completed', verdict: 'accepted', stdout_path: expect.any(String) }),
        ]));
      }

      const statusResponse = await fetch(`${baseUrl}/swarms/status`);
      const status = await statusResponse.json() as any;
      expect(status.fleet_topology.filter((item: any) => ids.some((id) => item.goal_objective?.includes(id))).length).toBeGreaterThanOrEqual(6);
    } finally {
      if (previousWorktreeRoot) {
        process.env.LOOP_WORKTREE_ROOT = previousWorktreeRoot;
      } else {
        delete process.env.LOOP_WORKTREE_ROOT;
      }
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(worktreeRoot, { recursive: true, force: true });
    }
  });

  it('runs the CS Skill Intelligence live swarm harness with interacting agents and evidence', async () => {
    const response = await fetch(`${baseUrl}/swarms/cs-skill-intelligence/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runtime: 'local' }),
    });

    expect(response.status).toBe(201);
    const result = await response.json() as any;
    expect(result).toMatchObject({
      status: 'completed',
      runtime: 'local',
      swarms_started: 5,
      swarms_completed: 5,
      agents_started: 14,
      agents_completed: 14,
    });
    expect(result.interaction_edges.length).toBeGreaterThanOrEqual(13);
    expect(result.checkpoints.map((checkpoint: any) => checkpoint.label)).toEqual([
      'cs-skill-swarm:prepared',
      'cs-skill-swarm:completed',
    ]);

    const leases = db.prepare('SELECT role, runtime, status, metadata FROM worker_leases WHERE loop_run_id = ?').all(result.loop_run_id) as any[];
    expect(leases).toHaveLength(14);
    expect(leases.every((lease) => lease.runtime === 'local' && lease.status === 'completed')).toBe(true);
    const leaseMetadata = leases.map((lease) => JSON.parse(lease.metadata || '{}'));
    expect(new Set(leaseMetadata.map((metadata) => metadata.swarm_id)).size).toBe(5);
    expect(new Set(leaseMetadata.map((metadata) => metadata.agent_id)).size).toBe(14);
    expect(leaseMetadata.every((metadata) => metadata.child_process_started === true)).toBe(true);
    expect(leaseMetadata.every((metadata) => Number.isInteger(metadata.child_pid) && metadata.child_pid > 0)).toBe(true);
    expect(leaseMetadata).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent_id: 'source_ingestor', swarm_id: 'ingest' }),
      expect.objectContaining({ agent_id: 'qdrant_projector', swarm_id: 'projection' }),
      expect.objectContaining({ agent_id: 'promotion_gate_reviewer', swarm_id: 'assurance' }),
    ]));

    const spans = db.prepare('SELECT name, status, metadata FROM agent_trace_spans WHERE trace_id = ? ORDER BY created_at ASC').all(result.trace_id) as any[];
    expect(spans.length).toBeGreaterThanOrEqual(34);
    expect(spans.map((span) => span.name)).toEqual(expect.arrayContaining([
      'cs-skill-swarm:harness:start',
      'cs-skill-swarm:ingest:start',
      'cs-skill-swarm:agent:source_ingestor:start',
      'cs-skill-swarm:agent:source_ingestor:complete',
      'cs-skill-swarm:interaction:source_ingestor:to:source_auditor',
      'cs-skill-swarm:harness:complete',
    ]));

    const checkpoints = db.prepare('SELECT label FROM loop_checkpoints WHERE loop_run_id = ? ORDER BY created_at ASC').all(result.loop_run_id) as any[];
    expect(checkpoints.map((checkpoint) => checkpoint.label)).toEqual([
      'cs-skill-swarm:prepared',
      'cs-skill-swarm:completed',
    ]);

    const run = db.prepare('SELECT status, metadata FROM loop_runs WHERE id = ?').get(result.loop_run_id) as any;
    expect(run.status).toBe('completed');
    expect(JSON.parse(run.metadata || '{}')).toMatchObject({
      live_harness: true,
      swarms_started: 5,
      agents_started: 14,
      live_process_agents: 14,
      promotion_requires_human_gate: true,
    });
  });

  it('worker pool runner blocks high-risk leases without explicit high-risk allowance', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-runner-high-risk-repo-'));
    const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-runner-high-risk-worktrees-'));
    const previousWorktreeRoot = process.env.LOOP_WORKTREE_ROOT;
    process.env.LOOP_WORKTREE_ROOT = worktreeRoot;
    try {
      fs.writeFileSync(path.join(repo, 'README.md'), 'TODO: document auth token policy\n');
      fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }, null, 2));
      execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'runner@example.invalid'], { cwd: repo });
      execFileSync('git', ['config', 'user.name', 'Runner Test'], { cwd: repo });
      execFileSync('git', ['add', 'README.md', 'package.json'], { cwd: repo });
      execFileSync('git', ['commit', '-m', 'Initial high risk repo'], { cwd: repo, stdio: 'ignore' });

      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO work_items (id, title, description, source, source_ref, risk_class, value_score, confidence, status, recommended_loop, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'wi-runner-high',
        'Run high risk auth worker',
        'Prepare a high-risk auth worker.',
        'test',
        'test:runner-high',
        'high',
        90,
        0.8,
        'triaged',
        'doc-drift-and-small-fix-loop',
        JSON.stringify({ repository_path: repo }),
        now,
        now
      );
      await fetch(`${baseUrl}/swarms/scheduler/tick`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ max_items: 5, plan_triaged: true, prepare_planned: true, runtime: 'mock' }),
      });

      const planResponse = await fetch(`${baseUrl}/swarms/worker-pool/plan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runtime: 'mock', checker_runtime: 'mock', ignore_capacity: true }),
      });
      const plan = await planResponse.json() as any;
      expect(plan.eligible_count).toBe(0);
      expect(plan.decisions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: 'maker',
          eligible: false,
          blocked_reasons: expect.arrayContaining(['high_risk_requires_security_or_human_gate']),
        }),
      ]));

      const startResponse = await fetch(`${baseUrl}/swarms/worker-pool/start-next`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runtime: 'mock', checker_runtime: 'mock', ignore_capacity: true }),
      });
      expect(startResponse.status).toBe(200);
      const start = await startResponse.json() as any;
      expect(start.action).toBe('blocked');
    } finally {
      if (previousWorktreeRoot) {
        process.env.LOOP_WORKTREE_ROOT = previousWorktreeRoot;
      } else {
        delete process.env.LOOP_WORKTREE_ROOT;
      }
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(worktreeRoot, { recursive: true, force: true });
    }
  });

  it('worker pool runner stops a prepared lease without deleting evidence', async () => {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO loop_runs (id, loop_name, mode, status, repository_path, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'loop-stop-worker',
      'doc-drift-and-small-fix-loop',
      'closed',
      'running',
      '/repo',
      '[]',
      '{}',
      '[]',
      '[]',
      JSON.stringify({ risk_class: 'low' }),
      now,
      now
    );
    db.prepare(`
      INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('lease-stop-worker', 'loop-stop-worker', 'maker', 'mock', 'prepared', '{"stdout_path":"agent-evidence/stdout.log"}', now, now);

    const stopResponse = await fetch(`${baseUrl}/swarms/worker-pool/stop/lease-stop-worker`, { method: 'POST' });
    expect(stopResponse.status).toBe(200);
    const stopped = await stopResponse.json() as any;
    expect(stopped.lease).toMatchObject({
      id: 'lease-stop-worker',
      status: 'cancelled',
      metadata: {
        stdout_path: 'agent-evidence/stdout.log',
        stopped_by_runner: true,
        stop_mode: 'cancel_prepared',
      },
    });
  });

  it('exposes specialist catalog and rejects unknown or unsafe high-risk panels', async () => {
    const catalogResponse = await fetch(`${baseUrl}/swarms/specialists/catalog`);
    expect(catalogResponse.status).toBe(200);
    const catalog = await catalogResponse.json() as any;
    expect(catalog.specialists).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'systems_architect' }),
      expect.objectContaining({ id: 'security_reviewer' }),
      expect.objectContaining({ id: 'philosopher_ethicist' }),
    ]));

    const unknownResponse = await fetch(`${baseUrl}/swarms/specialist-panels`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        topic: 'Unknown expert',
        question: 'Should this fail?',
        specialist_ids: ['systems_architect', 'not_real'],
      }),
    });
    expect(unknownResponse.status).toBe(400);
    const unknown = await unknownResponse.json() as any;
    expect(unknown.error.code).toBe('SPECIALIST_PROFILE_UNKNOWN');

    const unsafeHighRiskResponse = await fetch(`${baseUrl}/swarms/specialist-panels`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        topic: 'Auth policy change',
        question: 'Can agents update auth policy without a security reviewer?',
        risk_class: 'high',
        specialist_ids: ['systems_architect', 'runtime_engineer'],
      }),
    });
    expect(unsafeHighRiskResponse.status).toBe(400);
    const unsafeHighRisk = await unsafeHighRiskResponse.json() as any;
    expect(unsafeHighRisk.error.code).toBe('SPECIALIST_PANEL_SECURITY_REVIEWER_REQUIRED');
  });

  it('collects independent specialist reviews and preserves consensus dissent', async () => {
    const createResponse = await fetch(`${baseUrl}/swarms/specialist-panels`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        topic: 'Memory harness autonomy',
        question: 'Should memory candidates promote automatically into policy memory?',
        risk_class: 'medium',
        specialist_ids: ['systems_architect', 'security_reviewer', 'memory_scientist'],
      }),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as any;
    expect(created).toMatchObject({
      status: 'planned',
      risk_class: 'medium',
    });
    expect(created.panel).toHaveLength(3);
    expect(created.metadata).toMatchObject({ leases_created: 0 });

    for (const review of [
      {
        specialist_id: 'systems_architect',
        stance: 'support',
        confidence: 0.82,
        findings: ['Candidate-only memory keeps state auditable.'],
        recommendations: ['Keep promotion explicit and idempotent.'],
        evidence_refs: ['memory_candidates table'],
      },
      {
        specialist_id: 'security_reviewer',
        stance: 'needs_evidence',
        confidence: 0.74,
        findings: ['Policy memory must not promote without human approval.'],
        recommendations: ['Require human approval for policy_rule promotion.'],
        evidence_refs: ['promotion_status blocked_pending_human'],
        limitations: 'No external UAMS sink was exercised.',
      },
      {
        specialist_id: 'memory_scientist',
        stance: 'support',
        confidence: 0.78,
        findings: ['Operational memory can be proposed safely.'],
        recommendations: ['Retrieve promoted OKF memory through search fallback.'],
        evidence_refs: ['/memory/search fallback'],
      },
    ]) {
      const reviewResponse = await fetch(`${baseUrl}/swarms/specialist-panels/${created.id}/reviews`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(review),
      });
      expect(reviewResponse.status).toBe(200);
    }

    const panelResponse = await fetch(`${baseUrl}/swarms/specialist-panels/${created.id}`);
    expect(panelResponse.status).toBe(200);
    const panel = await panelResponse.json() as any;
    expect(panel.status).toBe('consensus_ready');
    expect(panel.reviews).toHaveLength(3);
    expect(panel.consensus).toMatchObject({
      required_reviews: 3,
      submitted_reviews: 3,
      support_count: 2,
      needs_evidence_count: 1,
      consensus_level: 'weak',
      decision: 'needs_more_evidence',
    });
    expect(panel.consensus.dissent).toEqual([
      expect.objectContaining({
        specialist_id: 'security_reviewer',
        stance: 'needs_evidence',
      }),
    ]);
  });

  it('projects specialist consensus to backlog without creating worker leases', async () => {
    const createResponse = await fetch(`${baseUrl}/swarms/specialist-panels`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        topic: 'Skill validation harness',
        question: 'Can validated skills orchestrate low-risk doc and lint loops?',
        risk_class: 'low',
        specialist_ids: ['systems_architect', 'skill_evaluator', 'runtime_engineer'],
      }),
    });
    const panel = await createResponse.json() as any;
    expect(createResponse.status).toBe(201);

    for (const specialist_id of ['systems_architect', 'skill_evaluator', 'runtime_engineer']) {
      const reviewResponse = await fetch(`${baseUrl}/swarms/specialist-panels/${panel.id}/reviews`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          specialist_id,
          stance: 'support',
          confidence: 0.9,
          findings: [`${specialist_id} accepts the bounded skill validation plan.`],
          recommendations: ['Run skill validation before live orchestration.'],
          evidence_refs: ['openspec agentic-control-loop-fleet'],
        }),
      });
      expect(reviewResponse.status).toBe(200);
    }

    const backlogResponse = await fetch(`${baseUrl}/swarms/specialist-panels/${panel.id}/backlog`, {
      method: 'POST',
    });
    expect(backlogResponse.status).toBe(201);
    const backlog = await backlogResponse.json() as any;
    expect(backlog).toMatchObject({
      created: true,
      work_item: {
        source: 'specialist_panel',
        source_ref: panel.id,
        risk_class: 'low',
        status: 'triaged',
        recommended_loop: 'skill-quality-loop',
      },
      panel: {
        status: 'backlog_created',
      },
    });
    expect(backlog.work_item.metadata).toMatchObject({
      panel_id: panel.id,
      decision: 'goal',
      consensus_level: 'strong',
    });

    const duplicateBacklogResponse = await fetch(`${baseUrl}/swarms/specialist-panels/${panel.id}/backlog`, {
      method: 'POST',
    });
    expect(duplicateBacklogResponse.status).toBe(201);
    const duplicateBacklog = await duplicateBacklogResponse.json() as any;
    expect(duplicateBacklog.created).toBe(false);
    expect(duplicateBacklog.work_item.id).toBe(backlog.work_item.id);

    const statusResponse = await fetch(`${baseUrl}/swarms/status`);
    const status = await statusResponse.json() as any;
    expect(status.worker_lease_count).toBe(0);
  });

  it('records trace spans as a causal DAG and rejects secret-like trace evidence', async () => {
    const fakeKeyName = ['OPENAI', 'API', 'KEY'].join('_');
    const fakeKeyValue = `${['s', 'k'].join('')}-${'1234567890abcdef'}`;
    const traceId = 'trace-assurance-1';
    const rootResponse = await fetch(`${baseUrl}/swarms/assurance/trace-spans`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        trace_id: traceId,
        span_type: 'loop',
        name: 'doc-drift loop',
        status: 'ok',
        evidence_ref: 'agent-evidence/loop/LOOP_STATE.md',
        metadata: { loop_name: 'doc-drift-and-small-fix-loop' },
      }),
    });
    expect(rootResponse.status).toBe(201);
    const root = await rootResponse.json() as any;

    const childResponse = await fetch(`${baseUrl}/swarms/assurance/trace-spans`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        trace_id: traceId,
        parent_span_id: root.id,
        span_type: 'memory',
        name: 'promoted memory fallback search',
        status: 'ok',
        evidence_ref: '/memory/search?q=loop',
      }),
    });
    expect(childResponse.status).toBe(201);

    const traceResponse = await fetch(`${baseUrl}/swarms/assurance/traces/${traceId}`);
    expect(traceResponse.status).toBe(200);
    const trace = await traceResponse.json() as any;
    expect(trace.spans).toHaveLength(2);
    expect(trace.edges).toEqual([
      expect.objectContaining({ from: root.id, to: expect.any(String) }),
    ]);
    expect(trace.roots).toEqual([expect.objectContaining({ id: root.id })]);

    const secretResponse = await fetch(`${baseUrl}/swarms/assurance/trace-spans`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        trace_id: 'trace-secret',
        span_type: 'tool',
        name: 'bad trace',
        status: 'error',
        evidence_ref: `"${fakeKeyName}": "${fakeKeyValue}"`,
      }),
    });
    expect(secretResponse.status).toBe(400);
    const secret = await secretResponse.json() as any;
    expect(secret.error.code).toBe('ASSURANCE_SECRET_DETECTED');
  });

  it('checkpoints loop state and branches a replay run without copying worker leases', async () => {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO loop_runs (id, loop_name, mode, status, repository_path, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'loop-checkpointed',
      'repo-maintenance-loop',
      'closed',
      'verifying',
      '/repo',
      JSON.stringify([{ id: 'finding-a', message: 'needs proof' }]),
      JSON.stringify({ steps: ['inspect', 'verify'] }),
      JSON.stringify([{ name: 'tests', status: 'pass', evidence: 'vitest' }]),
      JSON.stringify(['branch checkpoint for replay']),
      JSON.stringify({ trace_id: 'trace-loop-checkpointed' }),
      now,
      now
    );
    db.prepare(`
      INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('lease-old', 'loop-checkpointed', 'maker', 'codex', 'completed', '{}', now, now);

    const checkpointResponse = await fetch(`${baseUrl}/swarms/assurance/checkpoints`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ loop_run_id: 'loop-checkpointed', label: 'before replay' }),
    });
    expect(checkpointResponse.status).toBe(201);
    const checkpoint = await checkpointResponse.json() as any;
    expect(checkpoint).toMatchObject({
      loop_run_id: 'loop-checkpointed',
      label: 'before replay',
    });
    expect(checkpoint.state.status).toBe('verifying');
    expect(checkpoint.leases).toHaveLength(1);

    const branchResponse = await fetch(`${baseUrl}/swarms/assurance/checkpoints/${checkpoint.id}/branch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'replay with safer verifier' }),
    });
    expect(branchResponse.status).toBe(201);
    const branched = await branchResponse.json() as any;
    expect(branched.run).toMatchObject({
      loop_name: 'repo-maintenance-loop',
      status: 'created',
    });
    expect(branched.run.metadata).toMatchObject({
      branched_from_checkpoint_id: checkpoint.id,
      copied_worker_leases: 0,
    });
    const branchLeaseCount = (db.prepare('SELECT COUNT(*) as count FROM worker_leases WHERE loop_run_id = ?').get(branched.run.id) as any).count;
    expect(branchLeaseCount).toBe(0);
  });

  it('runs assurance evals and stores deterministic scorecards without external writes', async () => {
    const createResponse = await fetch(`${baseUrl}/swarms/memory/candidates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Validated retrieval lesson',
        content: 'Promoted memory must be searchable before it is trusted.',
        memory_type: 'operational_memory',
        source_ref: 'test:assurance-eval',
      }),
    });
    const candidate = await createResponse.json() as any;
    await fetch(`${baseUrl}/swarms/memory/candidates/${candidate.id}/promote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approved_by: 'eval-test' }),
    });

    const evalResponse = await fetch(`${baseUrl}/swarms/assurance/evals/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        suite_name: 'memory-quality',
        target_type: 'memory',
        target_ref: 'promoted-memory',
      }),
    });
    expect(evalResponse.status).toBe(201);
    const evalRun = await evalResponse.json() as any;
    expect(evalRun).toMatchObject({
      suite_name: 'memory-quality',
      target_type: 'memory',
      status: 'passed',
    });
    expect(evalRun.score).toBeGreaterThanOrEqual(0.75);
    expect(evalRun.scorecard).toMatchObject({
      promoted_memory_count: 1,
      external_writes: 0,
    });
  });

  it('runs an evolution cycle that measures, reflects, and creates follow-up work only when score is low', async () => {
    const firstResponse = await fetch(`${baseUrl}/swarms/evolution/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ suite_name: 'memory-quality', target_type: 'memory', min_score: 0.75 }),
    });
    expect(firstResponse.status).toBe(201);
    const first = await firstResponse.json() as any;
    expect(first).toMatchObject({
      previous_score: null,
      score_delta: null,
      improved: null,
      eval_run: {
        suite_name: 'memory-quality',
        target_type: 'memory',
        status: 'failed',
      },
      reflection: {
        source_type: 'eval',
        status: 'candidate',
      },
      follow_up_work_item: {
        source: 'evolution_cycle',
        recommended_loop: 'okf-synchronization-loop',
      },
    });

    const createResponse = await fetch(`${baseUrl}/swarms/memory/candidates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Validated evolution lesson',
        content: 'Promoted memory gives the next evaluation run a stronger local signal.',
        memory_type: 'operational_memory',
        source_ref: 'test:evolution-memory',
      }),
    });
    const candidate = await createResponse.json() as any;
    await fetch(`${baseUrl}/swarms/memory/candidates/${candidate.id}/promote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approved_by: 'evolution-test' }),
    });

    const secondResponse = await fetch(`${baseUrl}/swarms/evolution/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ suite_name: 'memory-quality', target_type: 'memory', min_score: 0.75 }),
    });
    expect(secondResponse.status).toBe(201);
    const second = await secondResponse.json() as any;
    expect(second.eval_run.status).toBe('passed');
    expect(second.previous_score).toBe(first.eval_run.score);
    expect(second.score_delta).toBeGreaterThan(0);
    expect(second.improved).toBe(true);
    expect(second.follow_up_work_item).toBeNull();
    expect(second.reflection.lesson).toContain('improved');
  });

  it('issues least-privilege capability tokens and blocks high-risk scopes without approval', async () => {
    const wildcardResponse = await fetch(`${baseUrl}/swarms/assurance/capability-tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subject_agent_id: 'agent-live',
        scopes: ['*'],
      }),
    });
    expect(wildcardResponse.status).toBe(400);
    const wildcard = await wildcardResponse.json() as any;
    expect(wildcard.error.code).toBe('ASSURANCE_SCOPE_INVALID');

    const highRiskResponse = await fetch(`${baseUrl}/swarms/assurance/capability-tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subject_agent_id: 'agent-live',
        scopes: ['tool:shell', 'repo:write'],
        risk_class: 'high',
      }),
    });
    expect(highRiskResponse.status).toBe(409);
    const highRisk = await highRiskResponse.json() as any;
    expect(highRisk.error.code).toBe('ASSURANCE_CAPABILITY_APPROVAL_REQUIRED');

    const approvedResponse = await fetch(`${baseUrl}/swarms/assurance/capability-tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subject_agent_id: 'agent-live',
        scopes: ['loop:read', 'memory:search'],
        allowed_actions: ['read_repo', 'query_memory'],
        denied_actions: ['deploy', 'modify_secrets'],
        risk_class: 'low',
      }),
    });
    expect(approvedResponse.status).toBe(201);
    const approved = await approvedResponse.json() as any;
    expect(approved).toMatchObject({
      subject_agent_id: 'agent-live',
      status: 'active',
      risk_class: 'low',
    });
    expect(approved.token_ref).toMatch(/^cap_/);
    expect(JSON.stringify(approved)).not.toMatch(/secret|sk-/i);
  });

  it('stores reflection candidates as governed lessons and rejects secret-like lessons', async () => {
    const reflectionResponse = await fetch(`${baseUrl}/swarms/assurance/reflections`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source_type: 'eval',
        source_ref: 'memory-quality',
        lesson: 'Policy memory promotion requires human approval before durable writes.',
        evidence_refs: ['memory-quality eval'],
      }),
    });
    expect(reflectionResponse.status).toBe(201);
    const reflection = await reflectionResponse.json() as any;
    expect(reflection).toMatchObject({
      status: 'review_required',
      sensitivity: 'security_sensitive',
      human_required: true,
    });

    const secretResponse = await fetch(`${baseUrl}/swarms/assurance/reflections`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source_type: 'trace',
        source_ref: 'trace-secret',
        lesson: `Store ${'token'}: ${'abcdef1234567890'} for future use.`,
      }),
    });
    expect(secretResponse.status).toBe(400);
    const secret = await secretResponse.json() as any;
    expect(secret.error.code).toBe('ASSURANCE_SECRET_DETECTED');
  });
});
