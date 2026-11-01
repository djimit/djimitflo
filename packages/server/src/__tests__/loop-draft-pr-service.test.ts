import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopDraftPrService } from '../services/loop-draft-pr-service';

let db: Database.Database; let wt: string; let remote: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const env = () => ({ LOOP_AUTO_DRAFT_PR_ENABLED: 'true', GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 't0ken' });
const ok = () => vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => existingPr() });

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'draftpr-'));
  remote = path.join(root, 'remote.git'); wt = path.join(root, 'wt');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  execFileSync('git', ['init', '-q', '-b', 'main', wt]);
  fs.writeFileSync(path.join(wt, '.gitignore'), 'node_modules/\n');
  fs.writeFileSync(path.join(wt, 'package-lock.json'), '{}\n');
  git(wt, 'add', '.'); git(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base'); git(wt, 'remote', 'add', 'origin', remote);
  // maker output + the noise a worktree carries
  fs.mkdirSync(path.join(wt, 'src')); fs.writeFileSync(path.join(wt, 'src', 'x.test.ts'), 'it("x", () => {});\n');
  fs.symlinkSync(root, path.join(wt, 'node_modules'));
  fs.writeFileSync(path.join(wt, 'package-lock.json'), '{"noise":true}\n');

  db = new Database(':memory:'); db.exec(schema); runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, gates_json, created_at, updated_at) VALUES ('run-1', 'doc-drift-and-small-fix-loop', 'closed', 'ready_for_human_merge', '[]', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, worktree_path, branch_name, metadata, created_at, updated_at) VALUES ('m1', 'run-1', 'maker', 'opencode', 'completed', ?, 'agent/loop/run-1', '{}', ?, ?)`).run(wt, now, now);
  db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES ('c1', 'run-1', 'checker', 'opencode', 'completed', '{"verdict":"accepted"}', ?, ?)`).run(now, now);
});
afterEach(() => { db.close(); });

it('does nothing unless LOOP_AUTO_DRAFT_PR_ENABLED', async () => {
  const f = ok();
  expect(await new LoopDraftPrService(db, f as unknown as typeof fetch, {}).openForRun('run-1')).toBeNull();
  expect(f).not.toHaveBeenCalled();
});

it('pushes only the maker files and opens one draft PR per run', async () => {
  const f = ok(); const svc = new LoopDraftPrService(db, f as unknown as typeof fetch, env());
  expect(await svc.openForRun('run-1')).toBe('https://github.com/o/r/pull/9');
  expect(git(remote, 'ls-tree', '-r', '--name-only', 'agent/loop/run-1').split('\n').sort()).toEqual(['.gitignore', 'package-lock.json', 'src/x.test.ts']);
  expect(git(remote, 'show', 'agent/loop/run-1:package-lock.json')).toBe('{}'); // lockfile noise not committed
  const req = JSON.parse(f.mock.calls[0][1].body as string);
  expect(req).toMatchObject({ head: 'agent/loop/run-1', base: 'main', draft: true });
  expect(req.body).toContain('checker: accepted');
  expect(fs.readFileSync(path.join(wt, '.git', 'config'), 'utf8')).not.toContain('t0ken'); // token never persisted
  // P0-6: the pushed commit is recorded as the verified head that auto-merge binds to
  const meta = JSON.parse((db.prepare("SELECT metadata FROM loop_runs WHERE id = 'run-1'").get() as { metadata: string }).metadata);
  expect(meta.verified_head_sha).toBe(git(remote, 'rev-parse', 'agent/loop/run-1'));
  expect(await svc.openForRun('run-1')).toBe('https://github.com/o/r/pull/9');
  expect(f).toHaveBeenCalledTimes(1);
});

it('records draft_pr_failed instead of throwing when GitHub refuses', async () => {
  const f = vi.fn().mockResolvedValue({ ok: false, status: 422, json: async () => ({}) });
  expect(await new LoopDraftPrService(db, f as unknown as typeof fetch, env()).openForRun('run-1')).toBeNull();
  expect(db.prepare("SELECT message FROM loop_events WHERE event_type = 'draft_pr_failed'").get()).toEqual({ message: 'Draft PR not opened: GitHub 422' });
});

