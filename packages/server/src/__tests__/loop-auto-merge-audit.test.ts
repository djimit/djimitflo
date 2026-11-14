import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { runAutoMergeTick, type AuditKillExecutor } from '../services/loop-auto-merge';
import { EVOLUTION_FLAGS } from '../services/evolution-evidence';
import { RUNBOOK_DEFAULTS } from '../services/config-defaults.generated';
import { AUDIT_JUDGMENT, AUDIT_SAMPLE_REASON, auditSampleAutoMode, executedAuditVerdict, isAuditSample, isAuditSpotCheck } from '../services/loop-auto-merge-state';
import { openLoopPrSplit } from '../services/needs-you-classes';
import { setPushSender } from '../services/operator-push';

/**
 * AUDIT_SAMPLE_AUTO_MODE (operator 2026-11-13): the 10 % audit sample of eligible test-only loop PRs is judged by an executed,
 * independent audit (fresh-mutant kill share, assertion strength, required checks) instead of the human; only failures,
 * unknowns and a 1-in-5 spot check of the passes stay for the human. GitHub is a fake that records every call.
 */
interface FakePr {
  number: number; state: string; draft: boolean; title: string; node_id: string; mergeable: boolean | null; mergeable_state: string;
  user: { login: string }; head: { sha: string; ref: string; repo: { full_name: string } }; base: { ref: string };
  files: Array<{ filename: string; status: string; additions: number; deletions: number }>; reviews: unknown[];
}
let db: Database.Database;
let prs: Map<number, FakePr>; let checks: Map<string, 'green' | 'pending' | 'red'>;
let calls: Array<{ method: string; url: string }>;
const NOW = new Date('2026-10-07T12:00:00Z');
const H = 3_600_000;
const env = (audit: string | undefined, mode = 'act') => ({ LOOP_AUTO_MERGE_TEST_ONLY: mode, GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 't0ken', ...(audit === undefined ? {} : { AUDIT_SAMPLE_AUTO_MODE: audit }) }) as NodeJS.ProcessEnv;
const res = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body }) as Response;
const fakeFetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
  const method = init?.method ?? 'GET'; const body = init?.body ? JSON.parse(init.body) : undefined;
  calls.push({ method, url });
  if (url === 'https://api.github.com/graphql') {
    const pr = [...prs.values()].find((p) => p.node_id === body.variables.id); if (pr) pr.draft = false;
    return res(200, { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } });
  }
  const path = url.replace('https://api.github.com/repos/o/r/', '').split('?')[0];
  let m: RegExpExecArray | null;
  if ((m = /^pulls\/(\d+)$/.exec(path))) { const p = prs.get(Number(m[1])); return p ? res(200, p) : res(404, {}); }
  if ((m = /^pulls\/(\d+)\/files$/.exec(path))) return res(200, prs.get(Number(m[1]))?.files ?? []);
  if ((m = /^pulls\/(\d+)\/reviews$/.exec(path))) return res(200, prs.get(Number(m[1]))?.reviews ?? []);
  if ((m = /^pulls\/(\d+)\/update-branch$/.exec(path))) return res(202, {});
  if ((m = /^pulls\/(\d+)\/merge$/.exec(path))) { const p = prs.get(Number(m[1]))!; p.state = 'closed'; return res(200, { sha: `merge${p.number}`, merged: true }); }
  if (path === 'branches/main/protection/required_status_checks') return res(200, { contexts: ['build'], checks: [] });
  if ((m = /^commits\/([^/]+)\/check-runs$/.exec(path))) {
    const s = checks.get(m[1]); if (!s) return res(200, { check_runs: [] });
    return res(200, { check_runs: [{ id: 1, name: 'build', status: s === 'pending' ? 'in_progress' : 'completed', conclusion: s === 'red' ? 'failure' : s === 'green' ? 'success' : null }] });
  }
  if ((m = /^commits\/([^/]+)\/status$/.exec(path))) return res(200, { state: 'pending', total_count: 0 });
  if (path === 'commits') return res(200, []);
  return res(404, {});
});
const writes = () => calls.filter((c) => c.method !== 'GET');

