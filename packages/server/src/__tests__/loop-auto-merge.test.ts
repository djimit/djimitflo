import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import request from 'supertest';
import { UserRole } from '@djimitflo/shared';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { runAutoMergeTick } from '../services/loop-auto-merge';
import { autoMergeEvidence, isAuditSample, isTransientReason, PERMANENT_INELIGIBLE_REASONS, readClassState, revokeClass, TRANSIENT_INELIGIBLE_REASONS } from '../services/loop-auto-merge-state';
import { listDraftPrs } from '../services/loop-draft-pr-service';
import { buildDigest, setPushSender } from '../services/operator-push';
import { createAuthMiddleware } from '../middleware/auth';
import { AuthService } from '../services/auth-service';
import { createLoopRoutes } from '../routes/loops';
import { errorHandler } from '../middleware/error-handler';

/**
 * Earned auto-merge for verified test-only loop PRs. GitHub is a fake: a map of PRs that answers the REST/GraphQL calls
 * the tick makes and records every call, so "shadow never writes" and "act does ready → update → merge" are observable.
 */
interface FakePr {
  number: number; state: string; draft: boolean; title: string; node_id: string; mergeable: boolean | null; mergeable_state: string;
  user: { login: string }; head: { sha: string; ref: string; repo: { full_name: string } }; base: { ref: string };
  files: Array<{ filename: string; status: string; additions: number; deletions: number }>; reviews: Array<{ user: { login: string }; state: string }>;
}
let db: Database.Database;
let prs: Map<number, FakePr>; let checks: Map<string, 'green' | 'pending' | 'red'>; let mainCommits: Array<{ sha: string; commit: { message: string } }>;
let calls: Array<{ method: string; url: string; body?: unknown }>;
let commitsBySha: Map<string, { parents: Array<{ sha: string }>; committer: { login: string }; commit: { verification: { verified: boolean } } }>;
let commitStatus: Map<string, unknown>; let behindBy: Map<string, number>;
// branch protection's required contexts (null = unreadable) and explicit check runs per sha (override the `checks` shorthand)
let required: string[] | null; let runsBySha: Map<string, unknown[]>; let summaryRequired: string[] | null;
const NOW = new Date('2026-10-07T12:00:00Z');
const env = (mode: string, extra: Record<string, string> = {}) => ({ LOOP_AUTO_MERGE_TEST_ONLY: mode, GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 't0ken', ...extra }) as NodeJS.ProcessEnv;
const res = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body }) as Response;

const fakeFetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
  const method = init?.method ?? 'GET'; const body = init?.body ? JSON.parse(init.body) : undefined;
  calls.push({ method, url, body });
  if (url === 'https://api.github.com/graphql') {
    const pr = [...prs.values()].find((p) => p.node_id === body.variables.id); if (pr) pr.draft = false;
    return res(200, { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } });
  }
  const path = url.replace('https://api.github.com/repos/o/r/', '').split('?')[0];
  let m: RegExpExecArray | null;
  if ((m = /^pulls\/(\d+)$/.exec(path))) { const p = prs.get(Number(m[1])); return p ? res(200, p) : res(404, {}); }
  if ((m = /^pulls\/(\d+)\/files$/.exec(path))) return res(200, prs.get(Number(m[1]))?.files ?? []);
  if ((m = /^pulls\/(\d+)\/reviews$/.exec(path))) return res(200, prs.get(Number(m[1]))?.reviews ?? []);
  if ((m = /^pulls\/(\d+)\/update-branch$/.exec(path))) { prs.get(Number(m[1]))!.mergeable_state = 'clean'; return res(202, {}); }
  if ((m = /^pulls\/(\d+)\/merge$/.exec(path))) { const p = prs.get(Number(m[1]))!; p.state = 'closed'; return res(200, { sha: `merge${p.number}`, merged: true }); }
  if (path === 'branches/main/protection/required_status_checks') return required ? res(200, { contexts: required, checks: [] }) : res(404, {});
  if (path === 'branches/main') return summaryRequired ? res(200, { protection: { enabled: true, required_status_checks: { checks: summaryRequired.map((context) => ({ context })) } } }) : res(404, {});
  if ((m = /^commits\/([^/]+)\/check-runs$/.exec(path))) {
    const explicit = runsBySha.get(m[1]); if (explicit) return res(200, { check_runs: explicit });
    const s = checks.get(m[1]); if (!s) return res(200, { check_runs: [] });
    return res(200, { check_runs: [{ id: 1, name: 'build', status: s === 'pending' ? 'in_progress' : 'completed', conclusion: s === 'red' ? 'failure' : s === 'green' ? 'success' : null }] });
  }
  if ((m = /^commits\/([^/]+)\/status$/.exec(path))) return res(200, commitStatus.get(m[1]) ?? { state: 'pending', total_count: 0 });
  if ((m = /^commits\/([^/]+)$/.exec(path))) { const c = commitsBySha.get(m[1]); return c ? res(200, c) : res(404, {}); }
  if (path === 'commits') return res(200, mainCommits);
  if ((m = /^compare\/main\.\.\.(.+)$/.exec(path))) return res(200, { status: 'diverged', behind_by: behindBy.get(m[1]) ?? 0 });
  return res(404, {});
});
const writes = () => calls.filter((c) => c.method !== 'GET');

