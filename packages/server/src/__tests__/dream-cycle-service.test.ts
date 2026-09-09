import { describe, expect, it } from 'vitest';
import { DreamCycleService } from '../services/dream-cycle-service';
import { createTestDb } from './helpers/test-db';

describe('DreamCycleService', () => {
  it('ranks capability opportunities without changing capability state', () => {
    const db = createTestDb();
    db.exec(`INSERT INTO swarm_capabilities (id, kind, owner, version, status, risk_ceiling, input_schema_ref, output_schema_ref, eval_score, eval_threshold, removal_strategy, metadata, created_at, updated_at)
      VALUES ('cap-dream', 'skill', 'test', '1', 'candidate', 'low', '', '', 0.2, 0.8, 'manual_review', '{}', datetime('now'), datetime('now'))`);
    const service = new DreamCycleService(db);
    const first = service.runCycle();
    const second = service.runCycle();
    expect(first[0]).toMatchObject({ capabilityId: 'cap-dream', kind: 'evaluate', status: 'proposed' });
    expect(first[0].score).toBeGreaterThan(0);
    expect(second[0].id).toBe(first[0].id);
    expect(db.prepare('SELECT status FROM swarm_capabilities WHERE id = ?').get('cap-dream')).toMatchObject({ status: 'candidate' });
    db.close();
  });
});