// RX-6: a fetch that answers the open-PR list (GET) and the create call (POST)
const gh = (openTitles: string[] | 'error') => vi.fn(async (_url: string, init?: { method?: string }) => {
  if (!init?.method || init.method === 'GET') {
    if (openTitles === 'error') return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => openTitles.map((title) => ({ title })) };
  }
  return { ok: true, status: 201, json: async () => existingPr() };
});
const posts = (f: ReturnType<typeof gh>) => f.mock.calls.filter((c) => (c[1] as { method?: string } | undefined)?.method === 'POST').length;
const events = (type: string) => db.prepare('SELECT COUNT(*) AS n FROM loop_events WHERE event_type = ?').get(type) as { n: number };

it('RX-6: throttle mode off (default) makes no list call and opens the PR as before', async () => {
  const f = gh(['loop: a', 'loop: b', 'loop: c', 'loop: d', 'loop: e', 'loop: f']);
  expect(await new LoopDraftPrService(db, f as unknown as typeof fetch, env()).openForRun('run-1')).toBe('https://github.com/o/r/pull/9');
  expect(f).toHaveBeenCalledTimes(1); expect(posts(f)).toBe(1);
});

it('RX-6: shadow at the cap records draft_pr_throttle_shadow and still opens the PR', async () => {
  const f = gh(['loop: a', 'loop: b', 'other: x']);
  const svc = new LoopDraftPrService(db, f as unknown as typeof fetch, { ...env(), LOOP_DRAFT_PR_THROTTLE_MODE: 'shadow', LOOP_DRAFT_PR_MAX_OPEN: '2' });
  expect(await svc.openForRun('run-1')).toBe('https://github.com/o/r/pull/9');
  expect(events('draft_pr_throttle_shadow')).toEqual({ n: 1 }); expect(posts(f)).toBe(1);
});

it('RX-6: enforce at the cap records draft_pr_throttled and opens nothing; below the cap it opens', async () => {
  const f = gh(['loop: a', 'loop: b']);
  const svc = new LoopDraftPrService(db, f as unknown as typeof fetch, { ...env(), LOOP_DRAFT_PR_THROTTLE_MODE: 'enforce', LOOP_DRAFT_PR_MAX_OPEN: '2' });
  expect(await svc.openForRun('run-1')).toBeNull();
  expect(events('draft_pr_throttled')).toEqual({ n: 1 }); expect(posts(f)).toBe(0);
  expect(git(remote, 'branch', '--list', 'agent/loop/run-1')).toBe(''); // nothing pushed
  const below = gh(['loop: a']);
  expect(await new LoopDraftPrService(db, below as unknown as typeof fetch, { ...env(), LOOP_DRAFT_PR_THROTTLE_MODE: 'enforce', LOOP_DRAFT_PR_MAX_OPEN: '2' }).openForRun('run-1')).toBe('https://github.com/o/r/pull/9');
});

it('RX-6: a failing open-PR list never throttles (fail-open)', async () => {
  const f = gh('error');
  expect(await new LoopDraftPrService(db, f as unknown as typeof fetch, { ...env(), LOOP_DRAFT_PR_THROTTLE_MODE: 'enforce', LOOP_DRAFT_PR_MAX_OPEN: '0' }).openForRun('run-1')).toBe('https://github.com/o/r/pull/9');
  expect(events('draft_pr_throttled')).toEqual({ n: 0 });
});