function seedPr(number: number, opts: { files?: string[]; proposal?: string; title?: string; login?: string; reviews?: FakePr['reviews']; removed?: boolean; lines?: number; draft?: boolean; behind?: boolean; strength?: 'pass' | 'fail' | 'skipped' | 'none'; verified?: string | null } = {}) {
  const id = `run-${number}`; const branch = `agent/loop/${id}`;
  db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status) VALUES (?, 'test', ?, 'd', 'r', 'test-gap', ?)`).run(`si-${number}`, `t${number}`, opts.proposal ?? 'verified');
  db.prepare("INSERT INTO goals (id, objective, risk_class, status, metadata, improvement_id, created_at, updated_at) VALUES (?, 'o', 'low', 'completed', '{}', ?, datetime('now'), datetime('now'))").run(`g-${number}`, `si-${number}`);
  db.prepare(`INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, gates_json, metadata, created_at, updated_at) VALUES (?, ?, 'test-gap', 'closed', 'completed', ?, ?, ?, ?)`)
    .run(id, `g-${number}`, JSON.stringify([{ name: 'diff_under_threshold', status: 'pass' }]), JSON.stringify({ pr_url: `https://github.com/o/r/pull/${number}`, ...(opts.verified === null ? {} : { verified_head_sha: opts.verified ?? `sha${number}` }) }), '2026-10-06T00:00:00Z', '2026-10-06T00:00:00Z');
  db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, branch_name, metadata, created_at, updated_at) VALUES (?, ?, 'maker', 'opencode', 'completed', ?, ?, ?, ?)`)
    .run(`m-${number}`, id, branch, JSON.stringify({ diff_max_lines: 400,
      // the prod shadow record: status 'skipped' by design, the measured verdict in shadow_status
      ...(opts.strength === 'none' ? {} : { deterministic_checks: [{ name: 'test:assertion-strength', mode: 'shadow', status: 'skipped', shadow_status: opts.strength ?? 'pass', exit_status: null }] }) }),
      '2026-10-06T00:00:00Z', '2026-10-06T00:00:00Z');
  const files = (opts.files ?? ['packages/server/src/__tests__/x.test.ts']).map((f) => ({ filename: f, status: opts.removed ? 'removed' : 'added', additions: opts.lines ?? 40, deletions: 0 }));
  prs.set(number, { number, state: 'open', draft: opts.draft ?? true, title: opts.title ?? `loop: add tests ${number}`, node_id: `PR_${number}`, mergeable: true,
    mergeable_state: opts.behind ? 'behind' : 'clean', user: { login: opts.login ?? 'djimitflo-bot' }, head: { sha: `sha${number}`, ref: branch, repo: { full_name: 'o/r' } },
    base: { ref: 'main' }, files, reviews: opts.reviews ?? [] });
  checks.set(`sha${number}`, 'green');
}
const decision = (number: number) => JSON.parse((db.prepare('SELECT metadata FROM loop_runs WHERE id = ?').get(`run-${number}`) as { metadata: string }).metadata).auto_merge;

beforeEach(() => {
  db = new Database(':memory:'); db.exec(schema); runMigrations(db);
  prs = new Map(); checks = new Map(); mainCommits = []; commitsBySha = new Map(); calls = []; commitStatus = new Map(); behindBy = new Map(); fakeFetch.mockClear();
  required = ['build']; runsBySha = new Map(); summaryRequired = null;
});
afterEach(() => { setPushSender(null); db.close(); });

it('off by default: no GitHub call, no decision', async () => {
  seedPr(700);
  expect(await runAutoMergeTick(db, fakeFetch as unknown as typeof fetch, env(''), NOW)).toEqual({ evaluated: 0, merged: 0, revoked: false });
  expect(await runAutoMergeTick(db, fakeFetch as unknown as typeof fetch, env('yes'), NOW)).toMatchObject({ evaluated: 0 });
  expect(calls).toEqual([]);
  expect(decision(700)).toBeUndefined();
});

it('eligibility: only verified, test-only, in-limit, unreviewed loop PRs; never Dependabot or non-loop PRs', async () => {
  seedPr(700); // eligible
  seedPr(702, { files: ['packages/server/src/__tests__/a.test.ts', 'packages/server/src/services/a.ts'] });
  seedPr(703, { proposal: 'regressed' });
  seedPr(704, { login: 'dependabot[bot]', title: 'loop: bump x' });
  seedPr(705, { title: 'feat: human PR' });
  seedPr(707, { reviews: [{ user: { login: 'dennis' }, state: 'CHANGES_REQUESTED' }] });
  seedPr(710, { lines: 401 });
  seedPr(711, { removed: true });
  await runAutoMergeTick(db, fakeFetch as unknown as typeof fetch, env('shadow'), NOW);
  expect(decision(700)).toMatchObject({ decision: 'would_merge', mode: 'shadow' });
  expect(decision(702)).toMatchObject({ decision: 'ineligible', reason: 'non_test_file: packages/server/src/services/a.ts' });
  expect(decision(703).reason).toMatch(/^not_verified/);
  expect(decision(704).reason).toMatch(/^not_loop_pr/);
  expect(decision(705).reason).toMatch(/^not_loop_pr/);
  expect(decision(707)).toMatchObject({ decision: 'ineligible', reason: 'changes_requested' });
  expect(decision(710)).toMatchObject({ decision: 'ineligible', reason: 'diff_over_limit: 401 > 400' });
  expect(decision(711).reason).toMatch(/^removes_test/);
  // a later approval by the same reviewer clears the changes request
  seedPr(713, { reviews: [{ user: { login: 'dennis' }, state: 'CHANGES_REQUESTED' }, { user: { login: 'dennis' }, state: 'APPROVED' }] });
  await runAutoMergeTick(db, fakeFetch as unknown as typeof fetch, env('shadow'), NOW);
  expect(decision(713).decision).toBe('would_merge');
});

it('sampling: a deterministic 10 % stays for the human, flagged in /decisions and the digest', async () => {
  expect([701, 706, 708].map(isAuditSample)).toEqual([true, true, true]);
  expect([700, 702, 703].map(isAuditSample)).toEqual([false, false, false]);
  let n = 0; for (let i = 1; i <= 10_000; i++) if (isAuditSample(i)) n++;
  expect(n).toBeGreaterThan(900); expect(n).toBeLessThan(1100);
  seedPr(701);
  await runAutoMergeTick(db, fakeFetch as unknown as typeof fetch, env('act'), NOW);
  expect(decision(701)).toMatchObject({ decision: 'audit_sample' });
  expect(writes()).toEqual([]); // not marked ready, not merged
  expect(listDraftPrs(db, 50, NOW.getTime()).rows[0]).toMatchObject({ pr_number: 701, auto_merge: 'audit_sample' });
  expect(buildDigest(db, NOW.getTime(), env('act')).text).toContain('1 audit sample(s) waiting for you');
  expect(db.prepare("SELECT COUNT(*) AS n FROM loop_events WHERE event_type = 'auto_merge_audit_sample'").get()).toEqual({ n: 1 });
});

it('shadow records what it would do and writes nothing to GitHub', async () => {
  seedPr(700, { behind: true });
  await runAutoMergeTick(db, fakeFetch as unknown as typeof fetch, env('shadow'), NOW);
  expect(decision(700)).toMatchObject({ decision: 'would_merge', steps: ['mark_ready', 'update_branch', 'squash_merge'] });
  expect(writes()).toEqual([]);
  await runAutoMergeTick(db, fakeFetch as unknown as typeof fetch, env('shadow'), NOW);
  expect(db.prepare("SELECT COUNT(*) AS n FROM loop_events WHERE event_type = 'auto_merge_would_merge'").get()).toEqual({ n: 1 }); // once per PR
  expect(autoMergeEvidence(db, env('shadow'), NOW.getTime()).counts).toMatchObject({ would_merge: 1, merged: 0 });
});

it('act: ready → update branch → wait for checks → squash-merge, with a loop event, an audit row and a push line', async () => {
  const sent: string[] = [];
  setPushSender({ requestApproval: async () => {}, broadcastAlert: async (t) => { sent.push(t); } });
  seedPr(700, { behind: true });
  const tick = () => runAutoMergeTick(db, fakeFetch as unknown as typeof fetch, env('act', { TELEGRAM_PUSH_ENABLED: 'true' }), NOW);
  await tick();
  expect(decision(700)).toMatchObject({ decision: 'waiting', reason: 'marked_ready' });
  expect(writes().map((c) => c.url)).toEqual(['https://api.github.com/graphql']);
  await tick();
  expect(decision(700)).toMatchObject({ decision: 'waiting', reason: 'branch_updated' });
  expect(writes()[1]).toMatchObject({ method: 'PUT', url: 'https://api.github.com/repos/o/r/pulls/700/update-branch', body: { expected_head_sha: 'sha700' } });
  checks.set('sha700', 'pending');
  await tick();
  expect(decision(700)).toMatchObject({ decision: 'waiting', reason: 'checks_pending' });
  expect(writes()).toHaveLength(2);
  checks.set('sha700', 'green');
  expect(await tick()).toMatchObject({ merged: 1 });
  expect(writes()[2]).toMatchObject({ method: 'PUT', url: 'https://api.github.com/repos/o/r/pulls/700/merge', body: { merge_method: 'squash', sha: 'sha700' } });
  expect(decision(700)).toMatchObject({ decision: 'merged', merge_commit_sha: 'merge700' });
  expect(db.prepare("SELECT COUNT(*) AS n FROM loop_events WHERE event_type = 'auto_merged'").get()).toEqual({ n: 1 });
  expect(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'loop_pr_auto_merged'").get()).toEqual({ n: 1 });
  expect(sent).toEqual(['Auto-merged test-only loop PR #700: https://github.com/o/r/pull/700']);
  await tick();
  expect(writes()).toHaveLength(3); // merged is final
});

it('P0-5: the PR-review heuristic status (djimitflo-review) never makes a PR green; an independent check does', async () => {
  seedPr(700, { draft: false }); checks.delete('sha700'); // no check runs: only the heuristic reported
  required = ['ci/test']; // the required context is a commit status here
  commitStatus.set('sha700', { state: 'success', total_count: 1, statuses: [{ context: 'djimitflo-review', state: 'success' }] });
  await runAutoMergeTick(db, fakeFetch as unknown as typeof fetch, env('act'), NOW);
  expect(decision(700)).toMatchObject({ decision: 'waiting', reason: 'checks_pending' });
  expect(writes()).toEqual([]);
  commitStatus.set('sha700', { state: 'success', total_count: 2, statuses: [{ context: 'djimitflo-review', state: 'success' }, { context: 'ci/test', state: 'success' }] });
  await runAutoMergeTick(db, fakeFetch as unknown as typeof fetch, env('act'), NOW);
  expect(decision(700)).toMatchObject({ decision: 'merged' });
});

it('act: red checks make the PR ineligible and it is never merged', async () => {
  seedPr(700, { draft: false }); checks.set('sha700', 'red');
  await runAutoMergeTick(db, fakeFetch as unknown as typeof fetch, env('act'), NOW);
  expect(decision(700)).toMatchObject({ decision: 'ineligible', reason: 'checks_failed' });
  expect(writes()).toEqual([]);
});

// No false green (10-26): a required context is green only on success of its newest run on the exact head; unreadable
// branch protection is 'waiting', never a merge.
const run = (id: number, name: string, conclusion: string | null, status = 'completed') => ({ id, name, status, conclusion, completed_at: conclusion ? `2026-10-07T0${id}:00:00Z` : null });
for (const c of ['skipped', 'neutral']) {
  it(`act: a required check with ${c} is not green — ineligible checks_failed with required_not_success, never merged`, async () => {
    seedPr(700, { draft: false }); required = ['build', 'sbom'];
    runsBySha.set('sha700', [run(1, 'build', 'success'), run(2, 'sbom', c)]);
    await runAutoMergeTick(db, fakeFetch as unknown as typeof fetch, env('act'), NOW);
    expect(decision(700)).toMatchObject({ decision: 'ineligible', reason: `checks_failed: required_not_success:sbom=${c}` });
    expect(isTransientReason(decision(700).reason)).toBe(true);
    expect(writes()).toEqual([]);
  });
}

it('act: a newer red run next to an older green run of the same name is red; a newer green rerun of a red run is green', async () => {
  seedPr(700, { draft: false });
  runsBySha.set('sha700', [run(1, 'build', 'success'), run(2, 'build', 'failure')]);
  await runAutoMergeTick(db, fakeFetch as unknown as typeof fetch, env('act'), NOW);
  expect(decision(700)).toMatchObject({ decision: 'ineligible', reason: 'checks_failed' });
  seedPr(702, { draft: false });
  runsBySha.set('sha702', [run(1, 'build', 'failure'), run(2, 'build', 'success')]);
  await runAutoMergeTick(db, fakeFetch as unknown as typeof fetch, env('act'), NOW);
  expect(decision(702)).toMatchObject({ decision: 'merged' });
  seedPr(703, { draft: false }); // a newer skipped run hides nothing: not green
  runsBySha.set('sha703', [run(1, 'build', 'success'), run(2, 'build', 'skipped')]);
  await runAutoMergeTick(db, fakeFetch as unknown as typeof fetch, env('act'), NOW);
  expect(decision(703)).toMatchObject({ decision: 'ineligible', reason: 'checks_failed: required_not_success:build=skipped' });
  expect(writes().filter((c) => c.url.endsWith('/merge')).map((c) => c.url)).toEqual(['https://api.github.com/repos/o/r/pulls/702/merge']);
});

it('act: a required check still running or not reported is waiting checks_pending', async () => {
  seedPr(700, { draft: false }); required = ['build', 'sbom'];
  runsBySha.set('sha700', [run(1, 'build', 'success'), run(2, 'sbom', null, 'in_progress')]);
  await runAutoMergeTick(db, fakeFetch as unknown as typeof fetch, env('act'), NOW);
  expect(decision(700)).toMatchObject({ decision: 'waiting', reason: 'checks_pending' });
  runsBySha.set('sha700', [run(1, 'build', 'success')]); // sbom missing
  await runAutoMergeTick(db, fakeFetch as unknown as typeof fetch, env('act'), NOW);
  expect(decision(700)).toMatchObject({ decision: 'waiting', reason: 'checks_pending' });
  expect(writes()).toEqual([]);
});

it('act: unreadable branch protection is waiting required_checks_unavailable, never a merge', async () => {
  seedPr(700, { draft: false }); required = null;
  await runAutoMergeTick(db, fakeFetch as unknown as typeof fetch, env('act'), NOW);
  expect(decision(700)).toMatchObject({ decision: 'waiting', reason: 'required_checks_unavailable' });
  expect(writes()).toEqual([]);
  seedPr(702); // shadow does not claim would_merge either
  await runAutoMergeTick(db, fakeFetch as unknown as typeof fetch, env('shadow'), NOW);
  expect(decision(702)).toMatchObject({ decision: 'waiting', reason: 'required_checks_unavailable' });
  summaryRequired = ['build', 'sbom']; // the branch summary (read access) is the same live source; sbom not reported yet
  await runAutoMergeTick(db, fakeFetch as unknown as typeof fetch, env('act'), NOW);
  expect(decision(700)).toMatchObject({ decision: 'waiting', reason: 'checks_pending' });
  summaryRequired = null; required = ['build']; // readable again: merges on the next tick
  await runAutoMergeTick(db, fakeFetch as unknown as typeof fetch, env('act'), NOW);
  expect(decision(700)).toMatchObject({ decision: 'merged' });
});

it('act: a non-required skipped or neutral check is still fine', async () => {
  seedPr(700, { draft: false });
  runsBySha.set('sha700', [run(1, 'build', 'success'), run(2, 'docs', 'skipped'), run(3, 'optional', 'neutral')]);
  await runAutoMergeTick(db, fakeFetch as unknown as typeof fetch, env('act'), NOW);
  expect(decision(700)).toMatchObject({ decision: 'merged' });
});

it('cap: LOOP_AUTO_MERGE_MAX_PER_DAY bounds merges in a rolling 24 h', async () => {
  seedPr(700, { draft: false }); seedPr(702, { draft: false }); seedPr(703, { draft: false });
  const r = await runAutoMergeTick(db, fakeFetch as unknown as typeof fetch, env('act', { LOOP_AUTO_MERGE_MAX_PER_DAY: '2' }), NOW);
  expect(r.merged).toBe(2);
  expect(decision(703)).toMatchObject({ decision: 'capped' });
  expect(writes().filter((c) => c.url.endsWith('/merge'))).toHaveLength(2);
  // 25 h later the window has room again
  await runAutoMergeTick(db, fakeFetch as unknown as typeof fetch, env('act', { LOOP_AUTO_MERGE_MAX_PER_DAY: '2' }), new Date(NOW.getTime() + 25 * 3_600_000));
  expect(decision(703).decision).toBe('merged');
  // default cap is 10; 0 means never
  seedPr(704, { draft: false });
  await runAutoMergeTick(db, fakeFetch as unknown as typeof fetch, env('act', { LOOP_AUTO_MERGE_MAX_PER_DAY: '0' }), new Date(NOW.getTime() + 50 * 3_600_000));
  expect(decision(704).decision).toBe('capped');
});

async function mergeOne(number: number) {
  seedPr(number, { draft: false });
  await runAutoMergeTick(db, fakeFetch as unknown as typeof fetch, env('act'), NOW);
  expect(decision(number).decision).toBe('merged');
}

it('revocation: a revert on main revokes the class; it holds every later PR until an operator re-enables it (audited, manage:config)', async () => {
  const sent: string[] = [];
  setPushSender({ requestApproval: async () => {}, broadcastAlert: async (t) => { sent.push(t); } });
  await mergeOne(700);
  mainCommits = [{ sha: 'merge700', commit: { message: 'loop: add tests 700 (#700)' } }, { sha: 'rev1', commit: { message: 'Revert "loop: add tests 700 (#700)"\n\nThis reverts commit merge700.' } }];
  seedPr(702, { draft: false });
  const later = new Date(NOW.getTime() + 3_600_000);
  const r = await runAutoMergeTick(db, fakeFetch as unknown as typeof fetch, env('act', { TELEGRAM_PUSH_ENABLED: 'true' }), later);
  expect(r).toMatchObject({ revoked: true, merged: 0 });
  expect(readClassState(db)).toMatchObject({ state: 'revoked', pr_url: 'https://github.com/o/r/pull/700' });
  expect(readClassState(db).reason).toContain('reverted on main by rev1');
  expect(decision(702)).toMatchObject({ decision: 'revoked_hold' });
  expect(writes().filter((c) => c.url.endsWith('/merge'))).toHaveLength(1);
  expect(sent.some((t) => t.includes('REVOKED'))).toBe(true);
  expect(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'loop_auto_merge_revoked'").get()).toEqual({ n: 1 });
  expect(autoMergeEvidence(db, env('act'), later.getTime()).class.state).toBe('revoked');

  // re-enable: authenticated, manage:config, reason required, audited
  const authService = new AuthService(db);
  const viewer = authService.generateToken(authService.createUser('viewer@example.test', 'disposable-password', UserRole.VIEWER));
  const admin = authService.generateToken(authService.createUser('admin@example.test', 'disposable-password', UserRole.ADMIN));
  const auth = createAuthMiddleware(authService);
  const app = express().use(express.json()).use(rateLimit({ windowMs: 60_000, limit: 600 })).use('/api/loops', auth.requireAuth, createLoopRoutes(db, auth)).use(errorHandler);
  expect((await request(app).post('/api/loops/auto-merge/re-enable').send({ reason: 'reviewed the revert' })).status).toBe(401);
  expect((await request(app).post('/api/loops/auto-merge/re-enable').set('Authorization', `Bearer ${viewer}`).send({ reason: 'reviewed the revert' })).status).toBe(403);
  expect((await request(app).post('/api/loops/auto-merge/re-enable').set('Authorization', `Bearer ${admin}`).send({})).status).toBe(400);
  expect((await request(app).get('/api/loops/auto-merge').set('Authorization', `Bearer ${viewer}`)).body.class.state).toBe('revoked');
  const ok = await request(app).post('/api/loops/auto-merge/re-enable').set('Authorization', `Bearer ${admin}`).send({ reason: 'reviewed the revert: flaky env, not the test' });
  expect(ok.status).toBe(200);
  expect(ok.body.class).toMatchObject({ state: 'active', re_enable_reason: 'reviewed the revert: flaky env, not the test' });
  expect(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'loop_auto_merge_re_enabled'").get()).toEqual({ n: 1 });
  expect((await request(app).post('/api/loops/auto-merge/re-enable').set('Authorization', `Bearer ${admin}`).send({ reason: 'again please' })).status).toBe(409);

  // the same revert does not revoke again; the held PR is merged on the next tick
  await runAutoMergeTick(db, fakeFetch as unknown as typeof fetch, env('act'), new Date(later.getTime() + 60_000));
  expect(readClassState(db).state).toBe('active');
  expect(decision(702).decision).toBe('merged');
});

it('revocation: merge survival marking the lines removed, or red checks on the merge commit, also revoke', async () => {
  await mergeOne(700);
  db.prepare("UPDATE loop_runs SET metadata = json_set(metadata, '$.pr_outcome', json(?)) WHERE id = 'run-700'")
    .run(JSON.stringify({ state: 'merged', merged_at: NOW.toISOString(), survived: false, settled_at: new Date(NOW.getTime() + 14 * 86_400_000 + 3_600_000).toISOString() }));
  await runAutoMergeTick(db, fakeFetch as unknown as typeof fetch, env('act'), new Date(NOW.getTime() + 15 * 86_400_000));
  expect(readClassState(db).reason).toContain('merge survival');

  db.prepare("DELETE FROM system_state WHERE key = 'loop_auto_merge_test_only'").run();
  await mergeOne(702);
  checks.set('merge702', 'red');
  await runAutoMergeTick(db, fakeFetch as unknown as typeof fetch, env('act'), new Date(NOW.getTime() + 3_600_000));
  expect(readClassState(db)).toMatchObject({ state: 'revoked' });
  expect(readClassState(db).reason).toContain('checks failing on main at merge commit merge702');
});

it('E1: an anomalous or pending survival outcome is neither a removal (no revocation) nor a settlement (window stays open)', async () => {
  await mergeOne(700);
  const setOutcome = (o: object) => db.prepare("UPDATE loop_runs SET metadata = json_set(metadata, '$.pr_outcome', json(?)) WHERE id = 'run-700'").run(JSON.stringify(o));
  // survived false + settled_at, but no merged_at: PIPELINE_ANOMALY — main revoked the class on it
  setOutcome({ state: 'merged', survived: false, settled_at: new Date(NOW.getTime() + 14 * 86_400_000).toISOString() });
  await runAutoMergeTick(db, fakeFetch as unknown as typeof fetch, env('act'), new Date(NOW.getTime() + 15 * 86_400_000));
  expect(readClassState(db).state).not.toBe('revoked');
  expect(decision(700).window_closed).toBeUndefined(); // an anomaly does not close the 14-day window; the 30-day fallback does
  await runAutoMergeTick(db, fakeFetch as unknown as typeof fetch, env('act'), new Date(NOW.getTime() + 31 * 86_400_000));
  expect(decision(700).window_closed).toBe(true);
  expect(readClassState(db).state).not.toBe('revoked');
});

it('B14: shadow re-checks would_merge each tick — a PR that goes conflicting flips to ineligible, an unchanged one keeps its record', async () => {
  seedPr(700); seedPr(702);
  await runAutoMergeTick(db, fakeFetch as unknown as typeof fetch, env('shadow'), NOW);
  expect(decision(700).decision).toBe('would_merge');
  const first = decision(702).at;
  prs.get(700)!.mergeable = false; prs.get(700)!.mergeable_state = 'dirty';
  const later = new Date(NOW.getTime() + 15 * 60_000);
  await runAutoMergeTick(db, fakeFetch as unknown as typeof fetch, env('shadow'), later);
  expect(decision(700)).toMatchObject({ decision: 'ineligible', reason: 'merge_conflict' });
  expect(decision(702)).toMatchObject({ decision: 'would_merge', at: first }); // unchanged: not rewritten
  expect(db.prepare("SELECT COUNT(*) AS n FROM loop_events WHERE event_type = 'auto_merge_would_merge'").get()).toEqual({ n: 2 });
  expect(writes()).toEqual([]);
});

it('B14: re-checking a would_merge PR does not count it against its own daily cap', async () => {
  seedPr(700);
  const capped = env('shadow', { LOOP_AUTO_MERGE_MAX_PER_DAY: '1' });
  await runAutoMergeTick(db, fakeFetch as unknown as typeof fetch, capped, NOW);
  await runAutoMergeTick(db, fakeFetch as unknown as typeof fetch, capped, new Date(NOW.getTime() + 15 * 60_000));
  expect(decision(700).decision).toBe('would_merge');
});

it('B14: assertion strength must have passed (the shadow verdict counts); skipped, failed or missing is ineligible', async () => {
  seedPr(700); seedPr(702, { strength: 'fail' }); seedPr(703, { strength: 'skipped' }); seedPr(704, { strength: 'none' });
  // eligible needs a verified proposal; 703/704 proposals are verified too — only the check differs
  await runAutoMergeTick(db, fakeFetch as unknown as typeof fetch, env('shadow'), NOW);
  expect(decision(700).decision).toBe('would_merge');
  expect(decision(702)).toMatchObject({ decision: 'ineligible', reason: 'assertion_strength_fail' });
  expect(decision(703)).toMatchObject({ decision: 'ineligible', reason: 'assertion_strength_skipped' });
  expect(decision(704)).toMatchObject({ decision: 'ineligible', reason: 'assertion_strength_missing' });
});

it('P0-6: merges only the verified head — a moved head, or a run without a recorded verified head, is never merged', async () => {
  seedPr(700, { draft: false, verified: 'sha-verified' }); // head sha700 ≠ the verified commit: someone pushed after verification
  seedPr(702, { draft: false, verified: null }); // legacy run: no verified head recorded
  seedPr(703, { draft: false }); // head = verified
  for (const mode of ['shadow', 'act']) {
    await runAutoMergeTick(db, fakeFetch as unknown as typeof fetch, env(mode), NOW);
    expect(decision(700)).toMatchObject({ decision: 'ineligible', reason: 'head_moved' });
    expect(decision(702)).toMatchObject({ decision: 'ineligible', reason: 'no_verified_head' });
  }
  const merges = writes().filter((c) => c.url.endsWith('/merge'));
  expect(merges).toEqual([{ method: 'PUT', url: 'https://api.github.com/repos/o/r/pulls/703/merge', body: expect.objectContaining({ sha: 'sha703' }) }]);
});

it('P0-6: a GitHub update-branch merge on top of the verified head is accepted; a hand-pushed merge is head_moved', async () => {
  seedPr(700, { draft: false, verified: 'v700' }); // head sha700 = web-flow merge of main into v700
  commitsBySha.set('sha700', { parents: [{ sha: 'v700' }, { sha: 'main1' }], committer: { login: 'web-flow' }, commit: { verification: { verified: true } } });
  seedPr(702, { draft: false, verified: 'v702' }); // head sha702 = unsigned merge pushed by someone else
  commitsBySha.set('sha702', { parents: [{ sha: 'v702' }, { sha: 'main1' }], committer: { login: 'mallory' }, commit: { verification: { verified: false } } });
  await runAutoMergeTick(db, fakeFetch as unknown as typeof fetch, env('act'), NOW);
  expect(decision(700).decision).toBe('merged');
  expect(decision(702)).toMatchObject({ decision: 'ineligible', reason: 'head_moved' });
  expect(writes().filter((c) => c.url.endsWith('/merge')).map((c) => (c.body as { sha: string }).sha)).toEqual(['sha700']);
});

// ── LOOP_AUTO_MERGE_RECHECK: transient ineligible decisions are re-evaluated (26-10: 20 open PRs stuck on checks_failed) ──
const H = 3_600_000;
const at = (h: number) => new Date(NOW.getTime() + h * H);
const recheckEnv = (extra: Record<string, string> = {}) => env('act', { LOOP_AUTO_MERGE_RECHECK: 'on', ...extra });
const tickAt = (h: number, e: NodeJS.ProcessEnv = recheckEnv()) => runAutoMergeTick(db, fakeFetch as unknown as typeof fetch, e, at(h));
const prCalls = (n: number) => calls.filter((c) => c.url.includes(`/pulls/${n}`) || c.url.includes(`sha${n}`));
const metaOf = (n: number) => (db.prepare('SELECT metadata FROM loop_runs WHERE id = ?').get(`run-${n}`) as { metadata: string }).metadata;

it('recheck: one explicit split — every reason is permanent or transient, never both; unknown codes are permanent', () => {
  expect([...TRANSIENT_INELIGIBLE_REASONS]).toEqual(['checks_failed', 'head_moved', 'not_verified', 'files_unavailable', 'reviews_unavailable', 'github_unavailable', 'assertion_strength_missing']);
  expect([...PERMANENT_INELIGIBLE_REASONS]).toEqual(['non_test_file', 'removes_test', 'diff_over_limit', 'changes_requested', 'not_loop_pr', 'repo_not_allowed',
    'assertion_strength_fail', 'assertion_strength_skipped', 'not_open', 'no_verified_head', 'merge_conflict']);
  expect(PERMANENT_INELIGIBLE_REASONS.filter((r) => (TRANSIENT_INELIGIBLE_REASONS as readonly string[]).includes(r))).toEqual([]);
  expect(isTransientReason('not_verified: run completed, proposal regressed')).toBe(true);
  expect(isTransientReason('checks_failed')).toBe(true);
  expect(isTransientReason('non_test_file: a.ts')).toBe(false);
  expect(isTransientReason('assertion_strength_fail')).toBe(false);
  expect(isTransientReason('something_new')).toBe(false);
  expect(isTransientReason(null)).toBe(false);
});

it('recheck off (default, or any value but on): an ineligible decision stays final — byte-identical metadata, no GitHub call', async () => {
  seedPr(700, { draft: false }); checks.set('sha700', 'red');
  await runAutoMergeTick(db, fakeFetch as unknown as typeof fetch, env('act'), NOW);
  expect(decision(700)).toMatchObject({ decision: 'ineligible', reason: 'checks_failed' });
  const before = metaOf(700);
  checks.set('sha700', 'green'); calls = [];
  for (const e of [env('act'), env('act', { LOOP_AUTO_MERGE_RECHECK: 'off' }), env('act', { LOOP_AUTO_MERGE_RECHECK: 'yes' })]) {
    expect(await runAutoMergeTick(db, fakeFetch as unknown as typeof fetch, e, at(30))).toMatchObject({ evaluated: 0, merged: 0 });
  }
  expect(prCalls(700)).toEqual([]);
  expect(metaOf(700)).toBe(before);
  expect(decision(700).rechecked_at).toBeUndefined();
});

it('recheck: a transient checks_failed PR is re-evaluated after the window and merges once checks are green and every gate passes', async () => {
  seedPr(700, { draft: false }); checks.set('sha700', 'red');
  await tickAt(0);
  expect(decision(700)).toMatchObject({ decision: 'ineligible', reason: 'checks_failed' });
  checks.set('sha700', 'green'); calls = [];
  // inside the window (default 6 h): not re-checked
  expect(await tickAt(5)).toMatchObject({ evaluated: 0, merged: 0 });
  expect(prCalls(700)).toEqual([]);
  expect(await tickAt(7)).toMatchObject({ merged: 1 });
  expect(writes().filter((c) => c.url.endsWith('/merge'))).toEqual([{ method: 'PUT', url: 'https://api.github.com/repos/o/r/pulls/700/merge', body: expect.objectContaining({ sha: 'sha700' }) }]);
  expect(decision(700)).toMatchObject({ decision: 'merged', rechecked_at: at(7).toISOString(), rechecks: 1 });
  const ev = autoMergeEvidence(db, recheckEnv(), at(8).getTime()).recheck;
  expect(ev).toMatchObject({ enabled: true, window_hours: 6, per_tick: 5, rechecked_24h: 1, rechecked_24h_by_decision: { merged: 1 } });
  expect(autoMergeEvidence(db, recheckEnv(), at(32).getTime()).recheck.rechecked_24h).toBe(0);
});

it('recheck: LOOP_AUTO_MERGE_RECHECK_HOURS sets the window; a still-red PR is not re-checked again inside it', async () => {
  const e = recheckEnv({ LOOP_AUTO_MERGE_RECHECK_HOURS: '2' });
  seedPr(700, { draft: false }); checks.set('sha700', 'red');
  await tickAt(0, e);
  await tickAt(3, e); // re-checked: still red, not behind
  expect(decision(700)).toMatchObject({ decision: 'ineligible', reason: 'checks_failed', at: NOW.toISOString(), rechecks: 1, rechecked_at: at(3).toISOString() });
  calls = [];
  await tickAt(4, e); // 1 h after the re-check: inside the window
  expect(prCalls(700)).toEqual([]);
  await tickAt(5.5, e);
  expect(decision(700)).toMatchObject({ rechecks: 2 });
  expect(writes()).toEqual([]); // red, not behind: nothing to do on GitHub
  const ev = autoMergeEvidence(db, e, at(6).getTime()).recheck;
  expect(ev).toMatchObject({ window_hours: 2, ineligible_by_class: { permanent: 0, transient: 1 }, by_decision_reason: { ineligible: { checks_failed: 1 } }, rechecked_24h: 1 });
});

it('recheck: a BEHIND red PR gets update-branch, then waits as rechecking_after_update and is never merged on a pending or red check', async () => {
  for (const n of [700, 702]) { seedPr(n); prs.get(n)!.mergeable_state = 'draft'; checks.set(`sha${n}`, 'red'); behindBy.set(`sha${n}`, 3); }
  await tickAt(0); // first decision: not a re-check, so no update
  expect([decision(700).reason, decision(702).reason]).toEqual(['checks_failed', 'checks_failed']);
  expect(writes()).toEqual([]);
  await tickAt(7);
  expect(decision(700)).toMatchObject({ decision: 'waiting', reason: 'rechecking_after_update', steps: ['update_branch'] });
  expect(writes()).toEqual([700, 702].map((n) => ({ method: 'PUT', url: `https://api.github.com/repos/o/r/pulls/${n}/update-branch`, body: { expected_head_sha: `sha${n}` } })));
  // GitHub's update-branch: a web-flow merge of main on top of the old head; CI reruns on it
  for (const n of [700, 702]) {
    prs.get(n)!.head.sha = `upd${n}`; checks.set(`upd${n}`, 'pending');
    commitsBySha.set(`upd${n}`, { parents: [{ sha: `sha${n}` }, { sha: 'main1' }], committer: { login: 'web-flow' }, commit: { verification: { verified: true } } });
  }
  await tickAt(7.25);
  expect(decision(700)).toMatchObject({ decision: 'waiting', reason: 'rechecking_after_update' });
  expect(writes()).toHaveLength(2); // pending: not marked ready, not merged
  checks.set('upd700', 'green'); checks.set('upd702', 'red');
  await tickAt(7.5);
  expect(decision(700)).toMatchObject({ decision: 'waiting', reason: 'marked_ready' });
  expect(decision(702)).toMatchObject({ decision: 'ineligible', reason: 'checks_failed' });
  expect(await tickAt(7.75)).toMatchObject({ merged: 1 });
  expect(writes().filter((c) => c.url.endsWith('/merge'))).toEqual([{ method: 'PUT', url: 'https://api.github.com/repos/o/r/pulls/700/merge', body: expect.objectContaining({ sha: 'upd700' }) }]);
  expect(decision(700)).toMatchObject({ decision: 'merged', rechecks: 1 });
  expect(decision(702).decision).toBe('ineligible');
});

