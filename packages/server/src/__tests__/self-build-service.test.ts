import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SelfBuildService } from '../services/self-build-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let build: SelfBuildService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  build = new SelfBuildService(db);
});

afterEach(() => {
  db?.close();
});

describe('G70: Self Build', () => {
  it('runs a build command', async () => {
    const result = await build.runBuild('echo "build output"');
    expect(result.success).toBe(true);
    expect(result.output).toContain('build output');
  });

  it('captures failed build', async () => {
    const result = await build.runBuild('false');
    expect(result.success).toBe(false);
  });

  it('parses errors from output', async () => {
    const result = await build.runBuild('echo "ERROR: something failed"');
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('parses warnings from output', async () => {
    const result = await build.runBuild('echo "WARN: deprecated"');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('records build history', async () => {
    await build.runBuild('echo "test"');
    const history = build.getBuildHistory(10);
    expect(history.length).toBe(1);
  });

  it('getLastError returns errors', async () => {
    await build.runBuild('echo "ERROR: fail" >&2 && false');
    const errors = build.getLastError();
    expect(Array.isArray(errors)).toBe(true);
  });

  it('measures duration', async () => {
    const result = await build.runBuild('echo "test"');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
