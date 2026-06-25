import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { errorHandler } from '../middleware/error-handler';
import { createSwarmRoutes } from '../routes/swarms';
import { createGoalRoutes } from '../routes/goals';
import { SwarmIntelligenceService, type MissionStatus } from '../services/swarm-intelligence-service';

const auth = { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any;

let db: Database.Database;
let server: Server;
let baseUrl: string;
let svc: SwarmIntelligenceService;

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/swarms', createSwarmRoutes(db, auth));
  app.use('/goals', createGoalRoutes(db, auth));
  app.use(errorHandler);
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  svc = new SwarmIntelligenceService(db);
  await startApp();
});

afterEach(() => {
  server?.close();
  db?.close();
});

describe('G14.1 swarm intelligence kernel', () => {
  it('creates a mission and transitions through the full state machine', () => {
    const mission = svc.createMission({
      title: 'Investigate API rate limiting',
      description: 'Research and design a rate limiting strategy',
      risk_class: 'medium',
    });

    expect(mission.status).toBe('observed');

    const transitions: MissionStatus[] = [
      'hypothesized', 'planned', 'queued', 'prepared',
      'running', 'checking', 'ready_for_human_merge', 'completed',
    ];

    let current = mission;
    for (const next of transitions) {
      current = svc.transitionMission(current.id, next, { reason: `transition to ${next}` });
      expect(current.status).toBe(next);
    }

    // Verify decisions were recorded (order may vary due to same-ms timestamps)
    const decisions = svc.listDecisions(mission.id);
    expect(decisions.length).toBe(transitions.length);
    expect(decisions.every((d) => d.decision_type === 'state_transition')).toBe(true);
    const transitionStrings = decisions.map((d) => d.decision);
    expect(transitionStrings).toContain('observed->hypothesized');
    expect(transitionStrings).toContain('running->checking');
    expect(transitionStrings).toContain('ready_for_human_merge->completed');
  });

  it('rejects illegal state transitions', () => {
    const mission = svc.createMission({ title: 'Test illegal', risk_class: 'low' });
    expect(mission.status).toBe('observed');

    // observed -> completed is illegal (must go through the full lifecycle)
    expect(() => svc.transitionMission(mission.id, 'completed')).toThrow(/SWARM_INVALID_TRANSITION/);

    // observed -> running is illegal (must plan first)
    expect(() => svc.transitionMission(mission.id, 'running')).toThrow(/SWARM_INVALID_TRANSITION/);
  });

  it('creates tasks under a mission and transitions them independently', () => {
    const mission = svc.createMission({ title: 'Mission with tasks', risk_class: 'low' });
    const task = svc.createTask({
      mission_id: mission.id,
      title: 'Research existing solutions',
      description: 'Survey prior art',
    });

    expect(task.status).toBe('observed');
    expect(task.mission_id).toBe(mission.id);

    const advanced = svc.transitionTask(task.id, 'hypothesized');
    expect(advanced.status).toBe('hypothesized');

    const tasks = svc.listTasks(mission.id);
    expect(tasks.length).toBe(1);
    expect(tasks[0].id).toBe(task.id);
  });

  it('records decisions with evidence refs and gate refs', () => {
    const mission = svc.createMission({ title: 'Decision test', risk_class: 'high' });
    const decision = svc.recordDecision({
      mission_id: mission.id,
      decision_type: 'quorum',
      decision: 'quorum_approved',
      reason: '3 of 3 evaluators approved',
      actor: 'evaluator_panel',
      evidence_refs: ['eval_run:abc', 'panel:def'],
      gate_refs: ['quorum_gate', 'risk_gate'],
    });

    expect(decision.decision_type).toBe('quorum');
    expect(decision.evidence_refs).toContain('eval_run:abc');
    expect(decision.gate_refs).toContain('quorum_gate');
  });

  it('mission control separates registry count from active execution', () => {
    // Insert a registry agent (should NOT count as active execution)
    db.prepare(`INSERT INTO agents (id, name, description, status, capabilities, metadata, last_active_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('reg-agent', 'Registry Agent', 'test', 'idle', '[]', '{}', new Date().toISOString(), new Date().toISOString(), new Date().toISOString());

    const mc = svc.missionControl();
    expect(mc.swarm_truth.registry_agent_count).toBeGreaterThan(0);
    expect(mc.swarm_truth.running_leases).toBe(0);
    expect(mc.swarm_truth.registry_is_not_execution).toBe(true);
  });
});

describe('G14.8 circuit breaker', () => {
  it('trips after threshold failures and blocks new work', () => {
    expect(svc.checkCircuitBreaker('runtime:codex').tripped).toBe(false);

    svc.recordCircuitBreakerFailure('runtime:codex');
    svc.recordCircuitBreakerFailure('runtime:codex');
    expect(svc.checkCircuitBreaker('runtime:codex').tripped).toBe(false);

    svc.recordCircuitBreakerFailure('runtime:codex');
    const state = svc.checkCircuitBreaker('runtime:codex');
    expect(state.tripped).toBe(true);
    expect(state.reason).toContain('circuit_breaker_tripped');
  });

  it('resets after explicit reset', () => {
    svc.recordCircuitBreakerFailure('test-scope');
    svc.recordCircuitBreakerFailure('test-scope');
    svc.recordCircuitBreakerFailure('test-scope');
    expect(svc.checkCircuitBreaker('test-scope').tripped).toBe(true);

    svc.resetCircuitBreaker('test-scope');
    expect(svc.checkCircuitBreaker('test-scope').tripped).toBe(false);
  });
});

describe('G14.9 end-to-end swarm scenario smoke', () => {
  it('runs full scenario: question → panel → backlog → mission → tasks → evidence', async () => {
    // 1. Create a specialist panel for a question
    const panelRes = await fetch(`${baseUrl}/swarms/specialist-panels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: 'Rate limiting architecture',
        question: 'Should we use token bucket or sliding window for API rate limiting?',
        risk_class: 'low',
        specialist_ids: ['systems_architect', 'security_reviewer', 'runtime_engineer'],
      }),
    });
    expect(panelRes.status).toBe(201);
    const panel = await panelRes.json();

    // 2. Submit reviews with dissent
    const reviewRes = await fetch(`${baseUrl}/swarms/specialist-panels/${panel.id}/reviews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        specialist_id: 'systems_architect',
        stance: 'support',
        confidence: 0.8,
        findings: 'Token bucket is simpler and sufficient for our scale',
        recommendations: 'Use token bucket with burst capacity',
        evidence_refs: ['doc:rate-limit-comparison'],
      }),
    });
    expect(reviewRes.status).toBe(200);

    const dissentRes = await fetch(`${baseUrl}/swarms/specialist-panels/${panel.id}/reviews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        specialist_id: 'security_reviewer',
        stance: 'uncertain',
        confidence: 0.6,
        findings: 'Sliding window might provide better DDoS protection for public endpoints',
        recommendations: 'Consider sliding window for public endpoints as a follow-up',
        evidence_refs: ['doc:ddos-mitigation'],
      }),
    });
    expect(dissentRes.status).toBe(200);

    // 2b. Submit 3rd review to reach consensus
    const thirdReviewRes = await fetch(`${baseUrl}/swarms/specialist-panels/${panel.id}/reviews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        specialist_id: 'runtime_engineer',
        stance: 'support',
        confidence: 0.7,
        findings: 'Token bucket is implementable with existing runtime infrastructure',
        recommendations: 'Start with token bucket, evaluate sliding window later',
        evidence_refs: ['doc:runtime-capabilities'],
      }),
    });
    expect(thirdReviewRes.status).toBe(200);

    // 3. Get panel to verify consensus (reviews auto-compute consensus)
    const panelGetRes = await fetch(`${baseUrl}/swarms/specialist-panels/${panel.id}`);
    expect(panelGetRes.status).toBe(200);
    const closedPanel = await panelGetRes.json();
    expect(closedPanel.consensus).toBeDefined();

    // 4. Project consensus to backlog
    const backlogRes = await fetch(`${baseUrl}/swarms/specialist-panels/${panel.id}/backlog`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(backlogRes.status).toBe(201);

    // 5. Create a mission from the panel question
    const mission = svc.createMission({
      title: 'Implement rate limiting',
      description: 'Based on specialist panel recommendation',
      risk_class: 'low',
      panel_id: panel.id,
      evidence_refs: [`panel:${panel.id}`],
    });
    expect(mission.status).toBe('observed');

    // 6. Create tasks under the mission
    const task1 = svc.createTask({
      mission_id: mission.id,
      title: 'Implement token bucket rate limiter',
      evidence_refs: [`panel:${panel.id}`],
    });
    const task2 = svc.createTask({
      mission_id: mission.id,
      title: 'Add sliding window for public endpoints',
      evidence_refs: [`panel:${panel.id}`],
    });
    expect(svc.listTasks(mission.id).length).toBe(2);

    // 7. Transition through the lifecycle
    svc.transitionMission(mission.id, 'hypothesized');
    svc.transitionMission(mission.id, 'planned');
    svc.transitionMission(mission.id, 'queued');

    // 8. Create claims linking to the mission
    const claim = svc.createClaim({
      claim: 'Token bucket rate limiting is sufficient for internal APIs',
      claim_type: 'decision',
      subject_ref: `mission:${mission.id}`,
      confidence: 0.8,
      status: 'supported',
      evidence_refs: [`panel:${panel.id}`, `task:${task1.id}`],
      created_from: 'swarm_intelligence_smoke',
    });
    expect(claim.status).toBe('supported');

    // 9. Create evidence edges
    svc.createEvidenceEdge(`panel:${panel.id}`, `mission:${mission.id}`, 'informs');
    svc.createEvidenceEdge(`mission:${mission.id}`, `task:${task1.id}`, 'decomposes_to');
    svc.createEvidenceEdge(`task:${task1.id}`, `claim:${claim.id}`, 'supports');

    // 10. Verify no auto-merge/push/deploy occurred
    const decisions = svc.listDecisions(mission.id);
    for (const d of decisions) {
      expect(d.decision).not.toMatch(/merge|push|deploy/);
    }

    // 11. Verify the full evidence chain exists
    const mc = svc.missionControl();
    expect(mc.claim_health.total).toBeGreaterThan(0);

    // 12. Transition to completed via the full lifecycle
    svc.transitionMission(mission.id, 'prepared');
    svc.transitionMission(mission.id, 'running');
    svc.transitionMission(mission.id, 'checking');
    svc.transitionMission(mission.id, 'ready_for_human_merge');
    svc.transitionMission(mission.id, 'completed');

    const finalMission = svc.getMission(mission.id);
    expect(finalMission.status).toBe('completed');

    // 13. Verify decisions were recorded for all transitions
    const allDecisions = svc.listDecisions(mission.id);
    expect(allDecisions.length).toBeGreaterThanOrEqual(8); // 8 transitions
    expect(allDecisions.every((d) => d.decision_type === 'state_transition')).toBe(true);
  });

  it('proves no automatic memory promotion occurs during the scenario', async () => {
    // Create a claim that would need human review for promotion
    const claim = svc.createClaim({
      claim: 'Policy: all rate limiting changes require security review',
      claim_type: 'policy',
      subject_ref: 'test:policy-claim',
      confidence: 0.9,
      status: 'proposed',
      created_from: 'swarm_intelligence_smoke',
    });

    // Verify it stays in proposed status (no auto-promotion)
    const retrieved = svc.getClaim(claim.id);
    expect(retrieved.status).toBe('proposed');

    // Check memory candidates — none should be promoted
    const promoted = db.prepare("SELECT COUNT(*) as count FROM memory_candidates WHERE status = 'promoted'").get() as any;
    expect(promoted.count).toBe(0);
  });
});
