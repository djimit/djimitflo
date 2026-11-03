import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopDraftPrService, retryFailedDraftPrs } from '../services/loop-draft-pr-service';

// PRC-1: one PR per run, ever — a retry adopts the PR an earlier attempt opened and never commits the work twice.
let db: Database.Database; let wt: string; let remote: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const env = (extra: Record<string, string> = {}) => ({ LOOP_AUTO_DRAFT_PR_ENABLED: 'true', GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 't0ken', ...extra });
type Init = { method?: string; body?: string } | undefined;
const fullPr = (pr: Record<string, unknown>) => ({
  draft: true, state: 'open', body: 'Opened by the djimitflo loop for run `run-1`.',
  head: { ref: 'agent/loop/run-1', sha: git(wt, 'rev-parse', 'HEAD'), repo: { full_name: 'o/r' } },
  base: { ref: 'main', repo: { full_name: 'o/r' } }, ...pr,
});
/** A fake GitHub: `existing` answers the head-branch lookup (GET pulls?head=), `post` the create call. */
const github = (opts: { existing?: Array<{ html_url: string; number: number; state?: string }>; post: { status: number; json?: unknown } | 'throw' }) => vi.fn(async (url: string, init?: Init) => {
  if (init?.method === 'POST') {
    if (opts.post === 'throw') throw new Error('socket hang up');
    const post = opts.post;
    return { ok: post.status < 300, status: post.status, json: async () => fullPr((post.json ?? {}) as Record<string, unknown>) };
  }
  if (url.includes('/pulls?') && new URL(url).searchParams.has('head')) return { ok: true, status: 200, json: async () => (opts.existing ?? []).map((p) => fullPr(p)) };
  return { ok: false, status: 404, json: async () => ({}) };
});
const posts = (f: ReturnType<typeof github>) => f.mock.calls.filter((c) => (c[1] as Init)?.method === 'POST').length;
const lookups = (f: ReturnType<typeof github>) => f.mock.calls.filter((c) => String(c[0]).includes('/pulls?') && new URL(String(c[0])).searchParams.has('head')).map((c) => String(c[0]));
const meta = () => JSON.parse((db.prepare("SELECT metadata FROM loop_runs WHERE id = 'run-1'").get() as { metadata: string | null }).metadata || '{}');
const count = (type: string) => (db.prepare('SELECT COUNT(*) AS n FROM loop_events WHERE event_type = ?').get(type) as { n: number }).n;
const commits = () => Number(git(wt, 'rev-list', '--count', 'HEAD'));

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'draftpr-prc-'));
  remote = path.join(root, 'remote.git'); wt = path.join(root, 'wt');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  execFileSync('git', ['init', '-q', '-b', 'main', wt]);
  fs.writeFileSync(path.join(wt, 'README.md'), 'base\n');
  git(wt, 'add', '.'); git(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base'); git(wt, 'remote', 'add', 'origin', remote);
  fs.mkdirSync(path.join(wt, 'src')); fs.writeFileSync(path.join(wt, 'src', 'x.test.ts'), 'it("x", () => {});\n');
  db = new Database(':memory:'); db.exec(schema); runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, gates_json, created_at, updated_at) VALUES ('run-1', 'doc-drift-and-small-fix-loop', 'closed', 'completed', '[]', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, worktree_path, branch_name, metadata, created_at, updated_at) VALUES ('m1', 'run-1', 'maker', 'opencode', 'completed', ?, 'agent/loop/run-1', '{}', ?, ?)`).run(wt, now, now);
});
afterEach(() => { db.close(); });

it('PRC-1: a 422 (PR already exists) adopts the existing PR and persists pr_url, pr_number and pr_head_branch', async () => {
  const f = github({ existing: [{ html_url: 'https://github.com/o/r/pull/41', number: 41 }], post: { status: 422, json: { message: 'A pull request already exists' } } });
  expect(await new LoopDraftPrService(db, f as unknown as typeof fetch, env()).openForRun('run-1')).toBe('https://github.com/o/r/pull/41');
  expect(posts(f)).toBe(1);
  expect(lookups(f)).toEqual(['https://api.github.com/repos/o/r/pulls?state=all&head=o%3Aagent%2Floop%2Frun-1&base=main&per_page=100']);
  expect(meta()).toMatchObject({ pr_url: 'https://github.com/o/r/pull/41', pr_number: 41, pr_head_branch: 'agent/loop/run-1', verified_head_sha: git(remote, 'rev-parse', 'agent/loop/run-1') });
  expect(count('draft_pr_adopted')).toBe(1);
  expect(count('draft_pr_failed')).toBe(0);
});

it('PRC-1: a 422 with no PR to adopt is still draft_pr_failed (GitHub 422)', async () => {
  const f = github({ existing: [], post: { status: 422 } });
  expect(await new LoopDraftPrService(db, f as unknown as typeof fetch, env()).openForRun('run-1')).toBeNull();
  expect(db.prepare("SELECT message FROM loop_events WHERE event_type = 'draft_pr_failed'").all()).toEqual([{ message: 'Draft PR not opened: GitHub 422' }]);
  expect(meta().pr_url).toBeUndefined();
});

it('PRC-1: a retry after a failed POST commits nothing new and adopts the PR the first attempt opened — no second POST', async () => {
  const first = github({ post: 'throw' });
  expect(await new LoopDraftPrService(db, first as unknown as typeof fetch, env()).openForRun('run-1')).toBeNull();
  expect(count('draft_pr_failed')).toBe(1);
  expect(commits()).toBe(2); // base + the loop commit
  const pushed = git(remote, 'rev-parse', 'agent/loop/run-1');

  const retry = github({ existing: [{ html_url: 'https://github.com/o/r/pull/42', number: 42 }], post: { status: 201, json: { html_url: 'https://github.com/o/r/pull/99', number: 99 } } });
  expect(await new LoopDraftPrService(db, retry as unknown as typeof fetch, env()).openForRun('run-1')).toBe('https://github.com/o/r/pull/42');
  expect(posts(retry)).toBe(0);
  expect(commits()).toBe(2); // HEAD already held the work: not committed again
  expect(meta()).toMatchObject({ pr_url: 'https://github.com/o/r/pull/42', pr_number: 42, pr_head_branch: 'agent/loop/run-1', verified_head_sha: pushed });
});

it('PRC-1: a retry with no PR on GitHub yet POSTs once from the existing commit', async () => {
  await new LoopDraftPrService(db, github({ post: 'throw' }) as unknown as typeof fetch, env()).openForRun('run-1');
  const retry = github({ existing: [], post: { status: 201, json: { html_url: 'https://github.com/o/r/pull/43', number: 43 } } });
  expect(await new LoopDraftPrService(db, retry as unknown as typeof fetch, env()).openForRun('run-1')).toBe('https://github.com/o/r/pull/43');
  expect(posts(retry)).toBe(1); expect(commits()).toBe(2);
  expect(JSON.parse(String((retry.mock.calls.find((c) => (c[1] as Init)?.method === 'POST')![1] as Init)!.body)).body).toContain('Files: `src/x.test.ts`');
  expect(meta()).toMatchObject({ pr_number: 43, pr_head_branch: 'agent/loop/run-1' });
});

it('PRC-1: a closed PR for the branch is never adopted and no new PR is opened — draft_pr_failed closed_pr_exists', async () => {
  await new LoopDraftPrService(db, github({ post: 'throw' }) as unknown as typeof fetch, env()).openForRun('run-1');
  const retry = github({ existing: [{ html_url: 'https://github.com/o/r/pull/46', number: 46, state: 'closed' }], post: { status: 201, json: { html_url: 'https://github.com/o/r/pull/98', number: 98 } } });
  expect(await new LoopDraftPrService(db, retry as unknown as typeof fetch, env()).openForRun('run-1')).toBeNull();
  expect(posts(retry)).toBe(0);
  expect(meta().pr_url).toBeUndefined();
  expect(count('draft_pr_adopted')).toBe(0);
  expect((db.prepare("SELECT message FROM loop_events WHERE event_type = 'draft_pr_failed' ORDER BY created_at").all() as Array<{ message: string }>).map((e) => e.message).at(-1)).toBe('Draft PR not opened: closed_pr_exists');
  expect(count('draft_pr_failed')).toBe(2); // counts toward the 3-failure stop
  const on422 = github({ existing: [{ html_url: 'https://github.com/o/r/pull/47', number: 47, state: 'closed' }], post: { status: 422 } });
  db.prepare("DELETE FROM loop_events").run(); db.prepare("UPDATE loop_runs SET metadata='{}' WHERE id='run-1'").run(); git(wt, 'reset', '-q', 'HEAD~1'); git(remote, 'branch', '-D', 'agent/loop/run-1'); // first attempt again: POST → 422 → only a closed match
  // the remote branch goes too: a re-commit in the next second has a new sha, and pushing it over the old branch would be rejected (flaky in CI)
  expect(await new LoopDraftPrService(db, on422 as unknown as typeof fetch, env()).openForRun('run-1')).toBeNull();
  expect(db.prepare("SELECT message FROM loop_events WHERE event_type = 'draft_pr_failed'").all()).toEqual([{ message: 'Draft PR not opened: closed_pr_exists' }]);
  expect(meta().pr_url).toBeUndefined();
});

const failEvent = () => db.prepare(`INSERT INTO loop_events (id, loop_run_id, event_type, level, message, metadata, created_at) VALUES (lower(hex(randomblob(8))), 'run-1', 'draft_pr_failed', 'warning', 'x', '{}', ?)`).run(new Date().toISOString());

it('PRC-1: retry sweep off (default) calls nothing; on retries a certified run without pr_url once per tick', async () => {
  failEvent();
  const f = github({ post: { status: 201, json: { html_url: 'https://github.com/o/r/pull/44', number: 44 } } });
  expect(await retryFailedDraftPrs(db, f as unknown as typeof fetch, env())).toEqual({ retried: 0, opened: 0 });
  expect(f).not.toHaveBeenCalled();
  expect(await retryFailedDraftPrs(db, f as unknown as typeof fetch, env({ LOOP_DRAFT_PR_RETRY: 'on' }))).toEqual({ retried: 1, opened: 1 });
  expect(meta().pr_url).toBe('https://github.com/o/r/pull/44');
  expect(await retryFailedDraftPrs(db, f as unknown as typeof fetch, env({ LOOP_DRAFT_PR_RETRY: 'on' }))).toEqual({ retried: 0, opened: 0 }); // has a PR now
  expect(posts(f)).toBe(1);
});

it('PRC-1: retry sweep stops at 3 draft_pr_failed events; never touches a run that was never attempted', async () => {
  const f = github({ post: 'throw' });
  const on = env({ LOOP_DRAFT_PR_RETRY: 'on' });
  expect(await retryFailedDraftPrs(db, f as unknown as typeof fetch, on)).toEqual({ retried: 0, opened: 0 }); // 0 failures: not a retry
  failEvent();
  expect(await retryFailedDraftPrs(db, f as unknown as typeof fetch, on)).toEqual({ retried: 1, opened: 0 });
  expect(await retryFailedDraftPrs(db, f as unknown as typeof fetch, on)).toEqual({ retried: 1, opened: 0 });
  expect(count('draft_pr_failed')).toBe(3);
  expect(await retryFailedDraftPrs(db, f as unknown as typeof fetch, on)).toEqual({ retried: 0, opened: 0 });
  expect(posts(f)).toBe(2);
});

it('PRC-1: retry sweep shadow records draft_pr_retry_shadow and calls nothing', async () => {
  failEvent();
  const f = github({ post: { status: 201, json: { html_url: 'https://github.com/o/r/pull/45', number: 45 } } });
  expect(await retryFailedDraftPrs(db, f as unknown as typeof fetch, env({ LOOP_DRAFT_PR_RETRY: 'shadow' }))).toEqual({ retried: 0, opened: 0 });
  expect(f).not.toHaveBeenCalled(); expect(count('draft_pr_retry_shadow')).toBe(1);
});

it('PRC-3: the draft PR body says `Refs owner/repo#N` when the goal came from a GitHub issue (WORK_ITEM_OUTCOME_SYNC=on only)', async () => {
  db.prepare(`INSERT INTO goals (id, objective, constraints_json, acceptance_criteria_json, risk_class, budget_json, status, metadata, created_at, updated_at)
    VALUES ('g1', 'o', '[]', '[]', 'low', '{}', 'completed', '{"source":"github_issue","source_ref":"o/r#12","source_work_item_id":"w1"}', datetime('now'), datetime('now'))`).run();
  db.prepare("UPDATE loop_runs SET goal_id = 'g1' WHERE id = 'run-1'").run();
  const bodyOf = (f: ReturnType<typeof github>) => JSON.parse(String((f.mock.calls.find((c) => (c[1] as Init)?.method === 'POST')![1] as Init)!.body)).body as string;
  const off = github({ post: { status: 201, json: { html_url: 'https://github.com/o/r/pull/50', number: 50 } } });
  await new LoopDraftPrService(db, off as unknown as typeof fetch, env()).openForRun('run-1');
  expect(bodyOf(off)).not.toContain('Refs');
  db.prepare("UPDATE loop_runs SET metadata = '{}' WHERE id = 'run-1'").run();
  const on = github({ existing: [], post: { status: 201, json: { html_url: 'https://github.com/o/r/pull/51', number: 51 } } });
  await new LoopDraftPrService(db, on as unknown as typeof fetch, env({ WORK_ITEM_OUTCOME_SYNC: 'on' })).openForRun('run-1');
  expect(bodyOf(on).endsWith('\n\nRefs o/r#12')).toBe(true);
});

