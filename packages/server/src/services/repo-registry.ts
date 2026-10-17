import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'better-sqlite3';

/**
 * Multi-repo oracle lanes (second-repo readiness 17-10). The loop was single-repo by construction: one checkout path, one
 * GITHUB_REPOSITORY. EXTRA_REPOS_ENABLED (off | shadow | on, default off) lets the test-gap lane work on other registered
 * repositories. The registry is GITHUB_REPOSITORY_PATHS (JSON {"owner/repo": "/abs/path"}, the map the PR-review webhook
 * already reads); every slug other than the primary repo (GITHUB_REPOSITORY, default djimit/djimitflo) is an extra repo.
 * A proposal for an extra repo carries the evidence ref `repo:<slug>`; its goal's run uses that repo's checkout and checks.
 * Off: no extra repo exists for any caller — djimitflo behaviour is unchanged. Shadow: discovery is recorded, nothing is created.
 */
export type ExtraReposMode = 'off' | 'shadow' | 'on';
export const extraReposMode = (env: NodeJS.ProcessEnv = process.env): ExtraReposMode => {
  const v = env.EXTRA_REPOS_ENABLED;
  return v === 'on' || v === 'true' ? 'on' : v === 'shadow' ? 'shadow' : 'off';
};

const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const primaryRepo = (env: NodeJS.ProcessEnv = process.env): string => env.GITHUB_REPOSITORY || 'djimit/djimitflo';
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** owner/repo and the PR number from a full GitHub PR URL; null for anything else (a number alone never identifies a PR). */
export function parsePrUrl(url: unknown): { slug: string; number: number } | null {
  const m = typeof url === 'string' ? /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)\/?$/.exec(url) : null;
  return m ? { slug: m[1], number: Number(m[2]) } : null;
}

/** owner/repo from a git remote URL (https or ssh form); null when the remote is not a GitHub repository. */
export function slugFromRemote(url: string): string | null {
  const m = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? m[1] : null;
}

export interface ExtraRepo { slug: string; path: string }
/** Extra repos that act (proposals, runs, PRs, metrics split): only with EXTRA_REPOS_ENABLED=on; empty otherwise. */
export const extraRepos = (env: NodeJS.ProcessEnv = process.env): ExtraRepo[] => (extraReposMode(env) === 'on' ? registeredExtraRepos(env) : []);

/** Every registered extra repo (absolute, existing directory), whatever the flag — shadow discovery reads these. */
export function registeredExtraRepos(env: NodeJS.ProcessEnv = process.env): ExtraRepo[] {
  let map: unknown;
  try { map = JSON.parse(env.GITHUB_REPOSITORY_PATHS || '{}'); } catch { return []; }
  if (!map || typeof map !== 'object' || Array.isArray(map)) return [];
  const primary = primaryRepo(env);
  return Object.entries(map as Record<string, unknown>)
    .filter((e): e is [string, string] => SLUG.test(e[0]) && !same(e[0], primary) && typeof e[1] === 'string' && path.isAbsolute(e[1]))
    .filter(([, p]) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } })
    .map(([slug, p]) => ({ slug, path: p }));
}

export const extraRepoBySlug = (slug: string | null | undefined, env: NodeJS.ProcessEnv = process.env): ExtraRepo | null =>
  (slug ? extraRepos(env).find((r) => same(r.slug, slug)) : undefined) ?? null;

/** The extra repo whose checkout is (or contains) this path; null for the primary repo or with the flag off. */
export function extraRepoByPath(repoPath: string | null | undefined, env: NodeJS.ProcessEnv = process.env): ExtraRepo | null {
  if (!repoPath) return null;
  const p = path.resolve(repoPath);
  return extraRepos(env).find((r) => { const root = path.resolve(r.path); return p === root || p.startsWith(root + path.sep); }) ?? null;
}

/** True for a PR the default (primary-repo) views must leave out: it belongs to a registered extra repo. */
export function isExtraRepoPr(url: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  const pr = parsePrUrl(url);
  return pr ? extraRepoBySlug(pr.slug, env) !== null : false;
}

/** `repo:<slug>` evidence ref of a proposal's refs (JSON text or array); null when it names no repo. */
export function repoRefOf(refs: unknown): string | null {
  let list: unknown = refs;
  if (typeof refs === 'string') { try { list = JSON.parse(refs); } catch { return null; } }
  if (!Array.isArray(list)) return null;
  const ref = list.find((r): r is string => typeof r === 'string' && /^repo:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r));
  return ref ? ref.slice('repo:'.length) : null;
}

/** The slug a goal's proposal names (`repo:<slug>`), or null — independent of the flag (B2 compares it with the worktree). */
export function goalRepoSlug(db: Database, goalId: string | null | undefined): string | null {
  if (!goalId) return null;
  try {
    const row = db.prepare('SELECT s.evidence_refs_json AS refs FROM goals g JOIN self_improvements s ON s.id = g.improvement_id WHERE g.id = ?').get(goalId) as { refs: string | null } | undefined;
    return repoRefOf(row?.refs ?? null);
  } catch { return null; }
}

/** The registered extra repo of a goal (flag on, ref present, checkout present); null = primary repo. */
export const goalExtraRepo = (db: Database, goalId: string | null | undefined, env: NodeJS.ProcessEnv = process.env): ExtraRepo | null =>
  extraRepoBySlug(goalRepoSlug(db, goalId), env);

/** EXTRA_REPO_CHECKS_<SLUG> (slug upper-cased, non-alphanumerics → '_'), comma list; default `test`. */
export function extraRepoChecks(slug: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const key = `EXTRA_REPO_CHECKS_${slug.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const list = (env[key] || '').split(',').map((s) => s.trim()).filter((s) => /^[\w:.-]{1,40}$/.test(s));
  return list.length ? list.slice(0, 8) : ['test'];
}

/** Skill-id prefix of an extra repo's outcomes: `repo:<slug>:` keeps them out of every `loop-maker:%` view; '' = primary. */
export const repoSkillPrefix = (repo: ExtraRepo | null): string => (repo ? `repo:${repo.slug}:` : '');

/** LOOP_AUTO_MERGE_REPOS (comma list); default the primary repo only. */
export function autoMergeRepos(env: NodeJS.ProcessEnv = process.env): string[] {
  const list = (env.LOOP_AUTO_MERGE_REPOS || '').split(',').map((s) => s.trim()).filter((s) => SLUG.test(s));
  return list.length ? list : [primaryRepo(env)];
}
export const autoMergeAllowed = (slug: string, env: NodeJS.ProcessEnv = process.env): boolean => autoMergeRepos(env).some((r) => same(r, slug));
