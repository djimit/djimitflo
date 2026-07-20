import { describe, expect, it } from 'vitest';
import { resolve } from 'path';
import { monorepoRoot, resolveBackupDir, resolveDbPath } from '../database/path';

describe('database path resolution', () => {
  it('resolves relative DB_PATH from INIT_CWD when npm workspace changes cwd', () => {
    expect(resolveDbPath(
      { DB_PATH: './.data/djimitflo.sqlite', INIT_CWD: '/repo' },
      '/repo/packages/server'
    )).toBe(resolve('/repo/.data/djimitflo.sqlite'));
  });

  it('falls back to DJIMITFLO_DB and package-aware default paths', () => {
    expect(resolveDbPath({ DJIMITFLO_DB: './db.sqlite', INIT_CWD: '/repo' }, '/repo/packages/server'))
      .toBe(resolve('/repo/db.sqlite'));
    expect(monorepoRoot('/repo/packages/server')).toBe('/repo');
    expect(resolveDbPath({}, '/repo/packages/server')).toBe('/repo/.data/djimitflo.sqlite');
    expect(resolveBackupDir({}, '/repo/packages/server')).toBe('/repo/.data/backups');
  });
});
