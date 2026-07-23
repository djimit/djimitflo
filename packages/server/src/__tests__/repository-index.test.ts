import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './helpers/test-db';
import type { Database } from 'better-sqlite3';
import { RepositoryIndexService } from '../services/repository-index-service';

describe('RepositoryIndexService', () => {
  let db: Database;
  let service: RepositoryIndexService;

  beforeEach(() => {
    db = createTestDb() as unknown as Database;
    service = new RepositoryIndexService(db);
  });

  afterEach(() => { db.close(); });

  it('registers a repository', () => {
    const repo = service.registerRepository('test-repo', '/tmp/test-repo');
    expect(repo.id).toBeDefined();
    expect(repo.name).toBe('test-repo');
    expect(repo.status).toBe('pending');
  });

  it('lists repositories', () => {
    service.registerRepository('repo-1', '/tmp/repo-1');
    service.registerRepository('repo-2', '/tmp/repo-2');
    expect(service.listRepositories()).toHaveLength(2);
  });

  it('gets a repository by ID', () => {
    const repo = service.registerRepository('test', '/tmp/test');
    const found = service.getRepository(repo.id);
    expect(found).not.toBeNull();
    expect(found!.name).toBe('test');
  });

  it('returns null for unknown repository', () => {
    expect(service.getRepository('nonexistent')).toBeNull();
  });

  it('searches indexed content', () => {
    const repo = service.registerRepository('test', '/tmp/test');
    // Without indexing, search should return empty
    const results = service.search({ query: 'test', repository_id: repo.id, search_type: 'hybrid' });
    expect(results).toEqual([]);
  });

  it('deletes a repository', () => {
    const repo = service.registerRepository('test', '/tmp/test');
    service.deleteRepository(repo.id);
    expect(service.getRepository(repo.id)).toBeNull();
  });

  it('gets stats', () => {
    const repo = service.registerRepository('test', '/tmp/test');
    const stats = service.getStats(repo.id);
    expect(stats.status).toBe('pending');
    expect(stats.files).toBe(0);
  });
});
