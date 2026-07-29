import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import Database from 'better-sqlite3';
import { createDatabase, databaseProvenance, monorepoRoot, requireLiveMode, resolveDatabasePath } from '../db.js';

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe('MCP database path resolution', () => {
  it('resolves relative env paths from INIT_CWD', () => {
    expect(resolveDatabasePath(undefined, { DJIMITFLO_DB: './.data/djimitflo.sqlite', INIT_CWD: '/repo' }, '/repo/packages/mcp-server'))
      .toBe(resolve('/repo/.data/djimitflo.sqlite'));
    expect(resolveDatabasePath(undefined, { DB_PATH: './db.sqlite', INIT_CWD: '/repo' }, '/repo/packages/mcp-server'))
      .toBe(resolve('/repo/db.sqlite'));
  });

  it('prefers the monorepo .data database from package cwd', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'djimitflo-mcp-db-'));
    const packageDir = join(tempDir, 'packages', 'mcp-server');
    const dataDir = join(tempDir, '.data');
    mkdirSync(packageDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    new Database(join(dataDir, 'djimitflo.sqlite')).close();

    expect(monorepoRoot(packageDir)).toBe(tempDir);
    expect(resolveDatabasePath(undefined, {}, packageDir)).toBe(join(dataDir, 'djimitflo.sqlite'));
  });

  it('opens relative explicit paths from INIT_CWD', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'djimitflo-mcp-db-'));
    const dbDir = join(tempDir, '.data');
    mkdirSync(dbDir, { recursive: true });
    new Database(join(dbDir, 'djimitflo.sqlite')).close();

    const previousInitCwd = process.env.INIT_CWD;
    process.env.INIT_CWD = tempDir;
    try {
      const db = createDatabase('./.data/djimitflo.sqlite');
      expect(db.path).toBe(join(dbDir, 'djimitflo.sqlite'));
      expect(db.mode).toBe('snapshot');
      db.close();
    } finally {
      if (previousInitCwd === undefined) delete process.env.INIT_CWD;
      else process.env.INIT_CWD = previousInitCwd;
    }
  });

  it('requires a persistent database identity for live mutations', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
    const handle = { db, path: ':memory:', mode: 'live' as const, close: () => db.close() };

    expect(() => requireLiveMode(handle)).toThrow('DJIMITFLO_DATABASE_ID_REQUIRED');
    db.prepare('INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, datetime(\'now\'))')
      .run('database_instance_id', 'test-instance');
    expect(() => requireLiveMode(handle)).not.toThrow();
    expect(databaseProvenance(handle).instance_id).toBe('test-instance');
    handle.close();
  });
});
