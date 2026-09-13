import { createHmac } from 'crypto';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Only `gh` is faked — `git` (worktree add/fetch/reset) and the mock
// checker's `spawn('node', ...)` run for real, so this proves the actual
// worktree-materialization pipeline works, not just the plumbing around it.
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

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('GitHub pull_request review webhook (Phase 2: real LLM checker path)', () => {
  let server: Server | undefined;
  let originRepo: string | undefined;
  let repoPath: string | undefined;
  let worktreeRoot: string | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
    for (const dir of [originRepo, repoPath, worktreeRoot]) if (dir) rmSync(dir, { recursive: true, force: true });
    delete process.env.GITHUB_WEBHOOK_SECRET;
    delete process.env.GITHUB_REPOSITORY_PATHS;
    delete process.env.GITHUB_PR_REVIEW_RUNTIME;
    delete process.env.LOOP_WORKTREE_ROOT;
    ghHandler = () => '';
  });

  it('materializes a real worktree at the PR head and drives it through the real mock checker', async () => {
    originRepo = mkdtempSync(join(tmpdir(), 'djimitflo-pr-llm-origin-'));
    git(originRepo, ['init', '-b', 'main']);
    git(originRepo, ['config', 'user.email', 'test@example.local']);
    git(originRepo, ['config', 'user.name', 'Test']);
    writeFileSync(join(originRepo, 'package.json'), '{}\n');
    git(originRepo, ['add', 'package.json']);
    git(originRepo, ['commit', '-m', 'init']);

    // Simulate a PR: a second commit on a throwaway branch, exposed the way
    // GitHub exposes PR heads (refs/pull/<n>/head), then back to main so
    // origin's checked-out HEAD is the base, not the PR branch.
    git(originRepo, ['checkout', '-b', 'feature']);
    writeFileSync(join(originRepo, 'feature.txt'), 'hello from the PR\n');
    git(originRepo, ['add', 'feature.txt']);
    git(originRepo, ['commit', '-m', 'add feature']);
    const prSha = git(originRepo, ['rev-parse', 'HEAD']);
    git(originRepo, ['checkout', 'main']);
    git(originRepo, ['update-ref', 'refs/pull/9/head', prSha]);

    repoPath = mkdtempSync(join(tmpdir(), 'djimitflo-pr-llm-clone-'));
    rmSync(repoPath, { recursive: true, force: true });
    execFileSync('git', ['clone', originRepo, repoPath], { encoding: 'utf8' });
    // clone does not carry over local (non---global) author identity, and a
    // CI runner may have no --global identity configured at all — set it
    // locally so createWorktree()'s internal commit doesn't fail there.
    git(repoPath, ['config', 'user.email', 'test@example.local']);
    git(repoPath, ['config', 'user.name', 'Test']);
    worktreeRoot = mkdtempSync(join(tmpdir(), 'djimitflo-pr-llm-worktrees-'));

    process.env.GITHUB_WEBHOOK_SECRET = 'test-secret';
    process.env.GITHUB_REPOSITORY_PATHS = JSON.stringify({ 'owner/repo': repoPath });
    process.env.GITHUB_PR_REVIEW_RUNTIME = 'mock';
    process.env.LOOP_WORKTREE_ROOT = worktreeRoot;

    ghHandler = (args) => {
      if (args[0] === 'pr' && args[1] === 'diff') return 'diff --git a/feature.txt b/feature.txt\n+hello from the PR\n';
      if (args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify({ title: 'Add feature', url: 'https://github.com/owner/repo/pull/9', additions: 1, deletions: 0, changedFiles: 1, files: [{ path: 'feature.txt' }] });
      }
      if (args[0] === 'pr' && args[1] === 'comment') return '';
      if (args[0] === 'api') return JSON.stringify({ id: 999 });
      throw new Error(`unexpected gh invocation: ${args.join(' ')}`);
    };

    const db = createTestDb();
    const app = express();
    app.use('/github/webhook', createGitHubWebhookRoutes(db));
    server = await new Promise<Server>((resolve) => { const listening = app.listen(0, () => resolve(listening)); });

    const body = JSON.stringify({
      action: 'opened',
      repository: { full_name: 'owner/repo' },
      pull_request: {
        number: 9, title: 'Add feature',
        html_url: 'https://github.com/owner/repo/pull/9',
        head: { sha: prSha, ref: 'feature' },
        base: { ref: 'main' },
      },
    });
    const signature = `sha256=${createHmac('sha256', 'test-secret').update(body).digest('hex')}`;
    const headers = { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-github-delivery': 'delivery-llm-1', 'x-hub-signature-256': signature };
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/github/webhook`;
    const response = await fetch(url, { method: 'POST', headers, body });
    expect(response.status).toBe(202);
    const payload = await response.json() as any;
    expect(payload.review).toMatchObject({ status: 'pending' });

    const reviewRow = await waitFor(() => {
      const row = db.prepare('SELECT status, check_run_id, loop_run_id, metadata FROM github_pull_request_reviews').get() as any;
      return row && row.status !== 'pending' ? row : undefined;
    });
    if (reviewRow.status !== 'commented') {
      // eslint-disable-next-line no-console
      console.error('Phase 2 review did not complete as expected, metadata:', reviewRow.metadata);
    }
    expect(reviewRow).toMatchObject({ status: 'commented', check_run_id: '999' });

    const leases = db.prepare('SELECT role, status, worktree_path FROM worker_leases WHERE loop_run_id = ? ORDER BY role').all(reviewRow.loop_run_id) as Array<{ role: string; status: string; worktree_path: string | null }>;
    expect(leases).toHaveLength(2);
    const maker = leases.find((l) => l.role === 'maker')!;
    const checker = leases.find((l) => l.role === 'checker')!;
    expect(maker.status).toBe('completed');
    expect(maker.worktree_path).toBeTruthy();
    // The worktree must actually contain the PR's committed change. Tracked
    // files are clean; the only untracked entry is our own .djimitflo/
    // assignment packet, same control-dir convention used elsewhere.
    expect(git(maker.worktree_path!, ['rev-parse', 'HEAD'])).toBe(prSha);
    expect(git(maker.worktree_path!, ['status', '--porcelain=v1', '--', 'feature.txt', 'package.json'])).toBe('');
    expect(checker.status).toBe('completed');

    db.close();
  }, 30_000);
});

async function waitFor<T>(check: () => T | undefined, timeoutMs = 20_000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = check();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('waitFor: timed out');
}
