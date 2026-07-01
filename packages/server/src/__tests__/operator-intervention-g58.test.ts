import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { OperatorInterventionService } from '../services/operator-intervention';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let intervention: OperatorInterventionService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  intervention = new OperatorInterventionService(db, null as any, null as any);
});

afterEach(() => {
  db?.close();
});

describe('G58: Operator Intervention Protocol', () => {
  it('creates intervention request', () => {
    const req = intervention.requestIntervention('run-1', 'Low confidence', { competence: 0.2 });
    expect(req.id).toBeDefined();
    expect(req.status).toBe('pending');
    expect(req.reason).toBe('Low confidence');
  });

  it('approves intervention', () => {
    const req = intervention.requestIntervention('run-2', 'Test');
    intervention.approveIntervention(req.id);
    const pending = intervention.getPendingInterventions();
    expect(pending.find(r => r.id === req.id)).toBeUndefined();
  });

  it('rejects intervention with feedback', () => {
    const req = intervention.requestIntervention('run-3', 'Test');
    intervention.rejectIntervention(req.id, 'Not needed');
    const pending = intervention.getPendingInterventions();
    expect(pending.find(r => r.id === req.id)).toBeUndefined();
  });

  it('getPendingInterventions returns only pending', () => {
    intervention.requestIntervention('run-4', 'Pending 1');
    intervention.requestIntervention('run-5', 'Pending 2');
    const pending = intervention.getPendingInterventions();
    expect(pending.length).toBe(2);
  });

  it('expireIntervention sets expired status', () => {
    const req = intervention.requestIntervention('run-6', 'Will expire');
    intervention.expireIntervention(req.id);
    const history = intervention.getInterventionHistory(10);
    const found = history.find(r => r.id === req.id);
    expect(found!.status).toBe('expired');
  });

  it('getInterventionHistory returns all', () => {
    intervention.requestIntervention('run-7', 'Test 1');
    intervention.requestIntervention('run-8', 'Test 2');
    const history = intervention.getInterventionHistory(10);
    expect(history.length).toBe(2);
  });

  it('context is preserved in request', () => {
    const req = intervention.requestIntervention('run-9', 'Test', { key: 'value', num: 42 });
    expect(req.context).toEqual({ key: 'value', num: 42 });
  });
});
