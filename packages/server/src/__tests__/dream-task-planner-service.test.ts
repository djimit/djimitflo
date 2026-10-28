import { describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { DreamCycleService } from '../services/dream-cycle-service';
import { DreamTaskPlannerService, type DreamTaskEnvelope } from '../services/dream-task-planner-service';
import { WorkItemService } from '../services/work-item-service';
import { createTestDb } from './helpers/test-db';
import type { Database } from 'better-sqlite3';

interface OppSeed {
  id: string;
  capability_id?: string;
  score: number;
  kind?: 'improve' | 'create' | 'evaluate';
  title?: string;
  rationale?: string;
  suggested_action?: string;
  status?: string;
  dedupe_key?: string;
}

function seedOpportunities(db: Database, opps: OppSeed[]): void {
  const stmt = db.prepare(`INSERT INTO dream_opportunities
    (id, capability_id, score, kind, title, rationale, suggested_action, status, dedupe_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const o of opps) {
    stmt.run(
      o.id,
      o.capability_id ?? 'cap-x',
      o.score,
      o.kind ?? 'evaluate',
      o.title ?? `Task ${o.id}`,
      o.rationale ?? 'rationale text',
      o.suggested_action ?? 'Run an independent evaluation.',
      o.status ?? 'proposed',
      o.dedupe_key ?? `dk-${o.id}`,
    );
  }
}

function envelopeDedupeKey(opportunityId: string): string {
  return `dream-task:${createHash('sha256').update(opportunityId).digest('hex').slice(0, 24)}`;
}

function getEmission(db: Database, dedupeKey: string): { envelope_json: string | null; exported_at: string | null } | undefined {
  return db.prepare('SELECT envelope_json, exported_at FROM dream_task_emissions WHERE dedupe_key = ?').get(dedupeKey) as
    | { envelope_json: string | null; exported_at: string | null }
    | undefined;
}

describe('DreamTaskPlannerService', () => {
  it('emits one idempotent dream task and preserves proposal state', () => {
    const db = createTestDb();
    db.exec(`INSERT INTO swarm_capabilities (id, kind, owner, version, status, risk_ceiling, input_schema_ref, output_schema_ref, eval_score, eval_threshold, removal_strategy, metadata, created_at, updated_at)
      VALUES ('cap-plan', 'skill', 'test', '1', 'candidate', 'low', '', '', 0.2, 0.8, 'manual_review', '{}', datetime('now'), datetime('now'))`);
    const dreams = new DreamCycleService(db);
    dreams.runCycle();
    const planner = new DreamTaskPlannerService(db);
    const first = planner.plan();
    expect(planner.exportPending()).toBe(1);
    const second = planner.plan();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ event: 'dream.opportunity', task_type: 'triage', status: 'backlog' });
    expect(first[0].metadata).toMatchObject({ execution_tier: 'A2', human_required: true });
    expect(second).toHaveLength(0);
    expect(db.prepare('SELECT status FROM dream_opportunities').get()).toMatchObject({ status: 'proposed' });
    db.close();
  });

  it('builds the full envelope shape for an evaluate opportunity, including the deterministic dedupe key', () => {
    const db = createTestDb();
    new DreamCycleService(db);
    new DreamTaskPlannerService(db);
    seedOpportunities(db, [{
      id: 'opp-eval-1', capability_id: 'cap-eval', score: 0.6, kind: 'evaluate',
      title: 'Evaluate cap-eval', rationale: 'why-eval', suggested_action: 'Run holdout eval.',
    }]);
    const planner = new DreamTaskPlannerService(db);
    const [env] = planner.plan() as DreamTaskEnvelope[];
    const expectedKey = envelopeDedupeKey('opp-eval-1');
    expect(env).toMatchObject({
      event: 'dream.opportunity',
      task_title: 'Evaluate cap-eval',
      task_type: 'triage',
      priority: 'high',
      severity: 'high',
      status: 'backlog',
      dedupe_key: expectedKey,
      summary: 'why-eval',
      assignee_role: 'architecture/security-reviewer',
      labels: ['dream-cycle', 'evaluation'],
    });
    expect(env.context).toBe('Run holdout eval. Capability=cap-eval. This is an inert proposal; Paperclip/DAPS/OpenMythos gates remain authoritative.');
    expect(env.metadata).toMatchObject({
      source: 'djimitflo.dream_cycle',
      opportunity_id: 'opp-eval-1',
      capability_id: 'cap-eval',
      score: 0.6,
      execution_tier: 'A2',
      human_required: true,
    });
    const stored = getEmission(db, expectedKey);
    expect(stored?.envelope_json).toBe(JSON.stringify(env));
    expect(stored?.exported_at).toBeNull();
    db.close();
  });

  it('routes improve and create opportunities to the skill-factory agent and capability-improvement label', () => {
    const db = createTestDb();
    new DreamCycleService(db);
    new DreamTaskPlannerService(db);
    seedOpportunities(db, [
      { id: 'opp-improve', score: 0.5, kind: 'improve', title: 'Improve', suggested_action: 'Design smallest change.', capability_id: 'cap-i' },
      { id: 'opp-create', score: 0.4, kind: 'create', title: 'Extend', suggested_action: 'Draft proposal.', capability_id: 'cap-c' },
    ]);
    const planner = new DreamTaskPlannerService(db);
    const envs = planner.plan() as DreamTaskEnvelope[];
    const byId = Object.fromEntries(envs.map(e => [e.metadata.opportunity_id, e]));
    expect(byId['opp-improve']).toMatchObject({
      task_type: 'skill_candidate', assignee_role: 'skill-factory-agent',
      labels: ['dream-cycle', 'capability-improvement'],
      context: 'Design smallest change. Capability=cap-i. This is an inert proposal; Paperclip/DAPS/OpenMythos gates remain authoritative.',
    });
    expect(byId['opp-create']).toMatchObject({
      task_type: 'skill_candidate', assignee_role: 'skill-factory-agent',
      labels: ['dream-cycle', 'capability-improvement'],
      context: 'Draft proposal. Capability=cap-c. This is an inert proposal; Paperclip/DAPS/OpenMythos gates remain authoritative.',
    });
    db.close();
  });

  it('assigns priority and severity by score thresholds (0.5 high, 0.35 medium, below low)', () => {
    const db = createTestDb();
    new DreamCycleService(db);
    new DreamTaskPlannerService(db);
    seedOpportunities(db, [
      { id: 'opp-050', score: 0.5, kind: 'improve' },
      { id: 'opp-035', score: 0.35, kind: 'improve' },
      { id: 'opp-030', score: 0.3, kind: 'improve' },
    ]);
    const planner = new DreamTaskPlannerService(db);
    const envs = planner.plan() as DreamTaskEnvelope[];
    const byId = Object.fromEntries(envs.map(e => [e.metadata.opportunity_id, e]));
    expect(byId['opp-050'].priority).toBe('high');
    expect(byId['opp-050'].severity).toBe('high');
    expect(byId['opp-035'].priority).toBe('medium');
    expect(byId['opp-035'].severity).toBe('medium');
    expect(byId['opp-030'].priority).toBe('low');
    expect(byId['opp-030'].severity).toBe('low');
    db.close();
  });

  it('clamps the limit to [1,10] and orders by score descending', () => {
    const db = createTestDb();
    new DreamCycleService(db);
    new DreamTaskPlannerService(db);
    const opps: OppSeed[] = Array.from({ length: 11 }, (_, i) => ({
      id: `opp-clamp-${i}`, score: 0.9 - i * 0.05, kind: 'improve',
    }));
    seedOpportunities(db, opps);
    const planner = new DreamTaskPlannerService(db);
    const ten = planner.plan(100) as DreamTaskEnvelope[];
    expect(ten).toHaveLength(10);
    expect(ten[0].metadata.opportunity_id).toBe('opp-clamp-0');
    expect(ten[9].metadata.opportunity_id).toBe('opp-clamp-9');
    const five = new DreamTaskPlannerService(db).plan(5) as DreamTaskEnvelope[];
    expect(five).toHaveLength(5);
    expect(five.map(e => e.metadata.score)).toEqual([0.9, 0.85, 0.8, 0.75, 0.7]);
    const one = new DreamTaskPlannerService(db).plan(0) as DreamTaskEnvelope[];
    expect(one).toHaveLength(1);
    db.close();
  });

  it('filters by minScore using an inclusive >= boundary', () => {
    const db = createTestDb();
    new DreamCycleService(db);
    new DreamTaskPlannerService(db);
    seedOpportunities(db, [
      { id: 'opp-edge', score: 0.25, kind: 'improve' },
      { id: 'opp-under', score: 0.249, kind: 'improve' },
    ]);
    const planner = new DreamTaskPlannerService(db);
    const envs = planner.plan(10, 0.25) as DreamTaskEnvelope[];
    expect(envs.map(e => e.metadata.opportunity_id)).toEqual(['opp-edge']);
    db.close();
  });

  it('re-emits when a prior emission row has no envelope_json, persisting the envelope', () => {
    const db = createTestDb();
    new DreamCycleService(db);
    new DreamTaskPlannerService(db);
    seedOpportunities(db, [{ id: 'opp-backfill', score: 0.5, kind: 'evaluate', title: 'Backfill' }]);
    const dedupeKey = envelopeDedupeKey('opp-backfill');
    db.prepare('INSERT INTO dream_task_emissions (dedupe_key, opportunity_id) VALUES (?, ?)').run(dedupeKey, 'opp-backfill');
    const planner = new DreamTaskPlannerService(db);
    const envs = planner.plan() as DreamTaskEnvelope[];
    expect(envs).toHaveLength(1);
    expect(envs[0].task_title).toBe('Backfill');
    expect(getEmission(db, dedupeKey)?.envelope_json).toBe(JSON.stringify(envs[0]));
    db.close();
  });

  it('re-emits the freshly computed envelope when envelope_json is set but exported_at is null, without overwriting stored envelope_json', () => {
    const db = createTestDb();
    new DreamCycleService(db);
    new DreamTaskPlannerService(db);
    seedOpportunities(db, [{ id: 'opp-reemit', score: 0.5, kind: 'evaluate', title: 'Fresh Title' }]);
    const dedupeKey = envelopeDedupeKey('opp-reemit');
    db.prepare('INSERT INTO dream_task_emissions (dedupe_key, opportunity_id, envelope_json, exported_at) VALUES (?, ?, ?, NULL)').run(
      dedupeKey, 'opp-reemit', JSON.stringify({ event: 'dream.opportunity', task_title: 'Stale' }),
    );
    const planner = new DreamTaskPlannerService(db);
    const envs = planner.plan() as DreamTaskEnvelope[];
    expect(envs).toHaveLength(1);
    expect(envs[0].task_title).toBe('Fresh Title');
    const stored = getEmission(db, dedupeKey);
    expect(stored?.exported_at).toBeNull();
    expect(JSON.parse(stored?.envelope_json ?? '{}')).toMatchObject({ task_title: 'Stale' });
    db.close();
  });

  it('does not re-emit once an emission has been exported', () => {
    const db = createTestDb();
    new DreamCycleService(db);
    new DreamTaskPlannerService(db);
    seedOpportunities(db, [{ id: 'opp-exported', score: 0.5, kind: 'evaluate' }]);
    const dedupeKey = envelopeDedupeKey('opp-exported');
    db.prepare('INSERT INTO dream_task_emissions (dedupe_key, opportunity_id, envelope_json, exported_at) VALUES (?, ?, ?, ?)').run(
      dedupeKey, 'opp-exported', JSON.stringify({ task_title: 'stored' }), '2024-01-01T00:00:00.000Z',
    );
    const planner = new DreamTaskPlannerService(db);
    expect(planner.plan()).toHaveLength(0);
    db.close();
  });

  it('exportPending returns 0 when there is nothing to plan and creates no work items', () => {
    const db = createTestDb();
    new DreamCycleService(db);
    const planner = new DreamTaskPlannerService(db);
    expect(planner.exportPending()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM work_items').get()).toMatchObject({ n: 0 });
    db.close();
  });

  it('exportPending creates one candidate work item per task, sets exported_at, and routes by task_type', () => {
    const db = createTestDb();
    new DreamCycleService(db);
    new DreamTaskPlannerService(db);
    seedOpportunities(db, [
      { id: 'opp-exp-triage', score: 0.6, kind: 'evaluate', title: 'Triage Task', suggested_action: 'Eval.', capability_id: 'cap-t' },
      { id: 'opp-exp-skill', score: 0.5, kind: 'improve', title: 'Skill Task', suggested_action: 'Improve.', capability_id: 'cap-s' },
    ]);
    const planner = new DreamTaskPlannerService(db);
    const count = planner.exportPending();
    expect(count).toBe(2);
    const triageKey = envelopeDedupeKey('opp-exp-triage');
    const skillKey = envelopeDedupeKey('opp-exp-skill');
    expect(getEmission(db, triageKey)?.exported_at).not.toBeNull();
    expect(getEmission(db, skillKey)?.exported_at).not.toBeNull();
    const workItems = new WorkItemService(db).list({ limit: 100 });
    const byRef = Object.fromEntries(workItems.map(w => [w.source_ref ?? '', w]));
    expect(byRef[triageKey]).toMatchObject({
      source: 'dream_cycle', risk_class: 'low', status: 'candidate', recommended_loop: 'outcome-learning-loop',
    });
    expect(byRef[skillKey]).toMatchObject({
      source: 'dream_cycle', risk_class: 'low', status: 'candidate', recommended_loop: 'research-loop',
    });
    expect(byRef[triageKey].metadata).toMatchObject({ labels: ['dream-cycle', 'evaluation'], assignee_role: 'architecture/security-reviewer' });
    expect(byRef[skillKey].metadata).toMatchObject({ labels: ['dream-cycle', 'capability-improvement'], assignee_role: 'skill-factory-agent' });
    expect(byRef[triageKey].description).toContain('Eval. Capability=cap-t.');
    expect(planner.exportPending()).toBe(0);
    db.close();
  });

  it('exportPending is idempotent across planner instances (dedupe keyed by opportunity id)', () => {
    const db = createTestDb();
    new DreamCycleService(db);
    new DreamTaskPlannerService(db);
    seedOpportunities(db, [{ id: 'opp-idem', score: 0.6, kind: 'evaluate' }]);
    expect(new DreamTaskPlannerService(db).exportPending()).toBe(1);
    expect(new DreamTaskPlannerService(db).exportPending()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM work_items').get()).toMatchObject({ n: 1 });
    db.close();
  });
});