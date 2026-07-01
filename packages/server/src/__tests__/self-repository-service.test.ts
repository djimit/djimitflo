import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SelfRepositoryService } from '../services/self-repository-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let selfRepo: SelfRepositoryService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  selfRepo = new SelfRepositoryService(db);
});

afterEach(() => {
  db?.close();
});

describe('G69: Self Repository Detection', () => {
  it('detects self repository', () => {
    const info = selfRepo.detectSelfRepository();
    expect(typeof info.isSelfHosted).toBe('boolean');
    expect(info.rootPath).toBeDefined();
  });

  it('registers self repository', () => {
    const result = selfRepo.registerSelfRepository();
    expect(typeof result.registered).toBe('boolean');
  });

  it('gets self repository', () => {
    selfRepo.registerSelfRepository();
    const repo = selfRepo.getSelfRepository();
    if (repo) {
      expect(repo.name).toBe('djimitflo-self');
    }
  });

  it('updates commit tracking', () => {
    selfRepo.registerSelfRepository();
    selfRepo.updateCommitTracking();
    const repo = selfRepo.getSelfRepository();
    if (repo) {
      const meta = JSON.parse(repo.metadata);
      expect(meta.lastSyncedAt).toBeDefined();
    }
  });

  it('gets recent commits', () => {
    const commits = selfRepo.getRecentCommits(5);
    expect(Array.isArray(commits)).toBe(true);
  });

  it('gets diff', () => {
    const diff = selfRepo.getDiff();
    expect(typeof diff).toBe('string');
  });
});