function seedPr(number: number, opts: { strength?: 'pass' | 'fail'; draft?: boolean; graded?: Record<string, unknown> } = {}) {
  const id = `run-${number}`; const branch = `agent/loop/${id}`;
  db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, evidence_refs_json, grounding_json) VALUES (?, 'test', ?, 'd', 'r', 'test-gap', 'verified', ?, ?)`)
    .run(`si-${number}`, `t${number}`, JSON.stringify([`test-gap:x${number}#exports`]), JSON.stringify({ target: `packages/server/src/services/x${number}.ts` }));
  db.prepare("INSERT INTO goals (id, objective, risk_class, status, metadata, improvement_id, created_at, updated_at) VALUES (?, 'o', 'low', 'completed', '{}', ?, datetime('now'), datetime('now'))").run(`g-${number}`, `si-${number}`);
  db.prepare(`INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, gates_json, metadata, created_at, updated_at) VALUES (?, ?, 'test-gap', 'closed', 'completed', ?, ?, ?, ?)`)
    .run(id, `g-${number}`, JSON.stringify([{ name: 'diff_under_threshold', status: 'pass' }]), JSON.stringify({ pr_url: `https://github.com/o/r/pull/${number}`, verified_head_sha: `sha${number}` }), '2026-10-06T00:00:00Z', '2026-10-06T00:00:00Z');
  db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, branch_name, metadata, created_at, updated_at) VALUES (?, ?, 'maker', 'opencode', 'completed', ?, ?, ?, ?)`)
    .run(`m-${number}`, id, branch, JSON.stringify({ diff_max_lines: 400, ...(opts.graded ? { graded: opts.graded } : {}),
      deterministic_checks: [{ name: 'test:assertion-strength', mode: 'shadow', status: 'skipped', shadow_status: opts.strength ?? 'pass', exit_status: null }] }), '2026-10-06T00:00:00Z', '2026-10-06T00:00:00Z');
  prs.set(number, { number, state: 'open', draft: opts.draft ?? false, title: `loop: add tests ${number}`, node_id: `PR_${number}`, mergeable: true, mergeable_state: 'clean',
    user: { login: 'djimitflo-bot' }, head: { sha: `sha${number}`, ref: branch, repo: { full_name: 'o/r' } }, base: { ref: 'main' },
    files: [{ filename: `packages/server/src/__tests__/x${number}.exports.test.ts`, status: 'added', additions: 40, deletions: 0 }], reviews: [] });
  checks.set(`sha${number}`, 'green');
}
const record = (number: number) => JSON.parse((db.prepare('SELECT metadata FROM loop_runs WHERE id = ?').get(`run-${number}`) as { metadata: string }).metadata).auto_merge;
const judgments = (number: number) => db.prepare('SELECT id, mode, decision, reason, answers_json FROM judgments WHERE judgment = ? AND subject_id = ? ORDER BY rowid').all(AUDIT_JUDGMENT, `run-${number}`) as Array<{ id: string; mode: string; decision: string; reason: string; answers_json: string }>;
const auditRows = () => db.prepare("SELECT action, resource_id FROM audit_events WHERE action LIKE 'loop_pr_audit_%' ORDER BY rowid").all() as Array<{ action: string; resource_id: string }>;
const auditEvents = (number: number) => db.prepare("SELECT event_type, message FROM loop_events WHERE loop_run_id = ? AND event_type = 'auto_merge_audit'").all(`run-${number}`) as Array<{ event_type: string; message: string }>;
const killing = (score: number | null, reason: string | null = null): ReturnType<typeof vi.fn> & AuditKillExecutor =>
  vi.fn(() => (score === null ? { score: null, reason } : { score, killed: Math.round(score * 3), total: 3, mutants: ['m1', 'm2', 'm3'], reason: null })) as never;
const tick = (e: NodeJS.ProcessEnv, exec: AuditKillExecutor | null, at = NOW) => runAutoMergeTick(db, fakeFetch as unknown as typeof fetch, e, at, exec);

beforeEach(() => {
  db = new Database(':memory:'); db.exec(schema); runMigrations(db);
  prs = new Map(); checks = new Map(); calls = []; fakeFetch.mockClear();
});
afterEach(() => { setPushSender(null); db.close(); });

// 701 / 706 / 708 / 709 are audit samples (sha256 of the PR number); 712 is also a spot check, 701 / 706 / 708 / 709 are not
it('fixtures: the sample and the spot check are deterministic from the PR number; spot checks are ~1 in 5 of the passes', () => {
  expect([701, 706, 708, 709, 712].map(isAuditSample)).toEqual([true, true, true, true, true]);
  expect([701, 706, 708, 709, 712].map(isAuditSpotCheck)).toEqual([false, false, false, false, true]);
  // prod: #1151 is not a spot check, #1177 is
  expect([1151, 1177].map(isAuditSpotCheck)).toEqual([false, true]);
  let n = 0; for (let i = 1; i <= 10_000; i++) if (isAuditSpotCheck(i)) n++;
  expect(n).toBeGreaterThan(1850); expect(n).toBeLessThan(2150);
});

it('flag: AUDIT_SAMPLE_AUTO_MODE off (default) | shadow | act, registered as an acting evolution flag with a runbook default', () => {
  expect(auditSampleAutoMode({})).toBe('off');
  expect(auditSampleAutoMode({ AUDIT_SAMPLE_AUTO_MODE: ' Shadow ' })).toBe('shadow');
  expect(auditSampleAutoMode({ AUDIT_SAMPLE_AUTO_MODE: 'act' })).toBe('act');
  expect(auditSampleAutoMode({ AUDIT_SAMPLE_AUTO_MODE: 'on' })).toBe('off');
  expect(EVOLUTION_FLAGS).toContainEqual({ name: 'AUDIT_SAMPLE_AUTO_MODE', acting: true });
  expect(RUNBOOK_DEFAULTS.AUDIT_SAMPLE_AUTO_MODE).toMatch(/^off/);
});

describe('executedAuditVerdict: pass needs all three signals; unknown is never a pass', () => {
  const green = { state: 'green' as const };
  it.each([
    ['pass', 'pass', green, { score: 0.667, killed: 2, total: 3, reason: null }],
    ['pass', 'pass', green, { score: 0.2, reason: null }],
    ['fail', 'pass', green, { score: 0, killed: 0, total: 3, reason: null }],
    ['fail', 'fail', green, { score: 1, reason: null }],
    ['fail', 'pass', { state: 'red' as const, reason: 'required_not_success:build=skipped' }, null],
    ['unknown', 'pass', green, { score: 0.1, reason: null }],
    ['unknown', 'pass', green, { score: null, reason: 'baseline red' }],
    ['unknown', 'pass', green, null],
    ['unknown', 'pass', { state: 'unavailable' as const }, null],
    ['unknown', 'pass', { state: 'pending' as const }, null],
    ['unknown', null, green, { score: 1, reason: null }],
    ['unknown', 'skipped', green, { score: 1, reason: null }],
  ])('%s ← strength %s, checks %o, kill %o', (verdict, strength, c, kill) => {
    expect(executedAuditVerdict({ strength, checks: c, kill }).verdict).toBe(verdict);
  });
});

it('off (default and explicit): byte-identical to main — the sample stays for the human, nothing is executed or judged, the decision is final', async () => {
  for (const audit of [undefined, 'off', 'nonsense']) {
    db.close(); db = new Database(':memory:'); db.exec(schema); runMigrations(db); prs = new Map(); checks = new Map(); calls = [];
    seedPr(701); seedPr(700);
    const exec = killing(1);
    await tick(env(audit), exec);
    expect(record(701)).toEqual({ mode: 'act', decision: 'audit_sample', reason: AUDIT_SAMPLE_REASON, at: NOW.toISOString(), pr_number: 701 });
    expect(record(700).decision).toBe('merged');
    expect(exec).not.toHaveBeenCalled();
    expect(judgments(701)).toEqual([]); expect(auditRows()).toEqual([]); expect(auditEvents(701)).toEqual([]);
    // final: the next tick makes no GitHub call for it
    calls = [];
    await tick(env(audit), exec, new Date(NOW.getTime() + H));
    expect(calls.filter((c) => c.url.includes('/701'))).toEqual([]);
    expect(record(701).at).toBe(NOW.toISOString());
  }
});

it('shadow: records the would-be decision (judgment + loop event) and changes nothing — not the record, not GitHub, no audit row', async () => {
  seedPr(701, { draft: true }); seedPr(706);
  await tick(env(undefined), null); // samples decided before the flag (prod #1151 / #1177)
  const before = record(701); const before706 = record(706);
  prs.get(706)!.state = 'closed'; // a gate that now fails never rewrites a sample in shadow
  calls = [];
  const exec = killing(0.667);
  await tick(env('shadow'), exec, new Date(NOW.getTime() + H));
  expect(exec).toHaveBeenCalledTimes(1);
  expect(exec.mock.calls[0][0]).toMatchObject({ run_id: 'run-701', head_sha: 'sha701', test_files: ['packages/server/src/__tests__/x701.exports.test.ts'], target: 'packages/server/src/services/x701.ts', maker_mutants: 3 });
  expect(record(701)).toEqual(before);
  expect(record(706)).toEqual(before706); expect(judgments(706)).toEqual([]);
  expect(writes()).toEqual([]);
  const j = judgments(701);
  expect(j).toHaveLength(1);
  expect(j[0]).toMatchObject({ mode: 'shadow', decision: 'audit_passed' });
  expect(JSON.parse(j[0].answers_json)).toMatchObject({ kill_share: 0.667, killed: 2, total: 3, kill_share_min: 0.2, assertion_strength: 'pass', checks: 'green', verdict: 'pass', spot_check: false, head_sha: 'sha701' });
  expect(auditEvents(701)).toHaveLength(1);
  expect(auditRows()).toEqual([]);
  // judged once per head and mode: the next tick neither executes nor calls GitHub for it
  calls = [];
  await tick(env('shadow'), exec, new Date(NOW.getTime() + 2 * H));
  expect(exec).toHaveBeenCalledTimes(1);
  expect(calls.filter((c) => c.url.includes('/701'))).toEqual([]);
});

it('act + pass: audit_passed (judgment + audit row), then the normal auto-merge path merges it', async () => {
  seedPr(701);
  const exec = killing(0.667);
  await tick(env('act'), exec);
  expect(record(701)).toMatchObject({ decision: 'audit_passed', mode: 'act' });
  expect(record(701).reason).toMatch(/fresh-mutant kill share 0\.667 \(2\/3\) ≥ 0\.2/);
  expect(judgments(701)).toMatchObject([{ mode: 'act', decision: 'audit_passed' }]);
  expect(auditRows()).toEqual([{ action: 'loop_pr_audit_passed', resource_id: 'https://github.com/o/r/pull/701' }]);
  expect(writes()).toEqual([]);
  // next tick: the normal steps (checks green, ready, clean) → squash-merge, without a second execution
  await tick(env('act'), exec, new Date(NOW.getTime() + 15 * 60_000));
  expect(exec).toHaveBeenCalledTimes(1);
  expect(record(701)).toMatchObject({ decision: 'merged', merge_commit_sha: 'merge701' });
  expect(writes().map((c) => c.url)).toEqual(['https://api.github.com/repos/o/r/pulls/701/merge']);
});

it('act + pass: an audit_passed PR that is behind waits its turn in the merge queue like any other PR (never a direct update-branch)', async () => {
  seedPr(700); seedPr(701);
  prs.get(700)!.mergeable_state = 'behind';
  await tick(env('act'), killing(0.667));
  expect(record(700)).toMatchObject({ decision: 'waiting', reason: 'branch_updated' });
  expect(record(701).decision).toBe('audit_passed');
  expect(writes().map((c) => c.url)).toEqual(['https://api.github.com/repos/o/r/pulls/700/update-branch']);
  // 700's CI runs on the updated head (in flight); 701 is now behind: it queues behind 700, no update-branch for it
  prs.get(700)!.mergeable_state = 'clean'; checks.set('sha700', 'pending'); prs.get(701)!.mergeable_state = 'behind';
  calls = [];
  await tick(env('act'), killing(0.667), new Date(NOW.getTime() + 15 * 60_000));
  expect(record(700)).toMatchObject({ decision: 'waiting', reason: 'checks_pending' });
  expect(record(701)).toMatchObject({ decision: 'waiting', reason: 'queued_behind_pr:#700' });
  expect(writes()).toEqual([]);
  // 700 merges, which frees the queue: 701's update runs after the PR loop
  checks.set('sha700', 'green'); calls = [];
  await tick(env('act'), killing(0.667), new Date(NOW.getTime() + 30 * 60_000));
  expect(record(700).decision).toBe('merged');
  expect(record(701)).toMatchObject({ decision: 'waiting', reason: 'branch_updated' });
  expect(writes().map((c) => c.url)).toEqual(['https://api.github.com/repos/o/r/pulls/700/merge', 'https://api.github.com/repos/o/r/pulls/701/update-branch']);
  expect(judgments(701)).toHaveLength(1);
});

it('act + kill share 0: stays for the human as audit_failed, final, never merged', async () => {
  seedPr(706);
  const exec = killing(0);
  await tick(env('act'), exec);
  expect(record(706)).toMatchObject({ decision: 'audit_sample' });
  expect(record(706).reason).toMatch(/^audit_failed: fresh-mutant kill share 0 \(0\/3\): the test kills no fresh mutant/);
  expect(judgments(706)).toMatchObject([{ mode: 'act', decision: 'audit_failed' }]);
  expect(auditRows()).toEqual([{ action: 'loop_pr_audit_failed', resource_id: 'https://github.com/o/r/pull/706' }]);
  calls = [];
  await tick(env('act'), exec, new Date(NOW.getTime() + H));
  expect(exec).toHaveBeenCalledTimes(1);
  expect(calls.filter((c) => c.url.includes('/706'))).toEqual([]);
  expect(record(706).reason).toMatch(/^audit_failed:/);
});

it('act + a missing signal: audit_unknown — no score, no executor, or checks pending beyond 24 h; pending before that defers', async () => {
  seedPr(706); seedPr(708); seedPr(709);
  checks.set('sha709', 'pending');
  await tick(env('act'), killing(null, 'no packages/server/src/__tests__ unit test (the graded kill share covers those only)'));
  expect(record(706).reason).toMatch(/^audit_unknown: no fresh-mutant kill share: no packages\/server/);
  expect(judgments(706)).toMatchObject([{ decision: 'audit_unknown' }]);
  // 708: one execution per tick — deferred, then executed on the next tick
  expect(record(708)).toMatchObject({ decision: 'audit_sample', reason: AUDIT_SAMPLE_REASON });
  expect(judgments(708)).toEqual([]);
  // 709: CI still running — deferred, nothing judged
  expect(record(709)).toMatchObject({ decision: 'audit_sample', reason: AUDIT_SAMPLE_REASON });
  expect(judgments(709)).toEqual([]);
  await tick(env('act'), null, new Date(NOW.getTime() + H));
  expect(record(708).reason).toBe('audit_unknown: no fresh-mutant kill share: no audit executor (the tick runs without the loop worktree service)');
  expect(judgments(709)).toEqual([]);
  await tick(env('act'), null, new Date(NOW.getTime() + 25 * H));
  expect(record(709).reason).toBe('audit_unknown: required checks pending');
  expect(JSON.parse(judgments(709)[0].answers_json)).toMatchObject({ checks: 'pending', checks_reason: 'pending > 24 h', kill_share: null });
  expect(auditRows().map((r) => r.action)).toEqual(['loop_pr_audit_unknown', 'loop_pr_audit_unknown', 'loop_pr_audit_unknown']);
  expect(writes()).toEqual([]);
});

it('act + red required checks: audit_failed without executing the kill share', async () => {
  seedPr(706); checks.set('sha706', 'red');
  const exec = killing(1);
  await tick(env('act'), exec);
  expect(exec).not.toHaveBeenCalled();
  expect(record(706).reason).toBe('audit_failed: required checks not green');
});

it('spot check: a passing audit of a 1-in-5 PR still stays for the human (audit_spot_check), not merged', async () => {
  seedPr(712);
  await tick(env('act'), killing(1));
  expect(record(712)).toMatchObject({ decision: 'audit_sample' });
  expect(record(712).reason).toMatch(/^audit_spot_check: fresh-mutant kill share 1 \(3\/3\).*1 in 5 passes stays for the human$/);
  expect(judgments(712)).toMatchObject([{ decision: 'audit_spot_check' }]);
  expect(JSON.parse(judgments(712)[0].answers_json)).toMatchObject({ verdict: 'pass', spot_check: true });
  await tick(env('act'), killing(1), new Date(NOW.getTime() + H));
  expect(record(712).decision).toBe('audit_sample');
  expect(writes()).toEqual([]);
});

it('needs-you: in act the audit batch counts only audit_failed / audit_unknown / audit_spot_check (the rest is system_prs); off and shadow count every sample', () => {
  const put = (id: string, am: Record<string, unknown> | null, state = 'open') => db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, metadata, created_at, updated_at)
    VALUES (?, 'test-gap', 'closed', 'completed', ?, '2026-10-06T00:00:00Z', '2026-10-06T00:00:00Z')`).run(id, JSON.stringify({ pr_url: `https://github.com/o/r/pull/${id}`, ...(am ? { auto_merge: am } : {}), pr_outcome: { state } }));
  put('1', { decision: 'audit_sample', reason: AUDIT_SAMPLE_REASON });
  put('2', { decision: 'audit_sample', reason: 'audit_failed: fresh-mutant kill share 0 (0/3)' });
  put('3', { decision: 'audit_sample', reason: 'audit_unknown: no fresh-mutant kill share' });
  put('4', { decision: 'audit_sample', reason: 'audit_spot_check: passed; 1 in 5 passes stays for the human' });
  put('5', { decision: 'audit_passed', reason: 'passed' });
  put('6', { decision: 'ineligible', reason: 'checks_failed' });
  put('7', { decision: 'audit_sample', reason: 'audit_failed: x' }, 'merged');
  put('8', null);
  // 5 (audit_passed: on the normal merge path) and 6 (transient checks_failed) are the lane's; 8 (no record) is flagged
  expect(openLoopPrSplit(db, {})).toEqual({ audit_batch: 4, system_prs: 2, flagged_prs: 1 });
  expect(openLoopPrSplit(db, { AUDIT_SAMPLE_AUTO_MODE: 'shadow' })).toEqual({ audit_batch: 4, system_prs: 2, flagged_prs: 1 });
  // act: 1 (audit not yet run) is the system's too — never a human decision, never flagged
  expect(openLoopPrSplit(db, { AUDIT_SAMPLE_AUTO_MODE: 'act' })).toEqual({ audit_batch: 3, system_prs: 3, flagged_prs: 1 });
});
