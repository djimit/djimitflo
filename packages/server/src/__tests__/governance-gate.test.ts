import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from 'better-sqlite3';
import { createTestDb } from './helpers/test-db';
import { GovernanceGateService } from '../services/governance-gate-service';

const GATE_ENV_KEYS = ['GOVERNANCE_GATE_ENABLED', 'GOVERNANCE_GATE_FLOOR', 'GOVERNANCE_GATE_MODEL_MAP'];

function insertRun(db: Database, run: {
  id: string;
  agentId: string;
  score: number;
  finishedAt: string;
  subjectModel?: string;
}) {
  db.prepare(`
    INSERT INTO openmythos_eval_runs (id, agent_id, status, total_cases, completed_cases, overall_score, started_at, finished_at, metadata)
    VALUES (?, ?, 'completed', 78, 78, ?, ?, ?, ?)
  `).run(run.id, run.agentId, run.score, run.finishedAt, run.finishedAt,
    JSON.stringify(run.subjectModel ? { subject_model: run.subjectModel } : {}));
}

describe('GovernanceGateService', () => {
  let db: Database;
  let gate: GovernanceGateService;
  const previousEnv = { ...process.env };

  beforeEach(() => {
    for (const key of GATE_ENV_KEYS) delete process.env[key];
    process.env.GOVERNANCE_GATE_ENABLED = 'true';
    db = createTestDb();
    gate = new GovernanceGateService(db);
  });

  afterEach(() => {
    db.close();
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
  });

  it('allows everything when disabled', () => {
    delete process.env.GOVERNANCE_GATE_ENABLED;
    insertRun(db, { id: 'r1', agentId: 'agent-a', score: 1.0, finishedAt: '2026-07-15T10:00:00Z' });

    const verdict = gate.assess({ agent_id: 'agent-a' }, 'mock');
    expect(verdict.action).toBe('allow');
    expect(verdict.reason).toContain('disabled');
  });

  it('allows when there is no governance evidence', () => {
    const verdict = gate.assess({ agent_id: 'agent-unknown' }, 'mock');
    expect(verdict.action).toBe('allow');
    expect(verdict.reason).toContain('No governance evidence');
  });

  it('allows when the latest score clears the floor', () => {
    insertRun(db, { id: 'r1', agentId: 'agent-a', score: 3.4, finishedAt: '2026-07-15T10:00:00Z' });

    const verdict = gate.assess({ agent_id: 'agent-a' }, 'mock');
    expect(verdict.action).toBe('allow');
    expect(verdict.score).toBe(3.4);
  });

  it('requires approval when the latest score is below the floor', () => {
    insertRun(db, { id: 'r1', agentId: 'agent-a', score: 2.1, finishedAt: '2026-07-15T10:00:00Z' });

    const verdict = gate.assess({ agent_id: 'agent-a' }, 'mock');
    expect(verdict.action).toBe('require_approval');
    expect(verdict.reason).toContain('2.10');
    expect(verdict.reason).toContain('approval required');
    expect(verdict.flagRetirement).toBe(false);
  });

  it('respects a configured floor', () => {
    process.env.GOVERNANCE_GATE_FLOOR = '2';
    insertRun(db, { id: 'r1', agentId: 'agent-a', score: 2.1, finishedAt: '2026-07-15T10:00:00Z' });

    expect(gate.assess({ agent_id: 'agent-a' }, 'mock').action).toBe('allow');
  });

  it('resolves evidence through the executor model map when the agent has none', () => {
    process.env.GOVERNANCE_GATE_MODEL_MAP = 'mock=weak-model,claude=claude-sonnet-4';
    insertRun(db, { id: 'r1', agentId: 'nightly:weak-model', score: 1.8, finishedAt: '2026-07-15T10:00:00Z' });

    const verdict = gate.assess({ agent_id: null }, 'mock');
    expect(verdict.action).toBe('require_approval');
    expect(verdict.agentKey).toBe('nightly:weak-model');
  });

  it('matches runs by metadata subject_model as a fallback', () => {
    process.env.GOVERNANCE_GATE_MODEL_MAP = 'mock=some-model';
    insertRun(db, { id: 'r1', agentId: 'apex-validation:some-model', score: 1.5, finishedAt: '2026-07-15T10:00:00Z', subjectModel: 'some-model' });

    const verdict = gate.assess({ agent_id: null }, 'mock');
    expect(verdict.action).toBe('require_approval');
  });

  it('flags a retirement candidate on three below-floor runs with a declining trend', () => {
    insertRun(db, { id: 'r1', agentId: 'agent-a', score: 2.8, finishedAt: '2026-07-13T10:00:00Z' });
    insertRun(db, { id: 'r2', agentId: 'agent-a', score: 2.4, finishedAt: '2026-07-14T10:00:00Z' });
    insertRun(db, { id: 'r3', agentId: 'agent-a', score: 2.0, finishedAt: '2026-07-15T10:00:00Z' });

    const verdict = gate.assess({ agent_id: 'agent-a' }, 'mock');
    expect(verdict.action).toBe('require_approval');
    expect(verdict.trend).toBe('declining');
    expect(verdict.flagRetirement).toBe(true);
    expect(verdict.reason).toContain('retirement candidate');
  });
});
