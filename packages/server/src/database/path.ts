import { isAbsolute, join, resolve } from 'path';

export function monorepoRoot(cwd = process.cwd()): string {
  return cwd.includes('/packages/server') ? resolve(cwd, '../..') : cwd;
}

export function resolveDbPath(env = process.env, cwd = process.cwd()): string {
  const configured = env.DB_PATH || env.DJIMITFLO_DB;
  if (configured) {
    return isAbsolute(configured) ? configured : resolve(env.INIT_CWD || cwd, configured);
  }
  return join(monorepoRoot(cwd), '.data', 'djimitflo.sqlite');
}

export function resolveBackupDir(env = process.env, cwd = process.cwd()): string {
  if (env.BACKUP_DIR) {
    return isAbsolute(env.BACKUP_DIR) ? env.BACKUP_DIR : resolve(env.INIT_CWD || cwd, env.BACKUP_DIR);
  }
  return join(monorepoRoot(cwd), '.data', 'backups');
}
