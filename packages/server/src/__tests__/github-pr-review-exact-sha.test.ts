import { createHash, createHmac } from 'crypto';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * CODE-005 (forensic audit 2026-10-26): the review packet, the evaluation and the published commit status must all be bound
 * to the exact head SHA the webhook named. A head that moves before the packet, during the evaluation or before the status
 * is published holds the review (superseded) — never a green status on a SHA whose material was not the one reviewed.
 *
 * Only `gh` is faked; `git` runs for real against a throwaway origin (Phase 2) so the packet is proven to come from git.
 */
let ghHandler: (args: string[]) => string = () => '';
const ghCalls: string[][] = [];
const statusStates: string[] = [];
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn((command: string, args: string[] = [], options?: any) => {
      if (command === 'gh') {
        ghCalls.push(args);
        if (args[0] === 'api' && /\/statuses\//.test(args[1])) statusStates.push(JSON.parse(String(options?.input ?? '{}')).state);
        return ghHandler(args);
      }
      return (actual as any).execFileSync(command, args, options);
    }),
  };
});

import { createTestDb } from './helpers/test-db';
import { createGitHubWebhookRoutes } from '../routes/github-webhooks';
import { LoopService } from '../services/loop-service';

/** The real checker input: every prompt LoopService builds for a checker runtime. */
const checkerPrompts: string[] = [];
const buildCheckerPrompt = LoopService.prototype.buildCheckerPrompt;
vi.spyOn(LoopService.prototype, 'buildCheckerPrompt').mockImplementation(function (this: LoopService, ...args) {
  const prompt = buildCheckerPrompt.apply(this, args);
  checkerPrompts.push(prompt);
  return prompt;
});

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Successive `gh pr view --json headRefOid` reads return these heads in order; the last one repeats. */
function fakeGh(heads: string[], compare = { merge_base: 'c'.repeat(40), files: [{ filename: 'src/index.ts', additions: 3, deletions: 1 }] }) {
  let reads = 0;
  ghHandler = (args) => {
    if (args[0] === 'pr' && args[1] === 'view' && args.includes('headRefOid')) {
      const head = heads[Math.min(reads, heads.length - 1)]; reads += 1;
      return JSON.stringify({ headRefOid: head });
    }
    if (args[0] === 'api' && /\/compare\//.test(args[1])) return JSON.stringify(compare);
    if (args[0] === 'api' && /\/statuses\//.test(args[1])) return JSON.stringify({ id: 4242 });
    if (args[0] === 'pr' && args[1] === 'comment') return '';
    throw new Error(`unexpected gh invocation: ${args.join(' ')}`);
  };
}

const statusCalls = () => ghCalls.filter((a) => a[0] === 'api' && /\/statuses\//.test(a[1]));
const commentCalls = () => ghCalls.filter((a) => a[0] === 'pr' && a[1] === 'comment');

describe('CODE-005: PR review is bound to the exact head SHA', () => {
  let server: Server | undefined;
  const dirs: string[] = [];

  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
    server = undefined;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    for (const key of ['GITHUB_WEBHOOK_SECRET', 'GITHUB_REPOSITORY_PATHS', 'GITHUB_PR_REVIEW_RUNTIME', 'LOOP_WORKTREE_ROOT']) delete process.env[key];
    ghHandler = () => '';
    ghCalls.length = 0;
    statusStates.length = 0;
    checkerPrompts.length = 0;
  });

  async function serve(repoPath: string) {
    process.env.GITHUB_WEBHOOK_SECRET = 'test-secret';
    process.env.GITHUB_REPOSITORY_PATHS = JSON.stringify({ 'owner/repo': repoPath });
    const db = createTestDb();
    const app = express();
    app.use('/github/webhook', createGitHubWebhookRoutes(db));
    server = await new Promise<Server>((resolve) => { const listening = app.listen(0, () => resolve(listening)); });
    return db;
  }

  async function post(number: number, headSha: string, deliveryId: string) {
    const body = JSON.stringify({
      action: 'synchronize',
      repository: { full_name: 'owner/repo' },
      pull_request: { number, title: 'Add feature', html_url: `https://github.com/owner/repo/pull/${number}`, head: { sha: headSha, ref: 'feature' }, base: { ref: 'main' } },
    });
    const signature = `sha256=${createHmac('sha256', 'test-secret').update(body).digest('hex')}`;
    const headers = { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-github-delivery': deliveryId, 'x-hub-signature-256': signature };
    const response = await fetch(`http://127.0.0.1:${(server!.address() as AddressInfo).port}/github/webhook`, { method: 'POST', headers, body });
    return { status: response.status, payload: await response.json() as any };
  }

  describe('Phase 1 (heuristic, default)', () => {
    async function setup() {
      const repoPath = mkdtempSync(join(tmpdir(), 'djimitflo-pr-sha-p1-'));
      dirs.push(repoPath);
      writeFileSync(join(repoPath, 'package.json'), '{}\n');
      return serve(repoPath);
    }

    it.each([
      ['before the packet is read', [SHA_B], 'before_packet'],
      ['during the evaluation', [SHA_A, SHA_B], 'after_evaluation'],
      ['before the status is published', [SHA_A, SHA_A, SHA_B], 'before_status'],
    ])('a head that moves %s holds the review and publishes no status', async (_label, heads, stage) => {
      const db = await setup();
      fakeGh(heads);
      const { status, payload } = await post(7, SHA_A, `delivery-p1-${stage.replace(/_/g, '-')}`);
      expect(status).toBe(202);
      expect(payload.review).toMatchObject({ status: 'superseded' });
      expect(statusCalls()).toEqual([]);
      if (stage !== 'before_status') expect(commentCalls()).toEqual([]);

      const row = db.prepare('SELECT status, head_sha, metadata FROM github_pull_request_reviews').get() as { status: string; head_sha: string; metadata: string };
      expect(row.status).toBe('completed');
      expect(row.head_sha).toBe(SHA_A);
      expect(JSON.parse(row.metadata)).toMatchObject({ outcome: 'superseded', reviewed_sha: SHA_A, observed_head_sha: SHA_B, stage });
      db.close();
    });

    it('an unchanged head publishes on exactly the reviewed SHA, with the packet read by that SHA and its hash recorded', async () => {
      const db = await setup();
      fakeGh([SHA_A]);
      const { payload } = await post(7, SHA_A, 'delivery-p1-ok');
      expect(payload.review).toMatchObject({ status: 'commented', verdict: 'accepted' });

      expect(statusCalls().map((a) => a[1])).toEqual([`repos/owner/repo/statuses/${SHA_A}`]);
      const compare = ghCalls.filter((a) => a[0] === 'api' && /\/compare\//.test(a[1]));
      expect(compare.map((a) => a[1])).toEqual([`repos/owner/repo/compare/main...${SHA_A}`]);
      // never a read of the PR's moving diff/stats by number
      expect(ghCalls.some((a) => a[0] === 'pr' && a[1] === 'diff')).toBe(false);
      expect(ghCalls.some((a) => a[0] === 'pr' && a[1] === 'view' && !a.includes('headRefOid'))).toBe(false);

      const row = db.prepare('SELECT status, check_run_id, loop_run_id, metadata FROM github_pull_request_reviews').get() as any;
      expect(row).toMatchObject({ status: 'commented', check_run_id: '4242' });
      const meta = JSON.parse(row.metadata);
      expect(meta.reviewed_sha).toBe(SHA_A);
      expect(meta.packet_sha256).toMatch(/^[0-9a-f]{64}$/);
      const runMeta = JSON.parse((db.prepare('SELECT metadata FROM loop_runs WHERE id = ?').get(row.loop_run_id) as { metadata: string }).metadata);
      expect(runMeta.pr_review).toMatchObject({ reviewed_sha: SHA_A, packet_sha256: meta.packet_sha256, outcome: 'published' });
      db.close();
    });
  });

  describe('Phase 2 (real git worktree + mock LLM checker)', () => {
    /**
     * origin: main has `init` then (after the PR branched) `main-only`; the PR branch has commit A (feature.txt) and a later
     * commit B (late.txt). refs/pull/9/head already points at B — the head moved after the webhook named A.
     */
    function setupRepos(featureContent = 'reviewed change at A\n') {
      const origin = mkdtempSync(join(tmpdir(), 'djimitflo-pr-sha-origin-'));
      dirs.push(origin);
      git(origin, ['init', '-b', 'main']);
      git(origin, ['config', 'user.email', 'test@example.local']);
      git(origin, ['config', 'user.name', 'Test']);
      writeFileSync(join(origin, 'package.json'), '{}\n');
      git(origin, ['add', 'package.json']);
      git(origin, ['commit', '-m', 'init']);
      git(origin, ['checkout', '-b', 'feature']);
      writeFileSync(join(origin, 'feature.txt'), featureContent);
      git(origin, ['add', 'feature.txt']);
      git(origin, ['commit', '-m', 'A']);
      const shaA = git(origin, ['rev-parse', 'HEAD']);
      writeFileSync(join(origin, 'late.txt'), 'pushed after the webhook\n');
      git(origin, ['add', 'late.txt']);
      git(origin, ['commit', '-m', 'B']);
      const shaB = git(origin, ['rev-parse', 'HEAD']);
      git(origin, ['checkout', 'main']);
      writeFileSync(join(origin, 'main-only.txt'), 'base moved on\n');
      git(origin, ['add', 'main-only.txt']);
      git(origin, ['commit', '-m', 'main-only']);
      git(origin, ['update-ref', 'refs/pull/9/head', shaB]);

      const clone = mkdtempSync(join(tmpdir(), 'djimitflo-pr-sha-clone-'));
      dirs.push(clone);
      rmSync(clone, { recursive: true, force: true });
      execFileSync('git', ['clone', '--single-branch', '--branch', 'main', origin, clone], { encoding: 'utf8' });
      git(clone, ['config', 'user.email', 'test@example.local']);
      git(clone, ['config', 'user.name', 'Test']);
      const worktrees = mkdtempSync(join(tmpdir(), 'djimitflo-pr-sha-worktrees-'));
      dirs.push(worktrees);
      process.env.GITHUB_PR_REVIEW_RUNTIME = 'mock';
      process.env.LOOP_WORKTREE_ROOT = worktrees;
      return { clone, shaA, shaB };
    }

    async function settled(db: ReturnType<typeof createTestDb>) {
      return waitFor(() => {
        const row = db.prepare('SELECT status, check_run_id, loop_run_id, metadata FROM github_pull_request_reviews').get() as any;
        return row && row.status !== 'pending' ? row : undefined;
      });
    }

    it('the packet is the git diff of the reviewed SHA against its merge base only, and the status lands on that SHA', async () => {
      const { clone, shaA } = setupRepos();
      const db = await serve(clone);
      fakeGh([shaA]);
      expect((await post(9, shaA, 'delivery-p2-ok')).payload.review).toMatchObject({ status: 'pending' });
      const row = await settled(db);
      expect(row, row.metadata).toMatchObject({ status: 'commented', check_run_id: '4242' });

      const maker = db.prepare("SELECT worktree_path, metadata FROM worker_leases WHERE role = 'maker' AND loop_run_id = ?").get(row.loop_run_id) as { worktree_path: string; metadata: string };
      expect(git(maker.worktree_path, ['rev-parse', 'HEAD'])).toBe(shaA);
      const packetPath = JSON.parse(maker.metadata).assignment_packet_file as string;
      const packet = readFileSync(packetPath, 'utf8');
      expect(packet).toContain('+reviewed change at A');
      expect(packet).not.toContain('late.txt'); // B, pushed after the webhook named A
      expect(packet).not.toContain('main-only.txt'); // base moved on; merge-base diff excludes it

      const meta = JSON.parse(row.metadata);
      expect(meta.reviewed_sha).toBe(shaA);
      expect(meta.packet_sha256).toBe(createHash('sha256').update(packet).digest('hex'));
      expect(ghCalls.some((a) => a[0] === 'pr' && a[1] === 'diff')).toBe(false);
      expect(statusCalls().map((a) => a[1])).toEqual([`repos/owner/repo/statuses/${shaA}`]);
      // the real checker input carries the whole hashed packet, not a truncated prefix of it
      expect(checkerPrompts).toHaveLength(1);
      expect(checkerPrompts[0]).toContain(packet);
      db.close();
    }, 30_000);

    it('a packet beyond the checker input limit is never reviewed or published green: insufficient_evidence, no LLM call', async () => {
      // sentinel sits past the 20,000-character boundary at which the checker prompt cuts the assignment packet
      const SENTINEL = 'SENTINEL_BEYOND_CHECKER_PACKET_LIMIT';
      const { clone, shaA } = setupRepos(`${'x'.repeat(100)}\n`.repeat(250) + `${SENTINEL}\n`);
      const db = await serve(clone);
      fakeGh([shaA]);
      await post(9, shaA, 'delivery-p2-oversized');
      const row = await settled(db);

      // either the checker saw the sentinel, or nothing it saw can publish: here it must be the latter
      expect(checkerPrompts.some((p) => p.includes(SENTINEL))).toBe(false);
      expect(checkerPrompts).toEqual([]);
      const meta = JSON.parse(row.metadata);
      expect(meta).toMatchObject({ verdict: 'insufficient_evidence', reason: 'packet_exceeds_checker_input', reviewed_sha: shaA });
      expect(meta.packet_chars).toBeGreaterThan(20_000);
      expect(statusStates).not.toContain('success');
      expect(db.prepare("SELECT COUNT(*) AS n FROM worker_leases WHERE role = 'checker' AND loop_run_id = ?").get(row.loop_run_id)).toEqual({ n: 0 });
      db.close();
    }, 30_000);

    it.each([
      ['before the diff', 0, 'before_packet'],
      ['during the evaluation', 1, 'after_evaluation'],
      ['before the status is published', 2, 'before_status'],
    ])('a head that moves %s holds the review and publishes no status', async (_label, unchangedReads, stage) => {
      const { clone, shaA, shaB } = setupRepos();
      const db = await serve(clone);
      fakeGh([...Array(unchangedReads).fill(shaA), shaB]);
      await post(9, shaA, `delivery-p2-${stage.replace(/_/g, '-')}`);
      const row = await settled(db);
      expect(JSON.parse(row.metadata)).toMatchObject({ outcome: 'superseded', reviewed_sha: shaA, observed_head_sha: shaB, stage });
      expect(row.status).toBe('completed');
      expect(statusCalls()).toEqual([]);
      db.close();
    }, 30_000);
  });
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
