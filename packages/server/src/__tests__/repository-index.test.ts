import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './helpers/test-db';
import SQLite, { type Database } from 'better-sqlite3';
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
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

  it('rejects deleting an unknown repository', () => {
    expect(() => service.deleteRepository('missing-repository')).toThrow('Repository not found: missing-repository');
  });

  it('gets stats', () => {
    const repo = service.registerRepository('test', '/tmp/test');
    const stats = service.getStats(repo.id);
    expect(stats.status).toBe('pending');
    expect(stats.files).toBe(0);
  });
});

describe('RepositoryIndexService durable file indexing', () => {
  let root: string;
  let repoPath: string;
  let db: Database;
  let service: RepositoryIndexService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'djimitflo-index-proof-'));
    repoPath = join(root, 'repository');
    mkdirSync(repoPath);
    db = new SQLite(join(root, 'index.sqlite'));
    db.pragma('foreign_keys = ON');
    service = new RepositoryIndexService(db);
  });

  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  function reopen() {
    db.close();
    db = new SQLite(join(root, 'index.sqlite'));
    db.pragma('foreign_keys = ON');
    service = new RepositoryIndexService(db);
  }

  it('keeps indexed text and metadata searchable after closing and reopening SQLite', async () => {
    writeFileSync(join(repoPath, 'fixture.ts'), `import 'fixture-library';\nexport function durableNeedle() {}\n${'// filler\n'.repeat(160)}`);
    const repo = service.registerRepository('fixture', repoPath);
    const stats = await service.indexRepository(repo.id);
    const query = { query: 'durableNeedle', repository_id: repo.id, language: 'typescript', search_type: 'keyword' as const };
    const before = service.search(query);
    expect(before.length).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM code_chunks').get()).toEqual({ n: stats.total_chunks });
    reopen();
    expect(service.search(query)).toEqual(before);
    expect(service.search({ ...query, language: 'python' })).toEqual([]);
  });

  it('replaces shrinking and deleted files without retaining stale chunks', async () => {
    writeFileSync(join(repoPath, 'changing.ts'), `${'// padding\n'.repeat(220)}\nconst obsoleteTail = 1;`);
    writeFileSync(join(repoPath, 'removed.ts'), 'const deletedNeedle = 1;');
    const repo = service.registerRepository('fixture', repoPath);
    await service.indexRepository(repo.id);
    expect(service.search({ query: 'obsoleteTail', search_type: 'keyword' }).length).toBeGreaterThan(0);
    writeFileSync(join(repoPath, 'changing.ts'), 'const replacementNeedle = 2;');
    unlinkSync(join(repoPath, 'removed.ts'));
    const stats = await service.indexRepository(repo.id);
    expect(stats).toMatchObject({ indexed_files: 1, total_chunks: 1, failed_files: 0 });
    expect(service.search({ query: 'deletedNeedle', search_type: 'keyword' })).toEqual([]);
    expect(service.search({ query: 'obsoleteTail', search_type: 'keyword' })).toEqual([]);
    reopen();
    expect(service.search({ query: 'replacementNeedle', search_type: 'keyword' })).toHaveLength(1);
    expect(db.prepare('SELECT file_path, chunk_index FROM code_chunks').all()).toEqual([{ file_path: 'changing.ts', chunk_index: 0 }]);
  });

  it('keeps repeated registration nondestructive and deletes children before the repository', async () => {
    writeFileSync(join(repoPath, 'fixture.ts'), 'const keepNeedle = 1;');
    const repo = service.registerRepository('fixture', repoPath);
    await service.indexRepository(repo.id);
    expect(service.registerRepository('renamed', repoPath)).toMatchObject({ id: repo.id, status: 'active', chunk_count: 1 });
    expect(service.search({ query: 'keepNeedle', search_type: 'keyword' })).toHaveLength(1);
    // Also support existing schemas with restrictive, rather than cascading, parent deletion.
    db.exec(`CREATE TRIGGER require_child_cleanup BEFORE DELETE ON repository_indexes
      WHEN EXISTS (SELECT 1 FROM code_chunks WHERE repository_id = OLD.id)
      BEGIN SELECT RAISE(ABORT, 'Delete chunks first'); END`);
    service.deleteRepository(repo.id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM code_chunks').get()).toEqual({ n: 0 });
    reopen();
    expect(service.getRepository(repo.id)).toBeNull();
    expect(service.search({ query: 'keepNeedle', search_type: 'keyword' })).toEqual([]);
  });

  it('rolls back chunk replacement on storage failure and can retry', async () => {
    writeFileSync(join(repoPath, 'fixture.ts'), 'const previousNeedle = 1;');
    const repo = service.registerRepository('fixture', repoPath);
    await service.indexRepository(repo.id);
    const previous = db.prepare('SELECT * FROM code_chunks').all();
    writeFileSync(join(repoPath, 'fixture.ts'), 'const nextNeedle = 2;');
    writeFileSync(join(repoPath, 'additional.ts'), 'const additionalNeedle = 3;');
    db.exec(`CREATE TRIGGER injected_chunk_failure BEFORE INSERT ON code_chunks
      BEGIN SELECT RAISE(ABORT, 'Injected chunk storage failure'); END`);
    await expect(service.indexRepository(repo.id)).rejects.toThrow('Injected chunk storage failure');
    expect(db.prepare('SELECT * FROM code_chunks').all()).toEqual(previous);
    expect(service.getStats(repo.id)).toMatchObject({ status: 'failed', files: 1, chunks: 1 });
    db.exec('DROP TRIGGER injected_chunk_failure');
    await service.indexRepository(repo.id);
    reopen();
    expect(service.search({ query: 'nextNeedle', search_type: 'keyword' })).toHaveLength(1);
    expect(service.search({ query: 'previousNeedle', search_type: 'keyword' })).toEqual([]);
  });

  it('does not certify or erase an unavailable repository as an empty index', async () => {
    writeFileSync(join(repoPath, 'fixture.ts'), 'const preservedNeedle = 1;');
    const repo = service.registerRepository('fixture', repoPath);
    await service.indexRepository(repo.id);
    const previous = db.prepare('SELECT * FROM code_chunks').all();
    rmSync(repoPath, { recursive: true });
    await expect(service.indexRepository(repo.id)).rejects.toThrow('Repository path unavailable');
    expect(db.prepare('SELECT * FROM code_chunks').all()).toEqual(previous);
    expect(service.getStats(repo.id).status).toBe('failed');
  });
});
