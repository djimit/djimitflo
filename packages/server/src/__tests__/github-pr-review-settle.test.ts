import { createHmac, randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Follow-ups to U3 (#1090), found by its sweep: a PR review whose `gh` call fails never reached settleReviewRun, so its
 * bookkeeping run sat in planning/blocked until queue hygiene reaped it to 'failed' (a loop failure, and dream-state
 * failure_cause input); and an LLM-path maker lease whose next step threw stayed 'prepared' for ever.
 * Only `gh` is faked; `git` runs for real against a throwaway origin.
 */
let ghHandler: (args: string[]) => string = () => '';
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn((command: string, args: string[] = [], options?: any) => {
      if (command === 'gh') return ghHandler(args);
      return (actual as any).execFileSync(command, args, options);
    }),
  };
});

import { createTestDb } from './helpers/test-db';
import { createGitHubWebhookRoutes } from '../routes/github-webhooks';
import { DreamStateService } from '../services/dream-state-service';

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

async function waitFor<T>(check: () => T | undefined, timeoutMs = 20_000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = check();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('waitFor: timed out');
}

describe('PR review bookkeeping runs settle when the review cannot finish', () => {
  let server: Server | undefined;
  const dirs: string[] = [];

  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
    server = undefined;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    for (const key of ['GITHUB_WEBHOOK_SECRET', 'GITHUB_REPOSITORY_PATHS', 'GITHUB_PR_REVIEW_RUNTIME', 'LOOP_WORKTREE_ROOT']) delete process.env[key];
    ghHandler = () => '';
    vi.restoreAllMocks();
  });

  /** origin with main + a PR head at refs/pull/9/head, cloned; returns the clone and the PR head SHA */
  function repo(): { repoPath: string; prSha: string } {
    const origin = mkdtempSync(join(tmpdir(), 'djimitflo-pr-settle-origin-')); dirs.push(origin);
    git(origin, ['init', '-b', 'main']); git(origin, ['config', 'user.email', 't@example.local']); git(origin, ['config', 'user.name', 'T']);
    writeFileSync(join(origin, 'package.json'), '{}\n'); git(origin, ['add', '.']); git(origin, ['commit', '-m', 'init']);
    git(origin, ['checkout', '-b', 'feature']); writeFileSync(join(origin, 'feature.txt'), 'x\n'); git(origin, ['add', '.']); git(origin, ['commit', '-m', 'feature']);
    const prSha = git(origin, ['rev-parse', 'HEAD']);
    git(origin, ['checkout', 'main']); git(origin, ['update-ref', 'refs/pull/9/head', prSha]);
    const repoPath = mkdtempSync(join(tmpdir(), 'djimitflo-pr-settle-clone-')); dirs.push(repoPath);
    rmSync(repoPath, { recursive: true, force: true });
    execFileSync('git', ['clone', origin, repoPath], { encoding: 'utf8' });
    git(repoPath, ['config', 'user.email', 't@example.local']); git(repoPath, ['config', 'user.name', 'T']);
    const worktrees = mkdtempSync(join(tmpdir(), 'djimitflo-pr-settle-wt-')); dirs.push(worktrees);
    process.env.LOOP_WORKTREE_ROOT = worktrees;
    return { repoPath, prSha };
  }

  async function review(repoPath: string, prSha: string) {
    process.env.GITHUB_WEBHOOK_SECRET = 'test-secret';
    process.env.GITHUB_REPOSITORY_PATHS = JSON.stringify({ 'owner/repo': repoPath });
    const db = createTestDb();
    const app = express();
    app.use('/github/webhook', createGitHubWebhookRoutes(db));
    server = await new Promise<Server>((resolve) => { const listening = app.listen(0, () => resolve(listening)); });
    const body = JSON.stringify({
      action: 'opened', repository: { full_name: 'owner/repo' },
      pull_request: { number: 9, title: 'Add feature', html_url: 'https://github.com/owner/repo/pull/9', head: { sha: prSha, ref: 'feature' }, base: { ref: 'main' } },
    });
    const signature = `sha256=${createHmac('sha256', 'test-secret').update(body).digest('hex')}`;
    const headers = { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-github-delivery': randomUUID(), 'x-hub-signature-256': signature };
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/github/webhook`, { method: 'POST', headers, body });
    expect(response.status).toBe(202);
    const row = await waitFor(() => {
      const r = db.prepare('SELECT status, loop_run_id FROM github_pull_request_reviews').get() as { status: string; loop_run_id: string } | undefined;
      return r && r.status !== 'pending' ? r : undefined;
    });
    const run = db.prepare('SELECT id, status, goal_id, metadata FROM loop_runs WHERE id = ?').get(row.loop_run_id) as { id: string; status: string; goal_id: string; metadata: string };
    const goal = db.prepare('SELECT status FROM goals WHERE id = ?').get(run.goal_id) as { status: string };
    const leases = db.prepare('SELECT role, status, json_extract(metadata, \'$.cancellation_reason\') AS reason FROM worker_leases WHERE loop_run_id = ? ORDER BY role').all(run.id);
    return { db, row, run: { ...run, metadata: JSON.parse(run.metadata) }, goal, leases };
  }

  it('Phase 1: gh unavailable → the run is settled cancelled (github_unavailable, environment) at once, goal too, and dream state never judges it', async () => {
    const { repoPath, prSha } = repo();
    ghHandler = (args) => {
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ headRefOid: prSha });
      if (args[0] === 'api' && /\/compare\//.test(args[1])) return JSON.stringify({ merge_base: 'c'.repeat(40), files: [{ filename: 'feature.txt', additions: 1, deletions: 0 }] });
      throw new Error('gh: HTTP 502 Bad Gateway'); // pr comment
    };
    const { db, row, run, goal } = await review(repoPath, prSha);
    expect(row.status).toBe('failed');
    expect(run.status).toBe('cancelled');
    expect(run.metadata).toMatchObject({ synthetic: true, settled_by: 'github-pr-review', settle_reason: 'github_unavailable', failure_class: 'environment' });
    expect(goal.status).toBe('cancelled');
    // even if something later re-opened it as failed, a synthetic run is no failure_cause candidate
    db.exec('CREATE TABLE IF NOT EXISTS judgments (id TEXT PRIMARY KEY, judgment TEXT, subject_type TEXT, subject_id TEXT, decision TEXT, reason TEXT, created_at TEXT)');
    db.prepare("UPDATE loop_runs SET status = 'failed' WHERE id = ?").run(run.id);
    expect(new DreamStateService(db).pendingFailures().map((p) => p.id)).not.toContain(run.id);
    db.close();
  }, 30_000);

  it('LLM path: gh unavailable after the maker lease was prepared → the run is settled github_unavailable', async () => {
    const { repoPath, prSha } = repo();
    process.env.GITHUB_PR_REVIEW_RUNTIME = 'mock';
    ghHandler = () => { throw new Error('gh: could not resolve host api.github.com'); };
    const { db, run } = await review(repoPath, prSha);
    expect(run.status).toBe('cancelled');
    expect(run.metadata).toMatchObject({ settle_reason: 'github_unavailable', failure_class: 'environment' });
    db.close();
  }, 30_000);
});
