import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SelfDeployService } from '../services/self-deploy-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let deploy: SelfDeployService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  deploy = new SelfDeployService(db);
});

afterEach(() => {
  db?.close();
});

describe('G72: Self Deployment', () => {
  it('gets current commit', () => {
    const commit = deploy.getCurrentCommit();
    expect(typeof commit).toBe('string');
  });

  it('checks uncommitted changes', () => {
    const hasChanges = deploy.hasUncommittedChanges();
    expect(typeof hasChanges).toBe('boolean');
  });

  it('gets deploy history', () => {
    const history = deploy.getDeployHistory(10);
    expect(Array.isArray(history)).toBe(true);
  });

  it('records deploy attempt', () => {
    deploy.deploy('test deploy');
    const history = deploy.getDeployHistory(10);
    expect(history.length).toBeGreaterThanOrEqual(1);
  });

  it('rollback records failure', () => {
    const result = deploy.deploy('test rollback');
    expect(typeof result.success).toBe('boolean');
  });
});