// UX-10: a richer, safe body behind LOOP_PR_BODY_V2 (public repo: ids and aggregates only)
const V1_BODY = 'Opened by the djimitflo loop for run `run-1`.\n\nReviewer verdicts:\n- checker: accepted\n\nFiles: `src/x.test.ts`\n\nDraft: a human reviews and merges.';
const bodyOf = (f: ReturnType<typeof ok>) => JSON.parse(f.mock.calls[0][1].body as string).body as string;
const seedV2 = () => {
  db.prepare(`UPDATE loop_runs SET loop_name = 'mutation-gap', gates_json = ? WHERE id = 'run-1'`).run(JSON.stringify([
    { name: 'deterministic_checks', status: 'pass', evidence: 'raw evidence text must never be published /srv/secret/path' },
    { name: 'scope', status: 'pass', evidence: 'one file' },
  ]));
  const out = path.join(wt, '..', 'mut.out'); fs.writeFileSync(out, 'Mutation score 45.5 -> 93.9 (gain 48.4)\n');
  db.prepare(`UPDATE worker_leases SET metadata = ? WHERE id = 'm1'`).run(JSON.stringify({ deterministic_checks: [
    { name: 'test:changed', status: 'pass', exit_status: 0 }, { name: 'test:mutation:grounded', status: 'pass', exit_status: 0, stdout_path: out }] }));
  db.prepare(`UPDATE worker_leases SET metadata = ? WHERE id = 'c1'`).run(JSON.stringify({ verdict: 'accepted', notes: 'token=ghp_' + 'a'.repeat(36) }));
  db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES ('s1', 'run-1', 'security_checker', 'opencode', 'completed', '{"verdict":"accepted"}', datetime('now'), datetime('now'))`).run();
};

it('UX-10: default (flag unset) body is byte-identical to the v1 body', async () => {
  const f = ok(); await new LoopDraftPrService(db, f as unknown as typeof fetch, env()).openForRun('run-1');
  expect(bodyOf(f)).toBe(V1_BODY);
});

it('UX-10: v2 adds lane, oracle result, gate summary, verdict labels, diff stat and mutation gain — without evidence text', async () => {
  seedV2(); const f = ok();
  await new LoopDraftPrService(db, f as unknown as typeof fetch, { ...env(), LOOP_PR_BODY_V2: 'true' }).openForRun('run-1');
  const body = bodyOf(f);
  expect(body).toContain('Lane: `mutation-gap`');
  expect(body).toContain('Oracle checks: test:changed pass, test:mutation:grounded pass');
  expect(body).toContain('Gates: deterministic_checks pass, scope pass');
  expect(body).toContain('security_checker: accepted');
  expect(body).toMatch(/Diff: 1 file, \+\d+ \/ -\d+/);
  expect(body).toContain('Mutation score: 45.5 → 93.9');
  expect(body).not.toContain('raw evidence'); expect(body).not.toContain('/srv/');
  expect(body).not.toContain('Run:'); // no link without an https DJIMITFLO_PUBLIC_URL
});

it('UX-10: no run link when DJIMITFLO_PUBLIC_URL is not https', async () => {
  seedV2(); const f = ok();
  await new LoopDraftPrService(db, f as unknown as typeof fetch, { ...env(), LOOP_PR_BODY_V2: 'true', DJIMITFLO_PUBLIC_URL: 'http://10.0.0.1' }).openForRun('run-1');
  expect(bodyOf(f)).not.toContain('Run:'); expect(bodyOf(f)).not.toContain('10.0.0.1');
});

it('UX-10: the run link appears with an https DJIMITFLO_PUBLIC_URL', async () => {
  seedV2(); const f = ok();
  await new LoopDraftPrService(db, f as unknown as typeof fetch, { ...env(), LOOP_PR_BODY_V2: 'true', DJIMITFLO_PUBLIC_URL: 'https://example.test/' }).openForRun('run-1');
  expect(bodyOf(f)).toContain('Run: https://example.test/goals-loops?run=run-1');
});

it('UX-10: no secret pattern survives in the v2 body and the PR is still opened once per run', async () => {
  seedV2(); const f = ok(); const svc = new LoopDraftPrService(db, f as unknown as typeof fetch, { ...env(), LOOP_PR_BODY_V2: 'true' });
  await svc.openForRun('run-1');
  const body = bodyOf(f);
  expect(body).not.toMatch(/ghp_[a-zA-Z0-9]{36}/);
  expect(body).not.toContain('t0ken');
  await svc.openForRun('run-1');
  expect(f).toHaveBeenCalledTimes(1);
});

const publication = () => JSON.parse((db.prepare("SELECT metadata FROM loop_runs WHERE id = 'run-1'").get() as { metadata: string }).metadata).draft_publication;
const existingPr = (patch: Record<string, unknown> = {}) => ({
  html_url: 'https://github.com/o/r/pull/9', draft: true, state: 'open',
  body: 'Opened by the djimitflo loop for run `run-1`.',
  head: { ref: 'agent/loop/run-1', sha: publication().head, repo: { full_name: 'o/r' } },
  base: { ref: 'main', repo: { full_name: 'o/r' } }, ...patch,
});
const recoveryFetch = (rows: () => unknown[]) => vi.fn(async (_url: string, init?: RequestInit) => ({
  ok: true, status: 200, json: async () => init?.method === 'POST' ? existingPr() : rows(),
}));

it('recovers a crash after commit before its checkpoint without recommitting or losing original files', async () => {
  db.exec(`CREATE TRIGGER crash_commit BEFORE UPDATE OF metadata ON loop_runs
    WHEN json_extract(NEW.metadata, '$.draft_publication.phase') = 'committed'
    BEGIN SELECT RAISE(ABORT, 'simulated commit checkpoint crash'); END;`);
  const first = ok();
  expect(await new LoopDraftPrService(db, first as unknown as typeof fetch, env()).openForRun('run-1')).toBeNull();
  expect(first).not.toHaveBeenCalled();
  const head = git(wt, 'rev-parse', 'HEAD');
  expect(publication().phase).toBe('prepared');
  db.exec('DROP TRIGGER crash_commit');
  const retry = recoveryFetch(() => []);
  expect(await new LoopDraftPrService(db, retry as unknown as typeof fetch, env()).openForRun('run-1')).toBe('https://github.com/o/r/pull/9');
  expect(git(wt, 'rev-parse', 'HEAD')).toBe(head);
  expect(publication().files).toEqual(['src/x.test.ts']);
  expect(retry.mock.calls.filter(c => c[1]?.method === 'POST')).toHaveLength(1);
});

it('recovers after push before POST completion and performs one replacement request after exact reconciliation', async () => {
  const failFetch = vi.fn().mockRejectedValue(new Error('connection lost'));
  expect(await new LoopDraftPrService(db, failFetch as unknown as typeof fetch, env()).openForRun('run-1')).toBeNull();
  expect(git(remote, 'rev-parse', 'agent/loop/run-1')).toBe(publication().head);
  const retry = recoveryFetch(() => []);
  expect(await new LoopDraftPrService(db, retry as unknown as typeof fetch, env()).openForRun('run-1')).toBe('https://github.com/o/r/pull/9');
  expect(retry.mock.calls).toHaveLength(2);
});

it('reconciles a created draft after response loss without duplicate POST, including service recreation', async () => {
  const lost = vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => { throw new Error('lost response'); } });
  expect(await new LoopDraftPrService(db, lost as unknown as typeof fetch, env()).openForRun('run-1')).toBeNull();
  const retry = recoveryFetch(() => [existingPr()]);
  const service = new LoopDraftPrService(db, retry as unknown as typeof fetch, env());
  expect(await service.openForRun('run-1')).toBe('https://github.com/o/r/pull/9');
  expect(await new LoopDraftPrService(db, retry as unknown as typeof fetch, env()).openForRun('run-1')).toBe('https://github.com/o/r/pull/9');
  expect(retry.mock.calls).toHaveLength(1);
  expect(retry.mock.calls[0][1]?.method).not.toBe('POST');
  expect(events('draft_pr_opened')).toEqual({ n: 1 });
});

it.each(['ambiguous', 'moved', 'wrong-repo', 'wrong-base', 'wrong-run', 'not-draft', 'closed'])('refuses unsafe reconciliation: %s', async (fault) => {
  await new LoopDraftPrService(db, vi.fn().mockRejectedValue(new Error('lost')) as unknown as typeof fetch, env()).openForRun('run-1');
  const retry = recoveryFetch(() => {
    const pr = existingPr();
    if (fault === 'ambiguous') return [pr, pr];
    if (fault === 'moved') pr.head.sha = 'f'.repeat(40);
    if (fault === 'wrong-repo') pr.head.repo.full_name = 'other/r';
    if (fault === 'wrong-base') pr.base.ref = 'other';
    if (fault === 'wrong-run') pr.body = 'another run';
    if (fault === 'not-draft') pr.draft = false;
    if (fault === 'closed') pr.state = 'closed';
    return [pr];
  });
  expect(await new LoopDraftPrService(db, retry as unknown as typeof fetch, env()).openForRun('run-1')).toBeNull();
  expect(retry.mock.calls.filter(c => c[1]?.method === 'POST')).toHaveLength(0);
});

it('does not retry publishing when reconciliation is unavailable', async () => {
  const failFetch = vi.fn().mockRejectedValue(new Error('lost'));
  await new LoopDraftPrService(db, failFetch as unknown as typeof fetch, env()).openForRun('run-1');
  failFetch.mockClear();
  expect(await new LoopDraftPrService(db, failFetch as unknown as typeof fetch, env()).openForRun('run-1')).toBeNull();
  expect(failFetch.mock.calls).toHaveLength(1);
  expect(failFetch.mock.calls[0][1]?.method).not.toBe('POST');
});

it('uses a persisted claim across service instances while the first publisher is awaiting GitHub', async () => {
  let resolve!: (value: unknown) => void;
  const waiting = vi.fn(() => new Promise(r => { resolve = r; }));
  const first = new LoopDraftPrService(db, waiting as unknown as typeof fetch, env()).openForRun('run-1');
  const second = ok();
  expect(await new LoopDraftPrService(db, second as unknown as typeof fetch, env()).openForRun('run-1')).toBeNull();
  expect(second).not.toHaveBeenCalled();
  resolve({ ok: true, status: 201, json: async () => existingPr() });
  expect(await first).toBe('https://github.com/o/r/pull/9');
});

it('revalidates a stop during reconciliation and never publishes after it', async () => {
  await new LoopDraftPrService(db, vi.fn().mockRejectedValue(new Error('lost')) as unknown as typeof fetch, env()).openForRun('run-1');
  const retry = recoveryFetch(() => { db.prepare("UPDATE loop_runs SET status = 'cancelled' WHERE id = 'run-1'").run(); return []; });
  expect(await new LoopDraftPrService(db, retry as unknown as typeof fetch, env()).openForRun('run-1')).toBeNull();
  expect(retry.mock.calls.filter(c => c[1]?.method === 'POST')).toHaveLength(0);
});

it('holds a changed maker artifact instead of publishing it under the previous checkpoint', async () => {
  await new LoopDraftPrService(db, vi.fn().mockRejectedValue(new Error('lost')) as unknown as typeof fetch, env()).openForRun('run-1');
  fs.appendFileSync(path.join(wt, 'src/x.test.ts'), '\nchanged');
  const retry = recoveryFetch(() => []);
  expect(await new LoopDraftPrService(db, retry as unknown as typeof fetch, env()).openForRun('run-1')).toBeNull();
  expect(retry).not.toHaveBeenCalled();
});

it('recovers an expired persisted publisher lease and refuses a still-live lease', async () => {
  await new LoopDraftPrService(db, vi.fn().mockRejectedValue(new Error('lost')) as unknown as typeof fetch, env()).openForRun('run-1');
  db.prepare(`UPDATE loop_runs SET metadata = json_set(metadata, '$.draft_publication.owner', 'crashed-worker', '$.draft_publication.leaseUntil', ?) WHERE id = 'run-1'`).run(Date.now() + 60_000);
  const retry = recoveryFetch(() => [existingPr()]);
  expect(await new LoopDraftPrService(db, retry as unknown as typeof fetch, env()).openForRun('run-1')).toBeNull();
  expect(retry).not.toHaveBeenCalled();
  db.prepare(`UPDATE loop_runs SET metadata = json_set(metadata, '$.draft_publication.leaseUntil', ?) WHERE id = 'run-1'`).run(Date.now() - 1);
  expect(await new LoopDraftPrService(db, retry as unknown as typeof fetch, env()).openForRun('run-1')).toBe('https://github.com/o/r/pull/9');
});

it('refuses changed publication ownership before reconciliation', async () => {
  await new LoopDraftPrService(db, vi.fn().mockRejectedValue(new Error('lost')) as unknown as typeof fetch, env()).openForRun('run-1');
  db.prepare("UPDATE worker_leases SET branch_name = 'agent/other' WHERE id = 'm1'").run();
  const retry = recoveryFetch(() => []);
  expect(await new LoopDraftPrService(db, retry as unknown as typeof fetch, env()).openForRun('run-1')).toBeNull();
  expect(retry).not.toHaveBeenCalled();
});

it('does not overwrite a remote branch moved after the original push', async () => {
  await new LoopDraftPrService(db, vi.fn().mockRejectedValue(new Error('lost')) as unknown as typeof fetch, env()).openForRun('run-1');
  const changed = git(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'other writer');
  git(wt, 'push', '-q', 'origin', `${changed}:refs/heads/agent/loop/run-1`);
  const retry = recoveryFetch(() => []);
  expect(await new LoopDraftPrService(db, retry as unknown as typeof fetch, env()).openForRun('run-1')).toBeNull();
  expect(retry.mock.calls.filter(c => c[1]?.method === 'POST')).toHaveLength(0);
  expect(git(remote, 'rev-parse', 'agent/loop/run-1')).toBe(changed);
});

it('does not include unrelated staged files in the checkpoint commit', async () => {
  fs.writeFileSync(path.join(wt, 'package-lock.json'), '{"noise":true}\n');
  git(wt, 'add', 'package-lock.json');
  const f = ok();
  expect(await new LoopDraftPrService(db, f as unknown as typeof fetch, env()).openForRun('run-1')).toBe('https://github.com/o/r/pull/9');
  expect(git(remote, 'show', 'agent/loop/run-1:package-lock.json')).toBe('{}');
});

it('a publisher that loses its lease cannot settle or release the replacement owner claim', async () => {
  const takeover = vi.fn(async () => {
    db.prepare(`UPDATE loop_runs SET metadata = json_set(metadata, '$.draft_publication.owner', 'replacement', '$.draft_publication.leaseUntil', ?) WHERE id = 'run-1'`).run(Date.now() + 300_000);
    return { ok: true, status: 201, json: async () => existingPr() };
  });
  expect(await new LoopDraftPrService(db, takeover as unknown as typeof fetch, env()).openForRun('run-1')).toBeNull();
  expect(publication().owner).toBe('replacement');
  expect(publication().leaseUntil).toBeGreaterThan(Date.now());
  expect(events('draft_pr_opened')).toEqual({ n: 0 });
});

it.each(['head', 'base'])('does not settle a successful POST response for a different %s', async (field) => {
  const f = vi.fn(async () => ({ ok: true, status: 201, json: async () => {
    const pr = existingPr();
    if (field === 'head') pr.head.sha = 'f'.repeat(40);
    else pr.base.ref = 'other';
    return pr;
  } }));
  expect(await new LoopDraftPrService(db, f as unknown as typeof fetch, env()).openForRun('run-1')).toBeNull();
  expect(events('draft_pr_opened')).toEqual({ n: 0 });
  const metadata = JSON.parse((db.prepare("SELECT metadata FROM loop_runs WHERE id = 'run-1'").get() as { metadata: string }).metadata);
  expect(metadata.pr_url).toBeUndefined();
  expect(metadata.verified_head_sha).toBeUndefined();
});

it.each([true, false])('at the draft cap, recovery may reconcile but cannot create a new PR (exists=%s)', async (exists) => {
  await new LoopDraftPrService(db, vi.fn().mockRejectedValue(new Error('lost')) as unknown as typeof fetch, env()).openForRun('run-1');
  const f = vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => url.includes('state=all') ? (exists ? [existingPr()] : []) : [{ title: 'loop: existing' }] }));
  const result = await new LoopDraftPrService(db, f as unknown as typeof fetch, { ...env(), LOOP_DRAFT_PR_THROTTLE_MODE: 'enforce', LOOP_DRAFT_PR_MAX_OPEN: '1' }).openForRun('run-1');
  expect(result).toBe(exists ? 'https://github.com/o/r/pull/9' : null);
  expect(f.mock.calls).toHaveLength(2);
});

function factoryRunRows() {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, evidence_refs_json, grounding_json, created_at, updated_at)
    VALUES ('p1', 'feature', 'Slug', 'd', 'r', 'operator_request', 'executing', 0.6, '["capability-request:req1"]', '{"target":"src/x.test.ts","acceptanceTest":"src/x.test.ts"}', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO goals (id, objective, risk_class, status, metadata, improvement_id, created_at, updated_at) VALUES ('g1', 'o', 'low', 'running', '{}', 'p1', ?, ?)`).run(now, now);
  db.prepare("UPDATE loop_runs SET goal_id = 'g1' WHERE id = 'run-1'").run();
  return { ...env(), CAPABILITY_FACTORY_MODE: 'on' };
}