it('recheck: shadow re-evaluates but never updates a branch', async () => {
  seedPr(700); checks.set('sha700', 'red'); behindBy.set('sha700', 3);
  const shadow = env('shadow', { LOOP_AUTO_MERGE_RECHECK: 'on' });
  await tickAt(0, shadow); await tickAt(7, shadow);
  expect(decision(700)).toMatchObject({ decision: 'ineligible', reason: 'checks_failed', rechecks: 1 });
  checks.set('sha700', 'green');
  await tickAt(14, shadow);
  expect(decision(700)).toMatchObject({ decision: 'would_merge', rechecks: 2 });
  expect(writes()).toEqual([]);
});

it('recheck: permanent reasons and the audit sample are never re-checked', async () => {
  seedPr(701, { draft: false }); // audit sample
  seedPr(702, { draft: false, files: ['packages/server/src/__tests__/a.test.ts', 'packages/server/src/services/a.ts'] });
  seedPr(707, { draft: false, reviews: [{ user: { login: 'dennis' }, state: 'CHANGES_REQUESTED' }] });
  seedPr(710, { draft: false, lines: 401 });
  seedPr(711, { draft: false, removed: true });
  seedPr(717, { draft: false, strength: 'fail' });
  seedPr(713, { draft: false, title: 'feat: human PR' });
  seedPr(714, { draft: false, verified: null });
  seedPr(715, { draft: false }); prs.get(715)!.mergeable = false; prs.get(715)!.mergeable_state = 'dirty';
  seedPr(718, { draft: false }); prs.get(718)!.state = 'closed';
  const all = [701, 702, 707, 710, 711, 717, 713, 714, 715, 718];
  expect(all.filter(isAuditSample)).toEqual([701]);
  await tickAt(0);
  const reasons = [702, 707, 710, 711, 717, 713, 714, 715, 718].map((n) => decision(n).reason.split(':')[0]);
  expect(reasons).toEqual(['non_test_file', 'changes_requested', 'diff_over_limit', 'removes_test', 'assertion_strength_fail', 'not_loop_pr', 'no_verified_head', 'merge_conflict', 'not_open']);
  expect(decision(701).decision).toBe('audit_sample');
  const before = all.map(metaOf);
  calls = [];
  expect(await tickAt(48)).toMatchObject({ evaluated: 0 });
  expect(calls).toEqual([]);
  expect(all.map(metaOf)).toEqual(before);
  const ev = autoMergeEvidence(db, recheckEnv(), at(48).getTime()).recheck;
  expect(ev.ineligible_by_class).toEqual({ permanent: 9, transient: 0 });
  expect(ev.by_decision_reason.audit_sample).toEqual({ 'deterministic 10 % sample': 1 });
  expect(ev.by_decision_reason.ineligible).toMatchObject({ non_test_file: 1, merge_conflict: 1, not_open: 1 });
  expect(ev.rechecked_24h).toBe(0);
});

