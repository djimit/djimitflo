import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Task } from '@djimitflo/shared';
import { RemoteMakerQueue } from '../services/remote-maker-queue';
import { RemoteMakerExecutor, parseRemoteTarget } from '../execution/executors/remote-maker-executor';

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

it('executor: times out and cancels the job when nobody claims it', async () => {
  repo();
  const r = await drain(await new RemoteMakerExecutor(db, 20).start(task(), { workingDirectory: dir, model: 'workstation/atomic', timeout: 150 }));
  expect(r.status).toBe('failed');
  expect(db.prepare('SELECT status FROM remote_maker_jobs').get()).toEqual({ status: 'cancelled' });
});
