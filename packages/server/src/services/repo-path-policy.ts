import { resolve, sep } from 'path';

/**
 * Repository path policy. Both repository scans and agent execution are
 * restricted to the directories listed in DJIMITFLO_ALLOWED_REPO_ROOTS
 * (comma-separated absolute paths). An empty list means "unrestricted".
 */

let cachedRoots: string[] | null = null;

function getAllowedRepoRoots(): string[] {
  if (cachedRoots) return cachedRoots;
  cachedRoots = (process.env.DJIMITFLO_ALLOWED_REPO_ROOTS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => resolve(entry));
  return cachedRoots;
}

let warnedAboutOpenPolicy = false;

/**
 * Resolves a repository path and verifies it falls within an allowed root.
 * When no roots are configured the path is allowed and a one-time warning is
 * logged. Throws a 403 error when the path is outside every configured root.
 */
export function resolveAllowedRepoPath(rawPath: string): string {
  const resolved = resolve(rawPath);
  const roots = getAllowedRepoRoots();

  if (roots.length === 0) {
    if (!warnedAboutOpenPolicy) {
      warnedAboutOpenPolicy = true;
      console.warn(
        'WARNING: DJIMITFLO_ALLOWED_REPO_ROOTS is not set. Repository scans and ' +
        'agent execution can target any directory on the host. Set it to restrict paths.',
      );
    }
    return resolved;
  }

  const allowed = roots.some((root) => resolved === root || resolved.startsWith(root + sep));
  if (!allowed) {
    const error = new Error(`Path is outside the allowed repository roots: ${resolved}`) as Error & {
      status?: number;
      code?: string;
    };
    error.status = 403;
    error.code = 'PATH_NOT_ALLOWED';
    throw error;
  }
  return resolved;
}
