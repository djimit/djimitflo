import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { createSwarmRoutes } from '../routes/swarms';
import { errorHandler } from '../middleware/error-handler';

let db: Database.Database;
let server: Server;
let baseUrl: string;
let tempOkfBase: string;
let previousOkfBase: string | undefined;

const auth = {
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
} as any;

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/swarms', createSwarmRoutes(db, auth));
  app.use(errorHandler);

  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
}

function insertPreparedLease(input: {
  loopId?: string;
  leaseId?: string;
  runtime?: string;
  role?: string;
  risk?: string;
  metadata?: Record<string, unknown>;
} = {}) {
  const now = new Date().toISOString();
  const loopId = input.loopId || `loop-${Math.random().toString(36).slice(2)}`;
  const leaseId = input.leaseId || `lease-${Math.random().toString(36).slice(2)}`;
  db.prepare(`
    INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    loopId,
    'doc-drift-and-small-fix-loop',
    'closed',
    'running',
    '[]',
    '{}',
    '[]',
    '[]',
    JSON.stringify({ risk_class: input.risk || 'low' }),
    now,
    now
  );
  db.prepare(`
    INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    leaseId,
    loopId,
    input.role || 'maker',
    input.runtime || 'mock',
    'prepared',
    JSON.stringify(input.metadata || {}),
    now,
    now
  );
  return { loopId, leaseId };
}

