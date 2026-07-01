import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { ControlLoopSelfModificationService } from '../services/control-loop-self-modification-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let selfMod: ControlLoopSelfModificationService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  selfMod = new ControlLoopSelfModificationService(db);
});

afterEach(() => {
  db?.close();
});

describe('G60: Control Loop Self-Modification', () => {
  it('creates proposal as draft', () => {
    const proposal = selfMod.proposeChange('test-loop', { trigger: ['new-trigger'] }, 'Add new trigger');
    expect(proposal.id).toBeDefined();
    expect(proposal.status).toBe('draft');
    expect(proposal.evalScore).toBeNull();
  });

  it('evaluateProposal returns score', () => {
    const proposal = selfMod.proposeChange('test-loop', { trigger: ['t1'] }, 'Test');
    const score = selfMod.evaluateProposal(proposal.id);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('approveProposal requires eval above threshold', () => {
    const proposal = selfMod.proposeChange('test-loop', { trigger: ['t1'] }, 'Test');
    selfMod.evaluateProposal(proposal.id);
    expect(() => selfMod.approveProposal(proposal.id)).not.toThrow();
  });

  it('approveProposal rejects if below threshold', () => {
    const proposal = selfMod.proposeChange('test-loop', { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9, j: 10, k: 11 }, 'Many changes');
    selfMod.evaluateProposal(proposal.id);
    expect(() => selfMod.approveProposal(proposal.id)).toThrow();
  });

  it('applyProposal requires approval', () => {
    const proposal = selfMod.proposeChange('test-loop', { trigger: ['t1'] }, 'Test');
    expect(() => selfMod.applyProposal(proposal.id)).toThrow();
  });

  it('full lifecycle: draft → evaluate → approve → apply', () => {
    const proposal = selfMod.proposeChange('lifecycle', { trigger: ['t1'] }, 'Test');
    selfMod.evaluateProposal(proposal.id);
    selfMod.approveProposal(proposal.id);
    selfMod.applyProposal(proposal.id);
    const updated = selfMod.getProposal(proposal.id);
    expect(updated!.status).toBe('applied');
  });

  it('rollbackProposal reverts applied', () => {
    const proposal = selfMod.proposeChange('rollback', { trigger: ['t1'] }, 'Test');
    selfMod.evaluateProposal(proposal.id);
    selfMod.approveProposal(proposal.id);
    selfMod.applyProposal(proposal.id);
    selfMod.rollbackProposal(proposal.id);
    const updated = selfMod.getProposal(proposal.id);
    expect(updated!.status).toBe('rolled_back');
  });

  it('getProposalHistory returns proposals', () => {
    selfMod.proposeChange('c1', { a: 1 }, 'Test 1');
    selfMod.proposeChange('c2', { b: 2 }, 'Test 2');
    const history = selfMod.getProposalHistory();
    expect(history.length).toBe(2);
  });

  it('getPendingProposals returns active', () => {
    selfMod.proposeChange('pending', { a: 1 }, 'Test');
    const pending = selfMod.getPendingProposals();
    expect(pending.length).toBeGreaterThanOrEqual(1);
  });

  it('cannot apply draft directly', () => {
    const proposal = selfMod.proposeChange('test', { a: 1 }, 'Test');
    expect(() => selfMod.applyProposal(proposal.id)).toThrow('Cannot apply proposal in status: draft');
  });
});