it('CAP-3: flag off — a factory run\'s draft PR creates no capability (today\'s behaviour)', async () => {
  expect(await new LoopDraftPrService(db, ok() as unknown as typeof fetch, factoryRunRows()).openForRun('run-1')).toBe('https://github.com/o/r/pull/9');
  expect(db.prepare('SELECT COUNT(*) AS n FROM swarm_capabilities').get()).toEqual({ n: 0 });
});

it('CAP-3: CAPABILITY_LIFECYCLE_V2=on — the draft PR creates the capfac candidate at the verified head', async () => {
  expect(await new LoopDraftPrService(db, ok() as unknown as typeof fetch, { ...factoryRunRows(), CAPABILITY_LIFECYCLE_V2: 'on' }).openForRun('run-1')).toBe('https://github.com/o/r/pull/9');
  const head = JSON.parse((db.prepare("SELECT metadata FROM loop_runs WHERE id = 'run-1'").get() as { metadata: string }).metadata).verified_head_sha as string;
  expect(db.prepare("SELECT status, version, json_extract(metadata, '$.provenance.pr_url') AS pr FROM swarm_capabilities WHERE id = 'capfac:req1'").get())
    .toEqual({ status: 'candidate', version: head.slice(0, 12), pr: 'https://github.com/o/r/pull/9' });
});

it('creates one candidate after reconciling a lost draft response, without a second POST', async () => {
  const config = { ...factoryRunRows(), CAPABILITY_LIFECYCLE_V2: 'on' };
  await new LoopDraftPrService(db, vi.fn().mockRejectedValue(new Error('response lost')) as unknown as typeof fetch, config).openForRun('run-1');
  expect(db.prepare('SELECT COUNT(*) AS n FROM swarm_capabilities').get()).toEqual({ n: 0 });
  const fetch = recoveryFetch(() => [existingPr()]);
  const service = new LoopDraftPrService(db, fetch as unknown as typeof globalThis.fetch, config);
  expect(await service.openForRun('run-1')).toBe('https://github.com/o/r/pull/9');
  expect(await service.openForRun('run-1')).toBe('https://github.com/o/r/pull/9');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][1]?.method).not.toBe('POST');
  expect(db.prepare("SELECT status, version FROM swarm_capabilities WHERE id = 'capfac:req1'").get())
    .toEqual({ status: 'candidate', version: publication().head.slice(0, 12) });
  expect(db.prepare('SELECT COUNT(*) AS n FROM swarm_capabilities').get()).toEqual({ n: 1 });
});
