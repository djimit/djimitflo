import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { ComplianceCheckingAgent } from '../services/compliance-checking-agent';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let compliance: ComplianceCheckingAgent;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  compliance = new ComplianceCheckingAgent(db);
});

afterEach(() => {
  db?.close();
});

describe('ComplianceCheckingAgent', () => {
  it('returns agent info', () => {
    const info = compliance.getAgentInfo();
    expect(info.id).toBe('compliance-checker');
    expect(info.capabilities).toContain('compliance-checking');
  });

  it('checks EU AI Act compliance', async () => {
    const result = await compliance.checkEUAIAct('djimflo');
    expect(result.framework).toBe('EU-AI-Act');
    expect(result.checks.length).toBeGreaterThan(0);
    expect(result.complianceScore).toBeGreaterThanOrEqual(0);
    expect(result.complianceScore).toBeLessThanOrEqual(100);
  });

  it('checks NORA compliance', async () => {
    const result = await compliance.checkNORA('djimflo');
    expect(result.framework).toBe('NORA');
    expect(result.checks.length).toBeGreaterThan(0);
  });

  it('checks GDPR compliance', async () => {
    const result = await compliance.checkGDPR('djimflo');
    expect(result.framework).toBe('GDPR');
    expect(result.checks.length).toBeGreaterThan(0);
  });

  it('calculates compliance score correctly', async () => {
    const result = await compliance.checkEUAIAct('test');
    expect(result.summary.passed + result.summary.failed + result.summary.warnings + result.summary.notApplicable).toBe(result.checks.length);
  });

  it('persists check history', async () => {
    await compliance.checkEUAIAct('test');
    await compliance.checkNORA('test');
    const history = compliance.getHistory(10);
    expect(history.length).toBe(2);
  });

  it('identifies warnings and failures', async () => {
    const result = await compliance.checkEUAIAct('test');
    const warnings = result.checks.filter(c => c.status === 'warning');
    expect(warnings.length).toBeGreaterThan(0);
  });
});