describe('swarm intelligence layer', () => {
  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    previousOkfBase = process.env.OKF_BASE;
    tempOkfBase = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-okf-g14-'));
    fs.mkdirSync(path.join(tempOkfBase, 'skills'), { recursive: true });
    process.env.OKF_BASE = tempOkfBase;
    await startApp();
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
    db.close();
    fs.rmSync(tempOkfBase, { recursive: true, force: true });
    if (previousOkfBase) {
      process.env.OKF_BASE = previousOkfBase;
    } else {
      delete process.env.OKF_BASE;
    }
  });

  it('registers capability contracts and blocks advisory or low-score live routing', async () => {
    const invalidResponse = await fetch(`${baseUrl}/swarms/intelligence/capabilities`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'draft-skill',
        kind: 'skill',
        owner: 'okf',
        version: '1.0.0',
        status: 'draft',
        risk_ceiling: 'low',
        input_schema_ref: 'schema://skill/input',
        output_schema_ref: 'schema://skill/output',
        forbidden_actions: ['deploy'],
        required_evidence: ['validation report'],
        removal_strategy: 'disable capability',
      }),
    });
    expect(invalidResponse.status).toBe(400);
    expect((await invalidResponse.json() as any).error.code).toBe('SWARM_CAPABILITY_ALLOWED_ACTIONS_REQUIRED');

    const draftResponse = await fetch(`${baseUrl}/swarms/intelligence/capabilities`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'skill-quality-loop',
        kind: 'skill',
        owner: 'okf',
        version: '1.0.0',
        status: 'draft',
        risk_ceiling: 'medium',
        input_schema_ref: 'schema://skill/input',
        output_schema_ref: 'schema://skill/output',
        allowed_actions: ['read_repo'],
        forbidden_actions: ['deploy', 'modify_secrets'],
        required_evidence: ['validation report'],
        eval_score: 0.9,
        eval_threshold: 0.75,
        removal_strategy: 'disable capability and keep advisory only',
        metadata: { okf_path: 'skills/skill-quality-loop' },
      }),
    });
    expect(draftResponse.status).toBe(201);
    const draft = await draftResponse.json() as any;
    expect(draft.live_route_allowed).toBe(false);
    expect(draft.blocked_reasons).toContain('status_draft_is_advisory_only');

    const validatedResponse = await fetch(`${baseUrl}/swarms/intelligence/capabilities`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...draft,
        status: 'validated',
        eval_score: 0.4,
      }),
    });
    expect(validatedResponse.status).toBe(201);
    const validated = await validatedResponse.json() as any;
    expect(validated.live_route_allowed).toBe(false);
    expect(validated.blocked_reasons).toContain('eval_score_below_threshold');

    const evalResponse = await fetch(`${baseUrl}/swarms/intelligence/capabilities/skill-quality-loop/evaluate`, { method: 'POST' });
    expect(evalResponse.status).toBe(200);
    const evaluation = await evalResponse.json() as any;
    expect(evaluation.scorecard.external_writes).toBe(0);
    expect(evaluation.scorecard.checks.has_allowed_actions).toBe(true);
  });

  it('exposes versioned specialist profiles for science and governance councils', async () => {
    const response = await fetch(`${baseUrl}/swarms/intelligence/specialists`);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    const ids = body.specialists.map((specialist: any) => specialist.id);
    expect(ids).toEqual(expect.arrayContaining([
      'mathematician',
      'physicist',
      'biologist',
      'psychologist',
      'behavioral_scientist',
      'philosopher',
      'security_reviewer',
      'systems_architect',
      'product_strategist',
      'data_scientist',
    ]));
    expect(body.specialists.find((specialist: any) => specialist.id === 'physicist')).toMatchObject({
      version: '1.0.0',
      required_evidence: expect.arrayContaining(['measurement']),
    });
  });

  it('keeps unsupported claims proposed and links contradictions with evidence edges', async () => {
    const unsupportedResponse = await fetch(`${baseUrl}/swarms/intelligence/claims`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        claim: 'Prepared leases are active workers.',
        claim_type: 'observation',
        subject_ref: 'swarm:worker-count',
        confidence: 0.7,
        status: 'supported',
        created_from: 'test',
      }),
    });
    expect(unsupportedResponse.status).toBe(201);
    const unsupported = await unsupportedResponse.json() as any;
    expect(unsupported.status).toBe('proposed');

    const supportedResponse = await fetch(`${baseUrl}/swarms/intelligence/claims`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        claim: 'Prepared leases are not active workers.',
        claim_type: 'observation',
        subject_ref: 'swarm:worker-count',
        evidence_refs: ['runtime-evidence:active_execution_count'],
        confidence: 0.95,
        status: 'supported',
        verified_by_gate: 'dashboard_truth_eval',
        created_from: 'test',
      }),
    });
    expect(supportedResponse.status).toBe(201);
    const supported = await supportedResponse.json() as any;
    expect(supported.status).toBe('supported');

    const contradictionResponse = await fetch(`${baseUrl}/swarms/intelligence/claims`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        claim: 'Prepared leases are active workers.',
        claim_type: 'observation',
        subject_ref: 'swarm:worker-count',
        evidence_refs: ['panel:bad-claim'],
        confidence: 0.6,
        status: 'supported',
        created_from: 'test',
      }),
    });
    expect(contradictionResponse.status).toBe(201);
    const contradiction = await contradictionResponse.json() as any;
    expect(contradiction.status).toBe('contradicted');
    expect(contradiction.invalidated_by).toBe(supported.id);
  });

  it('plans capacity v2 with queue classes and audit manifest previews without starting workers', async () => {
    const { leaseId } = insertPreparedLease({ risk: 'high' });

    const response = await fetch(`${baseUrl}/swarms/intelligence/capacity/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runtime: 'mock' }),
    });
    expect(response.status).toBe(200);
    const plan = await response.json() as any;
    expect(plan.decisions).toHaveLength(1);
    expect(plan.queue_classes).toMatchObject({ security_review: 1 });
    expect(plan.audit_manifest_preview[0]).toMatchObject({
      decision_id: `preview:${leaseId}`,
      lease_id: leaseId,
      action: 'skip',
      policy_version: 'swarm-intelligence-v1',
      queue_class: 'security_review',
    });
    expect(plan.audit_manifest_preview[0].blocked_reasons).toContain('high_risk_requires_security_or_human_gate');

    const lease = db.prepare('SELECT status FROM worker_leases WHERE id = ?').get(leaseId) as any;
    expect(lease.status).toBe('prepared');
  });

  it('records runner manifests with policy, runtime, capacity, budget and gate evidence', async () => {
    const { loopId, leaseId } = insertPreparedLease();
    const response = await fetch(`${baseUrl}/swarms/intelligence/runner-manifests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        decision_id: 'decision-1',
        lease_id: leaseId,
        loop_run_id: loopId,
        action: 'skip',
        policy_version: 'swarm-intelligence-v1',
        runtime_contract: { runtime: 'mock', status: 'ok' },
        capacity_snapshot: { cpu_threads: 8 },
        budget_snapshot: { max_tokens: 1000, used_tokens: 0 },
        gate_refs: ['gate:checker'],
        blocked_reasons: ['checker_required'],
      }),
    });
    expect(response.status).toBe(201);
    const manifest = await response.json() as any;
    expect(manifest).toMatchObject({
      decision_id: 'decision-1',
      lease_id: leaseId,
      loop_run_id: loopId,
      action: 'skip',
      policy_version: 'swarm-intelligence-v1',
      runtime_contract: { runtime: 'mock', status: 'ok' },
      capacity_snapshot: { cpu_threads: 8 },
      budget_snapshot: { max_tokens: 1000, used_tokens: 0 },
      gate_refs: ['gate:checker'],
      blocked_reasons: ['checker_required'],
    });
  });

  it('enforces decision governance gates for high-risk quorum, runtime warnings and merge approval', async () => {
    const response = await fetch(`${baseUrl}/swarms/intelligence/governance/evaluate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        risk_class: 'high',
        mutating: true,
        maker_pass: true,
        checker_pass: true,
        security_checker_pass: true,
        quorum_count: 1,
        quorum_required: 2,
        runtime_warnings: ['runtime_contract_warning'],
        ready_for_human_merge: true,
      }),
    });
    expect(response.status).toBe(200);
    const gate = await response.json() as any;
    expect(gate.status).toBe('blocked');
    expect(gate.blocked_reasons).toEqual(expect.arrayContaining([
      'evaluator_quorum_missing',
      'runtime_warning_gate_failed',
      'human_approval_required_for_completion',
    ]));
    expect(gate.completion_state).toBe('ready_for_human_merge');

    const approvedResponse = await fetch(`${baseUrl}/swarms/intelligence/governance/evaluate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        risk_class: 'high',
        mutating: true,
        maker_pass: true,
        checker_pass: true,
        security_checker_pass: true,
        quorum_count: 2,
        quorum_required: 2,
        runtime_warnings: [],
        ready_for_human_merge: true,
        human_approval_ref: 'approval:test',
      }),
    });
    expect(approvedResponse.status).toBe(200);
    const approved = await approvedResponse.json() as any;
    expect(approved.status).toBe('eligible');
    expect(approved.completion_state).toBe('completed_eligible');
  });

  it('mission control separates workstation execution truth from registry and prepared work', async () => {
    insertPreparedLease({ runtime: 'mock', risk: 'low' });
    db.prepare(`
      INSERT INTO agents (id, name, description, status, capabilities, metadata, last_active_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('agent-registry-only', 'Registry Only', 'no heartbeat', 'idle', '[]', '{}', null, new Date().toISOString(), new Date().toISOString());

    const response = await fetch(`${baseUrl}/swarms/intelligence/mission-control`);
    expect(response.status).toBe(200);
    const mission = await response.json() as any;
    expect(mission.execution_node).toMatchObject({
      cockpit: 'MacBook dashboard',
      workers_run_on: 'workstation',
      active_execution_requires_runtime_evidence: true,
    });
    expect(mission.swarm_truth).toMatchObject({
      registry_agent_count: 1,
      live_agent_count: 0,
      prepared_leases: 1,
      active_execution_count: 0,
      registry_is_not_execution: true,
    });
    expect(mission.next_safe_actions.length).toBeGreaterThan(0);
  });

  it('reports OKF drift as dry-run rebuild input', async () => {
    fs.writeFileSync(path.join(tempOkfBase, 'skills', 'unregistered-skill.md'), [
      '---',
      'type: Skill',
      'title: "Unregistered Skill"',
      'trust_level: validated',
      'status: validated',
      '---',
      '',
      '# Unregistered Skill',
    ].join('\n'));

    const response = await fetch(`${baseUrl}/swarms/intelligence/okf-drift`);
    expect(response.status).toBe(200);
    const drift = await response.json() as any;
    expect(drift).toMatchObject({
      okf_base: tempOkfBase,
      skill_file_count: 1,
      registered_skill_capability_count: 0,
      rebuild_default: 'dry_run',
      reproducible_from: ['OKF files', 'DB swarm_capabilities'],
    });
    expect(drift.missing_registry_entries).toEqual(['unregistered-skill']);
  });
});