it('imports a pre-checkpoint loop commit through strict reconciliation without a second commit or POST', async () => {
  await new LoopDraftPrService(db, github({ post: 'throw' }) as unknown as typeof fetch, env()).openForRun('run-1');
  db.prepare("UPDATE loop_runs SET metadata='{}' WHERE id='run-1'").run(); // a run written by the previous publisher
  const head = git(wt, 'rev-parse', 'HEAD');
  const f = github({ existing: [{ html_url: 'https://github.com/o/r/pull/80', number: 80 }], post: 'throw' });
  expect(await new LoopDraftPrService(db, f as unknown as typeof fetch, env()).openForRun('run-1')).toBe('https://github.com/o/r/pull/80');
  expect(posts(f)).toBe(0); expect(commits()).toBe(2);
  expect(meta()).toMatchObject({ pr_number: 80, verified_head_sha: head, draft_publication: { head, makerId: 'm1' } });
});

it.each(['wrong-head', 'unknown'])('422 reconciliation stays fail-closed for %s and stores no success metadata', async (fault) => {
  const f = vi.fn(async (_url: string, init?: Init) => {
    if (init?.method === 'POST') return { ok: false, status: 422, json: async () => ({}) };
    if (fault === 'unknown') return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => [fullPr({ html_url: 'https://github.com/o/r/pull/81', number: 81,
      head: { ref: 'agent/loop/run-1', sha: 'f'.repeat(40), repo: { full_name: 'o/r' } } })] };
  });
  expect(await new LoopDraftPrService(db, f as unknown as typeof fetch, env()).openForRun('run-1')).toBeNull();
  expect(meta().pr_url).toBeUndefined(); expect(meta().verified_head_sha).toBeUndefined();
  expect(count('draft_pr_adopted')).toBe(0);
});

it('legacy recovery never imports a changed worktree as the previously published artifact', async () => {
  await new LoopDraftPrService(db, github({ post: 'throw' }) as unknown as typeof fetch, env()).openForRun('run-1');
  db.prepare("UPDATE loop_runs SET metadata='{}' WHERE id='run-1'").run();
  fs.appendFileSync(path.join(wt, 'src/x.test.ts'), '\nchanged after publication');
  const f = github({ existing: [{ html_url: 'https://github.com/o/r/pull/82', number: 82 }], post: 'throw' });
  expect(await new LoopDraftPrService(db, f as unknown as typeof fetch, env()).openForRun('run-1')).toBeNull();
  expect(f).not.toHaveBeenCalled(); expect(meta().pr_url).toBeUndefined();
});