it('recheck: at most 5 per tick, oldest first; the rest follow on the next tick', async () => {
  const nums = Array.from({ length: 40 }, (_, i) => 720 + i).filter((n) => !isAuditSample(n)).slice(0, 7);
  for (const n of nums) { seedPr(n, { draft: false }); checks.set(`sha${n}`, 'red'); }
  await tickAt(0);
  expect(nums.map((n) => decision(n).reason)).toEqual(nums.map(() => 'checks_failed'));
  for (const n of nums) checks.set(`sha${n}`, 'green');
  const e = recheckEnv({ LOOP_AUTO_MERGE_MAX_PER_DAY: '100' });
  expect(await tickAt(7, e)).toMatchObject({ evaluated: 5, merged: 5 });
  expect(nums.map((n) => decision(n).decision)).toEqual(['merged', 'merged', 'merged', 'merged', 'merged', 'ineligible', 'ineligible']);
  expect(await tickAt(7.25, e)).toMatchObject({ evaluated: 2, merged: 2 });
  const ev = autoMergeEvidence(db, e, at(8).getTime()).recheck;
  expect(ev).toMatchObject({ rechecked_24h: 7, rechecked_24h_by_decision: { merged: 7 }, ineligible_by_class: { permanent: 0, transient: 0 } });
});

