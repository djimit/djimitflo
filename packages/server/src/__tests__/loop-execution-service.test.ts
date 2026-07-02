import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { LoopExecutionService } from '../services/loop-execution-service';
import { AgentAssuranceService } from '../services/agent-assurance-service';
import { SkillService } from '../services/skill-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let execution: LoopExecutionService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  const assurance = new AgentAssuranceService(db);
  const skills = new SkillService(db);
  execution = new LoopExecutionService(db, assurance, skills);
});

afterEach(() => {
  db?.close();
});

describe('G109: LoopExecutionService', () => {
  it('gets run status', () => {
    const status = execution.getRunStatus('nonexistent');
    expect(status).toBe('unknown');
  });

  it('gets lease status', () => {
    const status = execution.getLeaseStatus('nonexistent');
    expect(status).toBe('unknown');
  });

  it('lists loop runs', () => {
    const runs = execution.listLoopRuns(10);
    expect(Array.isArray(runs)).toBe(true);
  });

  it('gets run metrics', () => {
    const metrics = execution.getRunMetrics('nonexistent');
    expect(metrics.totalLeases).toBe(0);
  });

  it('gets skill for run', () => {
    const skill = execution.getSkillForRun('nonexistent');
    expect(skill === null || typeof skill === 'string').toBe(true);
  });

  it('gets worker lease', () => {
    const lease = execution.getWorkerLease('nonexistent');
    expect(lease).toBeNull();
  });

  it('gets loop run', () => {
    const run = execution.getLoopRun('nonexistent');
    expect(run).toBeNull();
  });
});
