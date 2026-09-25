import { createHmac } from 'crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFileSync: vi.fn() };
});

import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { createTestDb } from './helpers/test-db';
import { createGitHubWebhookRoutes } from '../routes/github-webhooks';

const HEAD_SHA = 'a'.repeat(40);
let lastCommentBody: string | undefined;

function mockGh(prStat: { additions: number; deletions: number; changedFiles: number; files: string[] }, options: { commentFails?: boolean } = {}) {
  lastCommentBody = undefined;
  vi.mocked(execFileSync).mockImplementation(((command: string, args: string[] = []) => {
    if (args[0] === 'pr' && args[1] === 'view') {
      return JSON.stringify({ title: 'Test PR', url: 'https://github.com/owner/repo/pull/7', ...prStat, files: prStat.files.map((path) => ({ path })) });
    }
    if (args[0] === 'pr' && args[1] === 'comment') {
      if (options.commentFails) throw new Error('gh: authentication required');
      const bodyFileIndex = args.indexOf('--body-file');
      if (bodyFileIndex !== -1) lastCommentBody = readFileSync(args[bodyFileIndex + 1], 'utf8');
      return '';
    }
    if (args[0] === 'api') {
      return JSON.stringify({ id: 123456 });
    }
    throw new Error(`unexpected gh invocation: ${command} ${args.join(' ')}`);
  }) as any);
}

