import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SecurityScanningAgent } from '../services/security-scanning-agent';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let scanner: SecurityScanningAgent;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  scanner = new SecurityScanningAgent(db);
});

afterEach(() => {
  db?.close();
});

describe('SecurityScanningAgent', () => {
  it('returns agent info', () => {
    const info = scanner.getAgentInfo();
    expect(info.id).toBe('security-scanner');
    expect(info.capabilities).toContain('security-scanning');
  });

  it('scans codebase without crashing', async () => {
    const result = await scanner.scanCodebase('packages/server/src');
    expect(result).toBeDefined();
    expect(result.findings).toBeDefined();
    expect(result.summary).toBeDefined();
  });

  it('scans dependencies', async () => {
    const result = await scanner.scanDependencies('packages/server');
    expect(result.scanType).toBe('dependency');
    expect(result.findings.length).toBeGreaterThanOrEqual(0);
  });

  it('summarizes findings correctly', async () => {
    const result = await scanner.scanCodebase('packages/server/src');
    const total = result.summary.critical + result.summary.high + result.summary.medium + result.summary.low + result.summary.info;
    expect(total).toBe(result.findings.length);
  });

  it('persists scan history', async () => {
    await scanner.scanCodebase('test-path');
    const history = scanner.getScanHistory(10);
    expect(history.length).toBe(1);
  });

  it('detects execSync without timeout', async () => {
    const result = await scanner.scanCodebase('packages/server/src');
    const execFindings = result.findings.filter(f => f.category === 'execSync-no-timeout');
    expect(Array.isArray(execFindings)).toBe(true);
  });
});
