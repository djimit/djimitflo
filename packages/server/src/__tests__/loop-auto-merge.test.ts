import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import request from 'supertest';
import { UserRole } from '@djimitflo/shared';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { runAutoMergeTick } from '../services/loop-auto-merge';
import { autoMergeEvidence, isAuditSample, readClassState } from '../services/loop-auto-merge-state';
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
  if ((m = /^commits\/([^/]+)\/check-runs$/.exec(path))) {
    const s = checks.get(m[1]); if (!s) return res(200, { check_runs: [] });
    return res(200, { check_runs: [{ status: s === 'pending' ? 'in_progress' : 'completed', conclusion: s === 'red' ? 'failure' : s === 'green' ? 'success' : null }] });
  }
  if (/^commits\/[^/]+\/status$/.test(path)) return res(200, { state: 'pending', total_count: 0 });
  if (path === 'commits') return res(200, mainCommits);
  return res(404, {});
});
const writes = () => calls.filter((c) => c.method !== 'GET');

function seedPr(number: number, opts: { files?: string[]; proposal?: string; title?: string; login?: string; reviews?: FakePr['reviews']; removed?: boolean; lines?: number; draft?: boolean; behind?: boolean } = {}) {
  const id = `run-${number}`; const branch = `agent/loop/${id}`;
  db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status) VALUES (?, 'test', ?, 'd', 'r', 'test-gap', ?)`).run(`si-${number}`, `t${number}`, opts.proposal ?? 'verified');
  db.prepare("INSERT INTO goals (id, objective, risk_class, status, metadata, improvement_id, created_at, updated_at) VALUES (?, 'o', 'low', 'completed', '{}', ?, datetime('now'), datetime('now'))").run(`g-${number}`, `si-${number}`);
  db.prepare(`INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, gates_json, metadata, created_at, updated_at) VALUES (?, ?, 'test-gap', 'closed', 'completed', ?, ?, ?, ?)`)
    .run(id, `g-${number}`, JSON.stringify([{ name: 'diff_under_threshold', status: 'pass' }]), JSON.stringify({ pr_url: `https://github.com/o/r/pull/${number}` }), '2026-10-06T00:00:00Z', '2026-10-06T00:00:00Z');
  db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, branch_name, metadata, created_at, updated_at) VALUES (?, ?, 'maker', 'opencode', 'completed', ?, ?, ?, ?)`)
    .run(`m-${number}`, id, branch, JSON.stringify({ diff_max_lines: 400 }), '2026-10-06T00:00:00Z', '2026-10-06T00:00:00Z');
  const files = (opts.files ?? ['packages/server/src/__tests__/x.test.ts']).map((f) => ({ filename: f, status: opts.removed ? 'removed' : 'added', additions: opts.lines ?? 40, deletions: 0 }));
  prs.set(number, { number, state: 'open', draft: opts.draft ?? true, title: opts.title ?? `loop: add tests ${number}`, node_id: `PR_${number}`, mergeable: true,
    mergeable_state: opts.behind ? 'behind' : 'clean', user: { login: opts.login ?? 'djimitflo-bot' }, head: { sha: `sha${number}`, ref: branch, repo: { full_name: 'o/r' } },
    base: { ref: 'main' }, files, reviews: opts.reviews ?? [] });
  checks.set(`sha${number}`, 'green');
}
const decision = (number: number) => JSON.parse((db.prepare('SELECT metadata FROM loop_runs WHERE id = ?').get(`run-${number}`) as { metadata: string }).metadata).auto_merge;

beforeEach(() => {
  db = new Database(':memory:'); db.exec(schema); runMigrations(db);
  prs = new Map(); checks = new Map(); mainCommits = []; calls = []; fakeFetch.mockClear();
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

it('act: red checks make the PR ineligible and it is never merged', async () => {
  seedPr(700, { draft: false }); checks.set('sha700', 'red');
  await runAutoMergeTick(db, fakeFetch as unknown as typeof fetch, env('act'), NOW);
  expect(decision(700)).toMatchObject({ decision: 'ineligible', reason: 'checks_failed' });
  expect(writes()).toEqual([]);
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
  db.prepare("UPDATE loop_runs SET metadata = json_set(metadata, '$.pr_outcome', json(?)) WHERE id = 'run-700'").run(JSON.stringify({ state: 'merged', survived: false, settled_at: 'x' }));
  await runAutoMergeTick(db, fakeFetch as unknown as typeof fetch, env('act'), new Date(NOW.getTime() + 15 * 86_400_000));
  expect(readClassState(db).reason).toContain('merge survival');

  db.prepare("DELETE FROM system_state WHERE key = 'loop_auto_merge_test_only'").run();
  await mergeOne(702);
  checks.set('merge702', 'red');
  await runAutoMergeTick(db, fakeFetch as unknown as typeof fetch, env('act'), new Date(NOW.getTime() + 3_600_000));
  expect(readClassState(db)).toMatchObject({ state: 'revoked' });
  expect(readClassState(db).reason).toContain('checks failing on main at merge commit merge702');
});