describe('GitHub pull_request review webhook', () => {
  let server: Server | undefined;
  let repoPath: string | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });
    delete process.env.GITHUB_WEBHOOK_SECRET;
    delete process.env.GITHUB_REPOSITORY_PATHS;
    delete process.env.ROBOREV_PENDING_PATH;
    vi.mocked(execFileSync).mockReset();
  });

  async function post(body: string, deliveryId: string) {
    const signature = `sha256=${createHmac('sha256', 'test-secret').update(body).digest('hex')}`;
    const headers = { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-github-delivery': deliveryId, 'x-hub-signature-256': signature };
    const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/github/webhook`;
    return fetch(url, { method: 'POST', headers, body });
  }

  function prBody(overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
      action: 'opened',
      repository: { full_name: 'owner/repo' },
      pull_request: {
        number: 7, title: 'Add feature',
        html_url: 'https://github.com/owner/repo/pull/7',
        head: { sha: HEAD_SHA, ref: 'feature-branch' },
        base: { ref: 'main' },
      },
      ...overrides,
    });
  }

  async function setup() {
    const db = createTestDb();
    repoPath = mkdtempSync(join(tmpdir(), 'djimitflo-pr-webhook-'));
    writeFileSync(join(repoPath, 'package.json'), '{}\n');
    process.env.GITHUB_WEBHOOK_SECRET = 'test-secret';
    process.env.GITHUB_REPOSITORY_PATHS = JSON.stringify({ 'owner/repo': repoPath });
    const app = express();
    app.use('/github/webhook', createGitHubWebhookRoutes(db));
    server = await new Promise<Server>((resolve) => { const listening = app.listen(0, () => resolve(listening)); });
    return db;
  }

  it('reviews a small PR as accepted end-to-end through the real checker state machine', async () => {
    const db = await setup();
    mockGh({ additions: 5, deletions: 2, changedFiles: 1, files: ['src/index.ts'] });

    const response = await post(prBody(), 'delivery-pr-1');
    expect(response.status).toBe(202);
    const payload = await response.json() as any;
    expect(payload.review).toMatchObject({ status: 'commented', verdict: 'accepted' });

    const reviewRow = db.prepare('SELECT status, head_sha, pr_number, check_run_id, loop_run_id FROM github_pull_request_reviews').get() as any;
    expect(reviewRow).toMatchObject({ status: 'commented', head_sha: HEAD_SHA, pr_number: 7, check_run_id: '123456' });

    const leases = db.prepare('SELECT role, status FROM worker_leases WHERE loop_run_id = ? ORDER BY role').all(reviewRow.loop_run_id) as Array<{ role: string; status: string }>;
    expect(leases).toEqual([
      { role: 'checker', status: 'completed' },
      { role: 'maker', status: 'completed' },
    ]);

    const commentArgs = vi.mocked(execFileSync).mock.calls.find(([, args]) => Array.isArray(args) && args[0] === 'pr' && args[1] === 'comment');
    expect(commentArgs).toBeTruthy();
    // the bookkeeping run is settled once the verdict is posted, not left 'blocked'
    expect(db.prepare("SELECT status, json_extract(metadata, '$.settled_by') AS by FROM loop_runs WHERE id = ?").get(reviewRow.loop_run_id))
      .toEqual({ status: 'completed', by: 'github-pr-review' });
    db.close();
  });

  it('flags a large PR as needs_revision', async () => {
    const db = await setup();
    mockGh({ additions: 900, deletions: 700, changedFiles: 50, files: Array.from({ length: 50 }, (_, i) => `src/file${i}.ts`) });

    const response = await post(prBody(), 'delivery-pr-2');
    const payload = await response.json() as any;
    expect(payload.review).toMatchObject({ status: 'commented', verdict: 'needs_revision' });
    db.close();
  });

  it('flags PRs touching sensitive-looking paths as needs_revision', async () => {
    const db = await setup();
    mockGh({ additions: 1, deletions: 0, changedFiles: 1, files: ['.env.production'] });

    const response = await post(prBody(), 'delivery-pr-3');
    const payload = await response.json() as any;
    expect(payload.review).toMatchObject({ status: 'commented', verdict: 'needs_revision' });
    db.close();
  });

  it('records a failed review without crashing the webhook when gh fails', async () => {
    const db = await setup();
    mockGh({ additions: 1, deletions: 1, changedFiles: 1, files: ['src/index.ts'] }, { commentFails: true });

    const response = await post(prBody(), 'delivery-pr-4');
    expect(response.status).toBe(202);
    const payload = await response.json() as any;
    expect(payload.review).toMatchObject({ status: 'failed' });
    const reviewRow = db.prepare('SELECT status FROM github_pull_request_reviews').get() as any;
    expect(reviewRow.status).toBe('failed');
    db.close();
  });

  it('does not start a second review for a duplicate delivery', async () => {
    const db = await setup();
    mockGh({ additions: 1, deletions: 1, changedFiles: 1, files: ['src/index.ts'] });

    const body = prBody();
    await post(body, 'delivery-pr-5');
    const callsAfterFirst = vi.mocked(execFileSync).mock.calls.length;
    const second = await post(body, 'delivery-pr-5');
    expect(second.status).toBe(200);
    expect(vi.mocked(execFileSync).mock.calls.length).toBe(callsAfterFirst);
    db.close();
  });

  it('folds matching roborev static findings into the posted comment', async () => {
    const pendingDir = mkdtempSync(join(tmpdir(), 'djimitflo-roborev-pending-'));
    const pendingPath = join(pendingDir, 'pending.jsonl');
    writeFileSync(pendingPath, JSON.stringify({
      repo: 'owner/repo', sha: HEAD_SHA, task_title: 'Polynomial regex on uncontrolled input',
      task_type: 'review_fix', severity: 'high', affected_files: ['src/parser.ts'],
    }) + '\n', 'utf8');
    process.env.ROBOREV_PENDING_PATH = pendingPath; // must be set before setup() constructs the service
    const db = await setup();
    mockGh({ additions: 5, deletions: 2, changedFiles: 1, files: ['src/index.ts'] });

    await post(prBody(), 'delivery-pr-6');
    expect(lastCommentBody).toContain('## Static findings (roborev)');
    expect(lastCommentBody).toContain('Polynomial regex on uncontrolled input');
    expect(lastCommentBody).toContain('src/parser.ts');

    rmSync(pendingDir, { recursive: true, force: true });
    db.close();
  });

  it('omits the roborev section when there are no matching findings', async () => {
    const db = await setup();
    mockGh({ additions: 1, deletions: 1, changedFiles: 1, files: ['src/index.ts'] });
    await post(prBody(), 'delivery-pr-7');
    expect(lastCommentBody).not.toContain('Static findings');
    db.close();
  });
});