it('recheck: the daily cap and the revoke-hold still apply to a re-checked PR', async () => {
  for (const n of [700, 702, 703]) { seedPr(n, { draft: false }); checks.set(`sha${n}`, 'red'); }
  await tickAt(0);
  for (const n of [700, 702, 703]) checks.set(`sha${n}`, 'green');
  revokeClass(db, 'PR #1: reverted on main', 'https://github.com/o/r/pull/1', at(1));
  await tickAt(7, recheckEnv({ LOOP_AUTO_MERGE_MAX_PER_DAY: '1' }));
  expect([700, 702, 703].map((n) => decision(n).decision)).toEqual(['revoked_hold', 'revoked_hold', 'revoked_hold']);
  expect(writes()).toEqual([]);
  db.prepare("DELETE FROM system_state WHERE key = 'loop_auto_merge_test_only'").run();
  expect(await tickAt(7.25, recheckEnv({ LOOP_AUTO_MERGE_MAX_PER_DAY: '1' }))).toMatchObject({ merged: 1 });
  expect([700, 702, 703].map((n) => decision(n).decision)).toEqual(['merged', 'capped', 'capped']);
  expect(writes().filter((c) => c.url.endsWith('/merge'))).toHaveLength(1);
});

it('recheck: assertion_strength_missing stays ineligible until the maker lease carries a pass verdict', async () => {
  seedPr(704, { draft: false, strength: 'none' });
  await tickAt(0);
  expect(decision(704)).toMatchObject({ decision: 'ineligible', reason: 'assertion_strength_missing' });
  await tickAt(7);
  expect(decision(704)).toMatchObject({ decision: 'ineligible', reason: 'assertion_strength_missing', rechecks: 1 });
  db.prepare("UPDATE worker_leases SET metadata = json_set(metadata, '$.deterministic_checks', json(?)) WHERE id = 'm-704'")
    .run(JSON.stringify([{ name: 'test:assertion-strength', mode: 'shadow', status: 'skipped', shadow_status: 'pass' }]));
  expect(await tickAt(14)).toMatchObject({ merged: 1 });
});
