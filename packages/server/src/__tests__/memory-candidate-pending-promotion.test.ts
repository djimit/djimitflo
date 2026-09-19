import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { MemoryCandidateService } from '../services/memory-candidate-service';

describe('MemoryCandidateService.listPendingPromotion', () => {
  let db: Database.Database;
  let svc: MemoryCandidateService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    svc = new MemoryCandidateService(db);
  });

  afterEach(() => { db?.close(); });

  it('returns only non-sensitive operational_memory candidates awaiting promotion', () => {
    const eligible = svc.create({ title: 'Run summary', content: 'The run completed with 4 leases.', memory_type: 'operational_memory' });
    svc.create({ title: 'Auth rule', content: 'How to configure oauth token exchange.', memory_type: 'engineering_rule' });
    svc.create({ title: 'Policy', content: 'All deploys require approval.', memory_type: 'policy_rule' });
    const pending = svc.listPendingPromotion();
    expect(pending.map((c) => c.id)).toEqual([eligible.id]);
  });

  it('excludes a candidate once it has been promoted', () => {
    const candidate = svc.create({ title: 'Run summary', content: 'The run completed cleanly.', memory_type: 'operational_memory' });
    svc.promote(candidate.id);
    expect(svc.listPendingPromotion()).toHaveLength(0);
  });

  it('excludes a security-sensitive operational_memory candidate (routed to review_required by classify())', () => {
    svc.create({ title: 'Deploy note', content: 'Rotated the production API token after the incident.', memory_type: 'operational_memory' });
    expect(svc.listPendingPromotion()).toHaveLength(0);
  });
});
