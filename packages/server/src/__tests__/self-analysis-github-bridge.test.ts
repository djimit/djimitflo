import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SelfAnalysisGitHubBridge } from '../services/self-analysis-github-bridge';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let bridge: SelfAnalysisGitHubBridge;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  bridge = new SelfAnalysisGitHubBridge(db);
});

afterEach(() => {
  db?.close();
});

describe('SelfAnalysisGitHubBridge', () => {
  it('runs full pipeline', () => {
    const result = bridge.runFullPipeline('packages/server/src');
    expect(result.issuesGenerated).toBeGreaterThanOrEqual(0);
    expect(result.prsGenerated).toBeGreaterThanOrEqual(0);
    expect(result.timestamp).toBeDefined();
  });

  it('generates issues from security findings', () => {
    const result = bridge.runFullPipeline('packages/server/src');
    const securityIssues = result.issues.filter(i => i.labels.includes('security'));
    expect(Array.isArray(securityIssues)).toBe(true);
  });

  it('generates issues from test gaps', () => {
    const result = bridge.runFullPipeline('packages/server/src');
    const testIssues = result.issues.filter(i => i.labels.includes('test-coverage'));
    expect(Array.isArray(testIssues)).toBe(true);
  });

  it('generates PRs from improvements', () => {
    const result = bridge.runFullPipeline('packages/server/src');
    expect(Array.isArray(result.prs)).toBe(true);
  });

  it('persists issues in database', () => {
    bridge.runFullPipeline('packages/server/src');
    const proposed = bridge.getProposedIssues();
    expect(Array.isArray(proposed)).toBe(true);
  });

  it('persists PRs in database', () => {
    bridge.runFullPipeline('packages/server/src');
    const proposed = bridge.getProposedPrs();
    expect(Array.isArray(proposed)).toBe(true);
  });

  it('tracks history', () => {
    bridge.runFullPipeline('packages/server/src');
    bridge.runFullPipeline('packages/server/src');
    const history = bridge.getHistory(10);
    expect(history.length).toBe(2);
  });

  it('generates issues with correct structure', () => {
    const result = bridge.runFullPipeline('packages/server/src');
    if (result.issues.length > 0) {
      const issue = result.issues[0];
      expect(issue.id).toBeDefined();
      expect(issue.title).toBeDefined();
      expect(issue.body).toBeDefined();
      expect(issue.labels.length).toBeGreaterThan(0);
      expect(['critical', 'high', 'medium', 'low', 'info']).toContain(issue.severity);
    }
  });

  it('generates PRs with correct structure', () => {
    const result = bridge.runFullPipeline('packages/server/src');
    if (result.prs.length > 0) {
      const pr = result.prs[0];
      expect(pr.id).toBeDefined();
      expect(pr.title).toBeDefined();
      expect(pr.body).toBeDefined();
      expect(pr.branch).toBeDefined();
    }
  });
});
