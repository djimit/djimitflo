import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Task } from '@djimitflo/shared';
import { RemoteMakerQueue } from '../services/remote-maker-queue';
import { RemoteMakerExecutor, parseRemoteTarget, remoteMakerCancelReason, remoteMakerWaitMs } from '../execution/executors/remote-maker-executor';

let db: Database.Database; let dir: string;
beforeEach(() => { db = new Database(':memory:'); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-maker-')); });
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });
const git = (args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
function repo(pushed = true) {
  git(['init', '-q']); fs.writeFileSync(path.join(dir, 'calc.mjs'), 'export const add = (a, b) => a - b;\n');
  git(['add', '.']); git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  if (pushed) git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
}
const task = (): Task => ({ id: 't', title: 'x', description: 'fix add', status: 'pending', priority: 'low', risk_level: 'low', execution_mode: 'local', agent_id: null, parent_task_id: null, repository_id: null, instruction_profile_id: null, started_at: null, completed_at: null, failed_at: null, execution_time_ms: null, token_usage: null, created_by: null, owner_user_id: null, updated_by: null, tags: [], metadata: {}, created_at: '', updated_at: '' });
async function drain(session: Awaited<ReturnType<RemoteMakerExecutor['start']>>) { const it = (async () => { for await (const _ of session.events) { /* drain */ } })(); const r = await session.result; await it; return r; }

it('queue: host- and species-bound claims, results only for the claiming host, patch size cap', () => {
  const q = new RemoteMakerQueue(db);
  const id = q.enqueue('workstation', 'atomic@llama-router', 'abc', 'fix it');
  expect(q.claim('nas', ['atomic@llama-router'])).toBeNull();
  expect(q.claim('workstation', ['other'])).toBeNull();
  expect(q.claim('workstation', ['atomic@llama-router'])).toMatchObject({ id, base_commit: 'abc', prompt: 'fix it' });
  expect(q.claim('workstation', ['atomic@llama-router'])).toBeNull(); // already claimed
  expect(() => q.record(id, 'nas', { status: 'done', patch: '' })).toThrow('MAKER_JOB_NOT_FOUND');
  expect(() => q.record(id, 'workstation', { status: 'done', patch: 'x'.repeat(2 * 1024 * 1024 + 1) })).toThrow('MAKER_PATCH_TOO_LARGE');
  q.record(id, 'workstation', { status: 'done', patch: '', reason: 'no change' });
  expect(() => q.record(id, 'workstation', { status: 'done' })).toThrow('MAKER_JOB_NOT_CLAIMED');
});

it('executor: enqueues at the pushed base, applies the returned patch to the worktree', async () => {
  repo();
  const q = new RemoteMakerQueue(db);
  const session = await new RemoteMakerExecutor(db, 20).start(task(), { workingDirectory: dir, model: 'workstation/atomic@llama-router', timeout: 10_000 });
  const worker = (async () => {
    for (let i = 0; i < 200; i++) {
      const job = q.claim('workstation', ['atomic@llama-router']);
      if (job) {
        expect(job.base_commit).toBe(git(['rev-parse', 'HEAD']).trim());
        const patch = `diff --git a/calc.mjs b/calc.mjs\n--- a/calc.mjs\n+++ b/calc.mjs\n@@ -1 +1 @@\n-export const add = (a, b) => a - b;\n+export const add = (a, b) => a + b;\n`;
        q.record(job.id, 'workstation', { status: 'done', patch, reason: 'fixed' });
        return;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  })();
  const result = await drain(session); await worker;
  expect(result.status).toBe('completed');
  expect(fs.readFileSync(path.join(dir, 'calc.mjs'), 'utf8')).toContain('a + b');
});

it('executor: refuses a base the host cannot fetch, and an invalid target', async () => {
  repo(false);
  expect((await drain(await new RemoteMakerExecutor(db, 20).start(task(), { workingDirectory: dir, model: 'workstation/atomic', timeout: 1_000 }))).stderr).toMatch(/not on origin\/main/);
  expect((await drain(await new RemoteMakerExecutor(db, 20).start(task(), { workingDirectory: dir, model: 'nonsense', timeout: 1_000 }))).status).toBe('failed');
  expect(parseRemoteTarget('workstation/atomic@llama-router')).toEqual({ host: 'workstation', species: 'atomic@llama-router' });
});

it('executor: an unclaimed job past the queue timeout is cancelled with reason queue_timeout', async () => {
  repo();
  vi.stubEnv('REMOTE_MAKER_TIMEOUT_MS', '150');
  vi.stubEnv('REMOTE_MAKER_QUEUE_TIMEOUT_MS', '150');
  const r = await drain(await new RemoteMakerExecutor(db, 20).start(task(), { workingDirectory: dir, model: 'workstation/atomic', timeout: 150 }));
  expect(r.status).toBe('failed');
  expect(remoteMakerCancelReason(r.stderr)).toBe('queue_timeout');
  expect(db.prepare('SELECT status, reason FROM remote_maker_jobs').get()).toEqual({ status: 'cancelled', reason: 'queue_timeout' });
});

const fixPatch = `diff --git a/calc.mjs b/calc.mjs\n--- a/calc.mjs\n+++ b/calc.mjs\n@@ -1 +1 @@\n-export const add = (a, b) => a - b;\n+export const add = (a, b) => a + b;\n`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function claimSoon(q: RemoteMakerQueue, after: number) {
  await sleep(after);
  for (let i = 0; i < 100; i++) { const job = q.claim('workstation', ['atomic']); if (job) return job; await sleep(10); }
  throw new Error('no job');
}

it('executor: work time counts from the claim — a job claimed late but finished within the work timeout is applied (prod 2026-10-08)', async () => {
  repo();
  vi.stubEnv('REMOTE_MAKER_TIMEOUT_MS', '400');
  vi.stubEnv('REMOTE_MAKER_QUEUE_TIMEOUT_MS', '5000');
  const q = new RemoteMakerQueue(db);
  const session = await new RemoteMakerExecutor(db, 20).start(task(), { workingDirectory: dir, model: 'workstation/atomic', timeout: 100 });
  const worker = (async () => { const job = await claimSoon(q, 600); await sleep(150); q.record(job.id, 'workstation', { status: 'done', patch: fixPatch, reason: 'fixed' }); })();
  const result = await drain(session); await worker;
  expect(result.status).toBe('completed');
  expect(fs.readFileSync(path.join(dir, 'calc.mjs'), 'utf8')).toContain('a + b');
});

it('executor: a claimed job not finished within the work timeout is cancelled with work_timeout; a late result is rejected and recorded', async () => {
  repo();
  vi.stubEnv('REMOTE_MAKER_TIMEOUT_MS', '200');
  vi.stubEnv('REMOTE_MAKER_QUEUE_TIMEOUT_MS', '5000');
  const q = new RemoteMakerQueue(db);
  const session = await new RemoteMakerExecutor(db, 20).start(task(), { workingDirectory: dir, model: 'workstation/atomic', timeout: 100 });
  const draining = drain(session); // the job is enqueued once the events are consumed
  const job = await claimSoon(q, 0);
  const r = await draining;
  expect(r.status).toBe('failed');
  expect(remoteMakerCancelReason(r.stderr)).toBe('work_timeout');
  expect(q.get(job.id)).toMatchObject({ status: 'cancelled', reason: 'work_timeout' });
  expect(() => q.record(job.id, 'workstation', { status: 'done', patch: fixPatch })).toThrow('MAKER_JOB_NOT_CLAIMED');
  expect(() => q.record(job.id, 'workstation', { status: 'done', patch: fixPatch })).toThrow('MAKER_JOB_NOT_CLAIMED');
  expect(q.get(job.id)).toMatchObject({ status: 'cancelled', reason: 'work_timeout;late_result', patch: null });
});

it('queue: expire() never cancels a job that was claimed after the read, and the daemon wait covers queue + work', () => {
  const q = new RemoteMakerQueue(db);
  const id = q.enqueue('workstation', 'atomic', 'abc', 'x');
  expect(q.expire(id, 60_000, 1, Date.now())).toBeNull(); // fresh queued job: inside the queue window
  q.claim('workstation', ['atomic']);
  expect(q.expire(id, 1, 60_000, Date.now() + 10)).toBeNull(); // queue limit passed, but it is claimed and inside its work window
  expect(q.expire(id, 1, 1, Date.now() + 10)).toBe('work_timeout');
  vi.stubEnv('REMOTE_MAKER_TIMEOUT_MS', '1800000');
  vi.stubEnv('REMOTE_MAKER_QUEUE_TIMEOUT_MS', '2700000');
  expect(remoteMakerWaitMs()).toBe(2_700_000 + 1_800_000 + 60_000);
  expect(remoteMakerCancelReason('maker failed: remote_maker_cancelled:work_timeout')).toBe('work_timeout');
});
