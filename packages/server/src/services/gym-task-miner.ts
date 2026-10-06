import { execFileSync } from 'node:child_process';
import { importedServices } from './test-gap-source-service';

/**
 * C2 evolution gym, step a: replay tasks mined from our own history (docs/design/evolution-gym.md).
 * A task is a commit that changed exactly one live service file (small) together with one or two test files. The gym
 * restores the parent version of the service in a sandbox worktree at that commit; a maker must make the commit's tests
 * pass again. The tests are the oracle, nothing is ever merged, so no human approval is needed per attempt.
 * Measured 2026-09-25: 151 candidates since June; 6/6 sampled were red on the parent and green on the commit.
 */
export interface GymTask { commit: string; source: string; tests: string[]; sourceLines: number }

const SERVICE = /^packages\/server\/src\/services\/([A-Za-z0-9_-]+)\.ts$/;
const TEST = /^packages\/server\/src\/__tests__\/[^/]+\.test\.ts$/;
// never replay changes to auth, secrets or deployment (same boundary as the evolve loop)
export const SENSITIVE_SERVICE = /(^|[-_])(auth|secrets?|deploy|token|credential|spawn|approval)([-_]|$)/i;
const SENSITIVE = SENSITIVE_SERVICE;

/** Parses `git log --numstat --format=@%H` output into per-commit file stats. */
export function parseNumstat(log: string): Array<{ commit: string; files: Array<{ path: string; lines: number }> }> {
  const commits: Array<{ commit: string; files: Array<{ path: string; lines: number }> }> = [];
  for (const line of log.split('\n')) {
    if (line.startsWith('@')) { commits.push({ commit: line.slice(1).trim(), files: [] }); continue; }
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (m && commits.length) commits[commits.length - 1].files.push({ path: m[3], lines: (Number(m[1]) || 0) + (Number(m[2]) || 0) });
  }
  return commits;
}

export function selectGymTasks(commits: ReturnType<typeof parseNumstat>, live: Set<string>, maxSourceLines = 80): GymTask[] {
  const tasks: GymTask[] = [];
  for (const c of commits) {
    const sources = c.files.filter((f) => SERVICE.test(f.path));
    const tests = c.files.filter((f) => TEST.test(f.path)).map((f) => f.path);
    if (sources.length !== 1 || tests.length < 1 || tests.length > 2) continue;
    const [src] = sources;
    const name = SERVICE.exec(src.path)![1];
    if (SENSITIVE.test(name) || !live.has(name) || src.lines > maxSourceLines || src.lines === 0) continue;
    tasks.push({ commit: c.commit, source: src.path, tests, sourceLines: src.lines });
  }
  return tasks;
}

export function mineGymTasks(repoPath: string, opts: { sinceDays?: number; maxSourceLines?: number } = {}): GymTask[] {
  const since = `${opts.sinceDays ?? 120}.days.ago`;
  const log = execFileSync('git', ['-C', repoPath, 'log', '--no-merges', `--since=${since}`, '--numstat', '--format=@%H', 'HEAD'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  // a commit that ADDED its source file has no parent version to restore (prod 2026-09-27: agent-liveness.ts in
  // 584cbadb failed 'git show <commit>^:<file>' on every attempt, and infra discards never mark a task tried)
  return selectGymTasks(parseNumstat(log), importedServices(repoPath), opts.maxSourceLines)
    .filter((t) => existsInParent(repoPath, t.commit, t.source));
}

function existsInParent(repoPath: string, commit: string, file: string): boolean {
  try { execFileSync('git', ['-C', repoPath, 'cat-file', '-e', `${commit}^:${file}`], { stdio: 'ignore' }); return true; } catch { return false; }
}
