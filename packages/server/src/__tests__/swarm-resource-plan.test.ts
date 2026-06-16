import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { createWorkItemRoutes } from '../routes/work-items';
import { createSwarmRoutes } from '../routes/swarms';
import { createMemoryRoutes } from '../routes/memory';
import { errorHandler } from '../middleware/error-handler';

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
    `).run('loop-1', 'doc-drift-and-small-fix-loop', 'closed', 'running', '[]', '{}', '[]', '[]', '{}', recent, recent);
    db.prepare(`
      INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('lease-1', 'loop-1', 'maker', 'codex', 'running', '{"pid":123,"artifact_path":"agent-evidence/loop-1/worker-output"}', recent, recent);
    db.prepare(`
      INSERT INTO work_items (id, title, description, source, risk_class, value_score, confidence, status, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('wi-1', 'Follow up', 'candidate', 'test', 'low', 50, 0.6, 'candidate', '{}', recent, recent);

    const response = await fetch(`${baseUrl}/swarms/status`);
    expect(response.status).toBe(200);
    const status = await response.json() as any;

    expect(status.registry_agent_count).toBe(2);
    expect(status.live_agent_count).toBe(1);
    expect(status.worker_lease_count).toBe(1);
    expect(status.active_execution_count).toBe(1);
    expect(status.task_count.open_work_items).toBe(1);
    expect(status.task_count.open_loop_runs).toBe(1);
    expect(status.stale_agents).toEqual([expect.objectContaining({ id: 'agent-stale' })]);
    expect(status.reality_check.agent_count_is_registry_only).toBe(true);
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
        content: `${fakeKeyName}=${fakeKeyValue}`,
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
        evidence_ref: `${fakeKeyName}=${fakeKeyValue}`,
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
        lesson: `Store ${'token'}=${'abcdef1234567890'} for future use.`,
      }),
    });
    expect(secretResponse.status).toBe(400);
    const secret = await secretResponse.json() as any;
    expect(secret.error.code).toBe('ASSURANCE_SECRET_DETECTED');
  });
});
