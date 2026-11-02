/**
 * Review of #1056 (CODE-004 follow-up): a GitHub evidence comment that was applied but whose response was lost must
 * not be posted again on later ticks. The per-issue comment outcome is persisted before the POST and reconciled
 * against the issue's comments before any repost; the run report is still persisted.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Database } from 'better-sqlite3';
import { createTestDb } from './helpers/test-db';
import { ReconciliationService } from '../services/reconciliation-service';

const STALE = { number: 37, title: '[Refactor] Reduce complexity in small-service.ts (799 LOC)' };
const timeoutError = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

describe('reconciliation: evidence comment applied, response lost', () => {
  let db: Database;
  let repoRoot: string;
  const env = { ...process.env };

  beforeEach(() => {
    db = createTestDb();
    repoRoot = mkdtempSync(join(tmpdir(), 'reconcile-outcome-'));
    const services = join(repoRoot, 'packages', 'server', 'src', 'services');
    mkdirSync(services, { recursive: true });
    writeFileSync(join(services, 'small-service.ts'), Array(50).fill('// line').join('\n'));
    process.env.GITHUB_REPOSITORY = 'djimit/djimitflo';
    process.env.GITHUB_TOKEN = 'test-token';
  });

  afterEach(() => {
    db.close();
    rmSync(repoRoot, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
    Object.assign(process.env, env);
  });

  /** A GitHub fake: the first comment POST is stored, then the response is lost (timeout). */
  function fakeGitHub(opts: { loseFirstClose?: boolean } = {}) {
    const comments: string[] = [];
    let open = true;
    let commentPosts = 0;
    let closes = 0;
    const fetchImpl = async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.includes('/issues?')) return { ok: true, status: 200, json: async () => (open ? [STALE] : []) };
      if (method === 'GET' && url.includes('/issues/37/comments')) return { ok: true, status: 200, json: async () => comments.map((body) => ({ body })) };
      if (method === 'POST' && url.endsWith('/issues/37/comments')) {
        commentPosts++;
        comments.push(JSON.parse(String(init!.body)).body);
        if (commentPosts === 1) throw timeoutError(); // applied, response lost
        return { ok: true, status: 201, json: async () => ({}) };
      }
      if (method === 'PATCH' && url.endsWith('/issues/37')) {
        closes++;
        if (opts.loseFirstClose && closes === 1) throw timeoutError();
        open = false;
        return { ok: true, status: 200, json: async () => ({}) };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };
    return { fetchImpl, comments, get commentPosts() { return commentPosts; }, get open() { return open; } };
  }

  it('persists the report and the unknown outcome instead of failing the run', async () => {
    const gh = fakeGitHub();
    const svc = new ReconciliationService(db, repoRoot, gh.fetchImpl as any);
    const report = await svc.reconcileGitHub({ apply: true });
    expect(report.closedIssues).toEqual([]);
    expect(svc.latestReport()?.id).toBe(report.id); // the run is recorded, so the same-day slot is used
    expect(db.prepare('SELECT status FROM reconciliation_issue_comments WHERE issue_number = 37').get()).toEqual({ status: 'unknown' });
  });

  it('two runs after a lost comment response: no second comment, the issue is closed after reconciliation', async () => {
    const gh = fakeGitHub();
    const svc = new ReconciliationService(db, repoRoot, gh.fetchImpl as any);
    await svc.reconcileGitHub({ apply: true });
    const second = await svc.reconcileGitHub({ apply: true });
    expect(gh.commentPosts).toBe(1);
    expect(gh.comments).toHaveLength(1);
    expect(second.closedIssues).toEqual([37]);
    expect(gh.open).toBe(false);
    expect(db.prepare('SELECT status FROM reconciliation_issue_comments WHERE issue_number = 37').get()).toEqual({ status: 'posted' });
  });

  it('a posted comment is not reposted when only the close was lost', async () => {
    let posts = 0;
    const gh = fakeGitHub({ loseFirstClose: true });
    const fetchImpl = async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') { posts++; return { ok: true, status: 201, json: async () => ({}) }; }
      return gh.fetchImpl(url, init);
    };
    const svc = new ReconciliationService(db, repoRoot, fetchImpl as any);
    expect((await svc.reconcileGitHub({ apply: true })).closedIssues).toEqual([]);
    expect((await svc.reconcileGitHub({ apply: true })).closedIssues).toEqual([37]);
    expect(posts).toBe(1);
  });

  describe('paginated comments (marker past the first 100)', () => {
    /** 150 comments; the evidence comment from the lost POST is #121, so it is on page 2. */
    function busyIssue(opts: { failPage?: number } = {}) {
      const others = Array.from({ length: 150 }, (_, i) => ({ body: `comment ${i}` }));
      let posts = 0;
      let open = true;
      const fetchImpl = async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (method === 'GET' && url.includes('/issues?')) return { ok: true, status: 200, json: async () => (open ? [STALE] : []) };
        if (method === 'GET' && url.includes('/issues/37/comments')) {
          const u = new URL(url);
          const page = Number(u.searchParams.get('page') ?? '1');
          const perPage = Number(u.searchParams.get('per_page') ?? '30');
          if (page === opts.failPage) return { ok: false, status: 502, json: async () => ({}) };
          return { ok: true, status: 200, json: async () => others.slice((page - 1) * perPage, page * perPage) };
        }
        if (method === 'POST') {
          posts++;
          others.splice(120, 0, { body: JSON.parse(String(init!.body)).body });
          if (posts === 1) throw timeoutError();
          return { ok: true, status: 201, json: async () => ({}) };
        }
        if (method === 'PATCH') { open = false; return { ok: true, status: 200, json: async () => ({}) }; }
        throw new Error(`unexpected ${method} ${url}`);
      };
      return { fetchImpl, get posts() { return posts; }, get open() { return open; } };
    }

    it('finds the marker on a later page and does not repost', async () => {
      const gh = busyIssue();
      const svc = new ReconciliationService(db, repoRoot, gh.fetchImpl as any);
      await svc.reconcileGitHub({ apply: true });
      expect((await svc.reconcileGitHub({ apply: true })).closedIssues).toEqual([37]);
      expect(gh.posts).toBe(1);
    });

    it('keeps unknown and does not post when a later page fails', async () => {
      const gh = busyIssue({ failPage: 2 });
      const svc = new ReconciliationService(db, repoRoot, gh.fetchImpl as any);
      await svc.reconcileGitHub({ apply: true });
      expect((await svc.reconcileGitHub({ apply: true })).closedIssues).toEqual([]);
      expect(gh.posts).toBe(1);
      expect(gh.open).toBe(true);
      expect(db.prepare('SELECT status FROM reconciliation_issue_comments WHERE issue_number = 37').get()).toEqual({ status: 'unknown' });
    });
  });

  it('when the comments cannot be read, an unknown outcome is left alone (no repost, no close)', async () => {
    const gh = fakeGitHub();
    const svc = new ReconciliationService(db, repoRoot, gh.fetchImpl as any);
    await svc.reconcileGitHub({ apply: true });
    const blind = new ReconciliationService(db, repoRoot, (async (url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET' && url.includes('/comments')) return { ok: false, status: 502, json: async () => ({}) };
      return gh.fetchImpl(url, init);
    }) as any);
    const report = await blind.reconcileGitHub({ apply: true });
    expect(report.closedIssues).toEqual([]);
    expect(gh.commentPosts).toBe(1);
    expect(gh.open).toBe(true);
  });
});
