import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DreamCycleService } from '../services/dream-cycle-service';
import { DreamTaskPlannerService } from '../services/dream-task-planner-service';
import { createTestDb } from './helpers/test-db';

describe('DreamTaskPlannerService', () => {
  it('emits one idempotent Paperclip envelope and preserves proposal state', () => {
    const db = createTestDb();
    db.exec(`INSERT INTO swarm_capabilities (id, kind, owner, version, status, risk_ceiling, input_schema_ref, output_schema_ref, eval_score, eval_threshold, removal_strategy, metadata, created_at, updated_at)
      VALUES ('cap-plan', 'skill', 'test', '1', 'candidate', 'low', '', '', 0.2, 0.8, 'manual_review', '{}', datetime('now'), datetime('now'))`);
    const dreams = new DreamCycleService(db);
    dreams.runCycle();
    const initialScore = dreams.list()[0].score;
    db.prepare("UPDATE swarm_capabilities SET eval_score = 0.5 WHERE id = 'cap-plan'").run();
    dreams.runCycle();
    expect(dreams.list()).toEqual([expect.objectContaining({ score: expect.any(Number), rationale: expect.stringContaining('gap=0.300') })]);
    expect(dreams.list()[0].score).toBeLessThan(initialScore);
    const planner = new DreamTaskPlannerService(db);
    const first = planner.plan();
    const pending = join(mkdtempSync(join(tmpdir(), 'dream-plan-')), 'pending.jsonl');
    expect(planner.exportPending(pending)).toBe(1);
    expect(readFileSync(pending, 'utf8')).toContain('dream.opportunity');
    const second = planner.plan();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ event: 'dream.opportunity', task_type: 'triage', status: 'backlog' });
    expect(first[0].metadata).toMatchObject({ execution_tier: 'A2', human_required: true });
    expect(second).toHaveLength(0);
    expect(db.prepare('SELECT status FROM dream_opportunities').get()).toMatchObject({ status: 'proposed' });
    db.close();
  });
});
