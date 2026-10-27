import { createHash } from 'crypto';
import type { Database } from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { DreamCycleService } from '../services/dream-cycle-service';
import { DreamTaskPlannerService } from '../services/dream-task-planner-service';
import { createTestDb } from './helpers/test-db';

function setupDb(): Database {
  const db = createTestDb();
  new DreamCycleService(db);
  return db;
}

function insertOpportunity(
  db: Database,
  opts: {
    id: string;
    capabilityId?: string;
    score: number;
    kind: 'improve' | 'create' | 'evaluate';
    title?: string;
    rationale?: string;
    suggestedAction?: string;
  },
): void {
  db.prepare(
    `INSERT INTO dream_opportunities (id, capability_id, score, kind, title, rationale, suggested_action, dedupe_key, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed')`,
  ).run(
    opts.id,
    opts.capabilityId ?? 'cap-1',
    opts.score,
    opts.kind,
    opts.title ?? `Task ${opts.id}`,
    opts.rationale ?? `Rationale for ${opts.id}`,
    opts.suggestedAction ?? `Action for ${opts.id}`,
    `dedupe-${opts.id}`,
  );
}

function expectedDedupeKey(id: string): string {
  return `dream-task:${createHash('sha256').update(id).digest('hex').slice(0, 24)}`;
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

  it('assigns high priority when score >= 0.5', () => {
    const db = setupDb();
    insertOpportunity(db, { id: 'opp-high', score: 0.6, kind: 'evaluate' });
    const result = new DreamTaskPlannerService(db).plan();
    expect(result).toHaveLength(1);
    expect(result[0].priority).toBe('high');
    expect(result[0].severity).toBe('high');
    db.close();
  });

  it('assigns medium priority when 0.35 <= score < 0.5', () => {
    const db = setupDb();
    insertOpportunity(db, { id: 'opp-med', score: 0.4, kind: 'evaluate' });
    const result = new DreamTaskPlannerService(db).plan();
    expect(result).toHaveLength(1);
    expect(result[0].priority).toBe('medium');
    expect(result[0].severity).toBe('medium');
    db.close();
  });

  it('assigns low priority when score < 0.35', () => {
    const db = setupDb();
    insertOpportunity(db, { id: 'opp-low', score: 0.3, kind: 'evaluate' });
    const result = new DreamTaskPlannerService(db).plan();
    expect(result).toHaveLength(1);
    expect(result[0].priority).toBe('low');
    expect(result[0].severity).toBe('low');
    db.close();
  });

  it('treats score 0.5 as high and 0.35 as medium (boundary)', () => {
    const db = setupDb();
    insertOpportunity(db, { id: 'opp-050', score: 0.5, kind: 'evaluate' });
    insertOpportunity(db, { id: 'opp-035', score: 0.35, kind: 'evaluate' });
    const result = new DreamTaskPlannerService(db).plan(10, 0);
    expect(result).toHaveLength(2);
    const high = result.find((r) => r.metadata.opportunity_id === 'opp-050');
    const med = result.find((r) => r.metadata.opportunity_id === 'opp-035');
    expect(high?.priority).toBe('high');
    expect(med?.priority).toBe('medium');
    db.close();
  });

  it('maps evaluate kind to triage task with security reviewer', () => {
    const db = setupDb();
    insertOpportunity(db, { id: 'opp-eval', score: 0.5, kind: 'evaluate' });
    const [envelope] = new DreamTaskPlannerService(db).plan();
    expect(envelope.task_type).toBe('triage');
    expect(envelope.assignee_role).toBe('architecture/security-reviewer');
    expect(envelope.labels).toEqual(['dream-cycle', 'evaluation']);
    db.close();
  });

  it('maps improve kind to skill candidate with skill-factory agent', () => {
    const db = setupDb();
    insertOpportunity(db, { id: 'opp-improve', score: 0.5, kind: 'improve' });
    const [envelope] = new DreamTaskPlannerService(db).plan();
    expect(envelope.task_type).toBe('skill_candidate');
    expect(envelope.assignee_role).toBe('skill-factory-agent');
    expect(envelope.labels).toEqual(['dream-cycle', 'capability-improvement']);
    db.close();
  });

  it('maps create kind to skill candidate with skill-factory agent', () => {
    const db = setupDb();
    insertOpportunity(db, { id: 'opp-create', score: 0.5, kind: 'create' });
    const [envelope] = new DreamTaskPlannerService(db).plan();
    expect(envelope.task_type).toBe('skill_candidate');
    expect(envelope.assignee_role).toBe('skill-factory-agent');
    expect(envelope.labels).toEqual(['dream-cycle', 'capability-improvement']);
    db.close();
  });

  it('computes dedupe_key as first 24 hex chars of sha256 of opportunity id', () => {
    const db = setupDb();
    insertOpportunity(db, { id: 'opp-dedupe', score: 0.5, kind: 'evaluate' });
    const [envelope] = new DreamTaskPlannerService(db).plan();
    expect(envelope.dedupe_key).toBe(expectedDedupeKey('opp-dedupe'));
    db.close();
  });

  it('populates summary, context, and metadata from the opportunity', () => {
    const db = setupDb();
    insertOpportunity(db, {
      id: 'opp-full',
      capabilityId: 'cap-xyz',
      score: 0.42,
      kind: 'evaluate',
      title: 'Full envelope test',
      rationale: 'Because leverage',
      suggestedAction: 'Run evaluation suite',
    });
    const [envelope] = new DreamTaskPlannerService(db).plan();
    expect(envelope.task_title).toBe('Full envelope test');
    expect(envelope.summary).toBe('Because leverage');
    expect(envelope.context).toBe(
      'Run evaluation suite Capability=cap-xyz. This is an inert proposal; Paperclip/DAPS/OpenMythos gates remain authoritative.',
    );
    expect(envelope.metadata).toMatchObject({
      source: 'djimitflo.dream_cycle',
      opportunity_id: 'opp-full',
      capability_id: 'cap-xyz',
      score: 0.42,
      execution_tier: 'A2',
      human_required: true,
    });
    db.close();
  });

  it('clamps limit to at most 10', () => {
    const db = setupDb();
    for (let i = 0; i < 15; i++) insertOpportunity(db, { id: `opp-${i}`, score: 0.5 - i * 0.01, kind: 'evaluate' });
    const capped = new DreamTaskPlannerService(db).plan(20, 0);
    expect(capped).toHaveLength(10);
    db.close();
  });

  it('clamps limit to at least 1', () => {
    const db = setupDb();
    insertOpportunity(db, { id: 'opp-min', score: 0.5, kind: 'evaluate' });
    const result = new DreamTaskPlannerService(db).plan(0, 0);
    expect(result).toHaveLength(1);
    db.close();
  });

  it('filters out opportunities below minScore', () => {
    const db = setupDb();
    insertOpportunity(db, { id: 'opp-above', score: 0.5, kind: 'evaluate' });
    insertOpportunity(db, { id: 'opp-below', score: 0.1, kind: 'evaluate' });
    const result = new DreamTaskPlannerService(db).plan(10, 0.3);
    expect(result).toHaveLength(1);
    expect(result[0].metadata).toMatchObject({ opportunity_id: 'opp-above' });
    db.close();
  });

  it('persists envelope_json to the emissions table on first plan', () => {
    const db = setupDb();
    insertOpportunity(db, { id: 'opp-persist', score: 0.5, kind: 'evaluate' });
    const dk = expectedDedupeKey('opp-persist');
    new DreamTaskPlannerService(db).plan();
    const row = db.prepare('SELECT envelope_json FROM dream_task_emissions WHERE dedupe_key = ?').get(dk) as {
      envelope_json: string;
    };
    expect(row.envelope_json).toBeTruthy();
    expect(JSON.parse(row.envelope_json).metadata.opportunity_id).toBe('opp-persist');
    db.close();
  });

  it('returns envelopes on second plan call when not yet exported', () => {
    const db = setupDb();
    insertOpportunity(db, { id: 'opp-reemit', score: 0.5, kind: 'evaluate' });
    const planner = new DreamTaskPlannerService(db);
    expect(planner.plan()).toHaveLength(1);
    expect(planner.plan()).toHaveLength(1);
    db.close();
  });

  it('does not re-emit after export sets exported_at', () => {
    const db = setupDb();
    insertOpportunity(db, { id: 'opp-postexport', score: 0.5, kind: 'evaluate' });
    const planner = new DreamTaskPlannerService(db);
    planner.plan();
    expect(planner.exportPending()).toBe(1);
    expect(planner.plan()).toHaveLength(0);
    const row = db.prepare('SELECT exported_at FROM dream_task_emissions WHERE dedupe_key = ?').get(
      expectedDedupeKey('opp-postexport'),
    ) as { exported_at: string };
    expect(row.exported_at).toBeTruthy();
    db.close();
  });

  it('re-emits when exported_at is cleared', () => {
    const db = setupDb();
    insertOpportunity(db, { id: 'opp-clear', score: 0.5, kind: 'evaluate' });
    const dk = expectedDedupeKey('opp-clear');
    const planner = new DreamTaskPlannerService(db);
    planner.plan();
    planner.exportPending();
    expect(planner.plan()).toHaveLength(0);
    db.prepare('UPDATE dream_task_emissions SET exported_at = NULL WHERE dedupe_key = ?').run(dk);
    expect(planner.plan()).toHaveLength(1);
    db.close();
  });

  it('updates envelope_json for pre-existing emission row without envelope', () => {
    const db = setupDb();
    insertOpportunity(db, { id: 'opp-preexist', score: 0.5, kind: 'evaluate' });
    const dk = expectedDedupeKey('opp-preexist');
    const planner = new DreamTaskPlannerService(db);
    db.prepare('INSERT INTO dream_task_emissions (dedupe_key, opportunity_id) VALUES (?, ?)').run(dk, 'opp-preexist');
    const result = planner.plan();
    expect(result).toHaveLength(1);
    const row = db.prepare('SELECT envelope_json FROM dream_task_emissions WHERE dedupe_key = ?').get(dk) as {
      envelope_json: string;
    };
    expect(row.envelope_json).toBeTruthy();
    expect(JSON.parse(row.envelope_json)).toMatchObject({ task_title: 'Task opp-preexist' });
    db.close();
  });

  it('exportPending returns 0 when no opportunities exist', () => {
    const db = setupDb();
    expect(new DreamTaskPlannerService(db).exportPending()).toBe(0);
    db.close();
  });

  it('exportPending creates work items with outcome-learning-loop for triage tasks', () => {
    const db = setupDb();
    insertOpportunity(db, { id: 'opp-triage', score: 0.5, kind: 'evaluate' });
    const planner = new DreamTaskPlannerService(db);
    expect(planner.exportPending()).toBe(1);
    const wi = db
      .prepare('SELECT * FROM work_items WHERE source = ? AND source_ref = ?')
      .get('dream_cycle', expectedDedupeKey('opp-triage')) as {
      title: string;
      description: string;
      risk_class: string;
      status: string;
      recommended_loop: string;
      metadata: string;
    };
    expect(wi).toBeTruthy();
    expect(wi.recommended_loop).toBe('outcome-learning-loop');
    expect(wi.title).toBe('Task opp-triage');
    expect(wi.risk_class).toBe('low');
    expect(wi.status).toBe('candidate');
    const meta = JSON.parse(wi.metadata);
    expect(meta.labels).toEqual(['dream-cycle', 'evaluation']);
    expect(meta.assignee_role).toBe('architecture/security-reviewer');
    db.close();
  });

  it('exportPending creates work items with research-loop for skill candidate tasks', () => {
    const db = setupDb();
    insertOpportunity(db, { id: 'opp-skill', score: 0.5, kind: 'improve' });
    const planner = new DreamTaskPlannerService(db);
    expect(planner.exportPending()).toBe(1);
    const wi = db
      .prepare('SELECT * FROM work_items WHERE source = ? AND source_ref = ?')
      .get('dream_cycle', expectedDedupeKey('opp-skill')) as { recommended_loop: string };
    expect(wi).toBeTruthy();
    expect(wi.recommended_loop).toBe('research-loop');
    db.close();
  });

  it('exportPending sets exported_at on all emitted tasks', () => {
    const db = setupDb();
    insertOpportunity(db, { id: 'opp-exp1', score: 0.6, kind: 'evaluate' });
    insertOpportunity(db, { id: 'opp-exp2', score: 0.5, kind: 'improve' });
    const planner = new DreamTaskPlannerService(db);
    expect(planner.exportPending()).toBe(2);
    const rows = db.prepare('SELECT exported_at FROM dream_task_emissions').all() as { exported_at: string }[];
    expect(rows.every((r) => r.exported_at)).toBe(true);
    db.close();
  });
});