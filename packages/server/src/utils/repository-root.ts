import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';

/** Resolve the monorepo root from any workspace cwd, falling back to start. */
export function resolveRepositoryRoot(start: string): string {
  const fallback = resolve(start);
  let current = fallback;
  while (true) {
    if (existsSync(join(current, 'package.json')) && existsSync(join(current, 'packages', 'server', 'src'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return fallback;
    current = parent;
  }
}
