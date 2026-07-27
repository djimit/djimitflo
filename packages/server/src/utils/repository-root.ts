import { existsSync } from 'fs';
import { resolve } from 'path';

export function resolveRepositoryRoot(cwd = process.cwd()): string {
  const candidates = [resolve(cwd), resolve(cwd, '../..')];
  return candidates.find((candidate) =>
    existsSync(resolve(candidate, 'packages/server/src'))
  ) || resolve(cwd);
}
