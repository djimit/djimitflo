import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import request from 'supertest';
import { createHmac } from 'crypto';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'fs';
import { GithubPrReviewService } from '../services/github-pr-review-service';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { ExecutionEngine } from '../execution/execution-engine';
import { DjimitSecTriggerService } from '../services/djimitsec-trigger-service';
import { createGitHubWebhookRoutes } from '../routes/github-webhooks';
import { errorHandler } from '../middleware/error-handler';
let db: Database.Database, dir: string, engine: ExecutionEngine, service: DjimitSecTriggerService;
const actor = '50f243a9-ce3c-400f-bfad-1805afad1a1e', repositoryId = 'owned/fixture', commit = 'a'.repeat(40), now = new Date('2026-10-28T12:30:00Z');
const push = (sha = commit) => Buffer.from(JSON.stringify({ repository: { full_name: repositoryId }, ref: 'refs/heads/main', after: sha, deleted: false }));
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scan-trigger-test-')); db = new Database(':memory:'); db.exec(schema); runMigrations(db);
  db.prepare('INSERT INTO users(id,email,password_hash,role,is_active) VALUES(?,?,?,?,1)').run(actor, 'fixture@test', 'not-a-login', 'maker');
  db.exec('CREATE TABLE github_webhook_deliveries(id TEXT PRIMARY KEY,event TEXT,source_ref TEXT,payload_sha256 TEXT,result_json TEXT)');
  const path = join(dir, 'policy.json'); writeFileSync(path, JSON.stringify({ principalId: actor, repositories: [{ repositoryId, branch: 'main', intervalMinutes: 60 }], maxPerDay: 2 }), { mode: 0o600 });
  vi.stubEnv('DJIMITSEC_SCAN_TRIGGER_CONFIG', path); vi.stubEnv('DJIMITSEC_SCAN_TRIGGERS', 'execute'); vi.stubEnv('DJIMITSEC_SCAN_MODE', 'execute');
  engine = new ExecutionEngine(db); vi.spyOn(engine, 'executeTask').mockResolvedValue({ status: 'started' }); service = new DjimitSecTriggerService(db, engine);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); db.close(); rmSync(dir, { recursive: true, force: true }); });
it('deduplicates native jobs across duplicate deliveries and the same commit/profile/window, with no automatic redispatch', () => {
  const first = service.webhook('push', 'delivery-1', push(), now)!;
  expect(first.status).toBe('queued'); expect(first.verified).toBe(false);
  expect(service.webhook('push', 'delivery-1', push(), now)?.status).toBe('duplicate');
  expect(service.webhook('push', 'delivery-2', push(), now)?.taskId).toBe(first.taskId);
  expect(engine.executeTask).toHaveBeenCalledTimes(1);
  expect(() => service.webhook('push', 'delivery-1', push('b'.repeat(40)), now)).toThrow('conflicts with retained content');
  const row = db.prepare('SELECT owner_user_id,metadata FROM tasks WHERE id=?').get(first.taskId) as { owner_user_id: string; metadata: string };
  expect(row.owner_user_id).toBe(actor); expect(JSON.parse(row.metadata)).toMatchObject({ executor: 'djimitsec', djimitsecScan: { repositoryId, commit }, djimitsecScanTrigger: { profile: 'static-v1' } });
});
it('refuses forks, unselected branches, bad revisions and inactive or privileged principals', () => {
  const pr = { action: 'opened', repository: { full_name: repositoryId }, pull_request: { base: { ref: 'main', repo: { full_name: repositoryId } }, head: { sha: commit, ref: 'feature/scan', repo: { full_name: 'attacker/fork' } } } };
  expect(service.webhook('pull_request', 'fork', Buffer.from(JSON.stringify(pr)), now)).toMatchObject({ status: 'ignored', reason: 'fork_or_branch' });
  expect(service.webhook('push', 'branch', Buffer.from(push().toString().replace('refs/heads/main', 'refs/heads/private')), now)?.status).toBe('ignored');
  expect(() => service.webhook('push', 'bad-sha', push('main; shell'), now)).toThrow('Invalid bounded scan event');
  for (const update of ["UPDATE users SET is_active=0", "UPDATE users SET is_active=1,role='admin'", "UPDATE users SET role='viewer'"]) { db.exec(update); expect(() => service.webhook('push', 'denied', push(), now)).toThrow('PRINCIPAL_DENIED'); }
  expect(engine.executeTask).not.toHaveBeenCalled();
});
it('uses the exact-byte HMAC gate and preserves existing PR intake alongside the additional scan', async () => {
  vi.stubEnv('GITHUB_WEBHOOK_SECRET', 'fixture-hmac-only');
  const review = vi.spyOn(GithubPrReviewService.prototype, 'startReview').mockReturnValue({ status: 'pending' });
  writeFileSync(join(dir, 'README.md'), 'Fixture only'); vi.stubEnv('GITHUB_REPOSITORY_PATHS', JSON.stringify({ [repositoryId]: dir }));
  const app = express(); app.use('/github/webhook', createGitHubWebhookRoutes(db, () => service)); app.use(errorHandler);
  const body = push().toString(), sign = (s: string) => `sha256=${createHmac('sha256', 'fixture-hmac-only').update(s).digest('hex')}`;
  expect((await request(app).post('/github/webhook').set('Content-Type', 'application/json').set('X-GitHub-Event', 'push').set('X-GitHub-Delivery', 'unsigned').send(body)).status).toBe(401);
  expect(engine.executeTask).not.toHaveBeenCalled();
  const accepted = await request(app).post('/github/webhook').set('Content-Type', 'application/json').set('X-GitHub-Event', 'push').set('X-GitHub-Delivery', 'signed').set('X-Hub-Signature-256', sign(body)).send(body);
  expect(accepted.status).toBe(202); expect(accepted.body.status).toBe('queued');
  const pr = { action: 'opened', repository: { full_name: repositoryId }, pull_request: { number: 1, title: 'Bounded fixture', base: { ref: 'main', repo: { full_name: repositoryId } }, head: { sha: 'b'.repeat(40), ref: 'feature/scan', repo: { full_name: repositoryId } } } };
  db.prepare("UPDATE tasks SET status='completed'").run();
  const sendPr = (value: unknown, delivery: string) => { const text = JSON.stringify(value); return request(app).post('/github/webhook').set('Content-Type','application/json').set('X-GitHub-Event','pull_request').set('X-GitHub-Delivery',delivery).set('X-Hub-Signature-256',sign(text)).send(text); };
  const acceptedPr = await sendPr(pr, 'same-repo-pr');
  expect(acceptedPr.status).toBe(202); expect(acceptedPr.body.repository_scan.status).toBe('queued'); expect(review).toHaveBeenCalledTimes(1);
  expect((await sendPr(pr, 'same-repo-pr')).status).toBe(200); expect(review).toHaveBeenCalledTimes(1);
  const fork = { ...pr, pull_request: { ...pr.pull_request, number: 2, head: { ...pr.pull_request.head, repo: { full_name: 'attacker/fork' } } } };
  expect((await sendPr(fork, 'fork-pr')).body.repository_scan).toMatchObject({ status: 'ignored', reason: 'fork_or_branch' }); expect(review).toHaveBeenCalledTimes(2);
  expect(db.prepare('SELECT COUNT(*) n FROM loop_runs').get()).toEqual({ n: 2 });
  expect(db.prepare('SELECT id FROM github_webhook_deliveries WHERE id IN (?,?) ORDER BY id').all('same-repo-pr','djimitsec:same-repo-pr')).toHaveLength(2);
});
it('reuses cached configured branch SHA on ticks and holds on daily budget, invalid config or missing source', async () => {
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_SYSTEM: '/dev/null' };
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, env: gitEnv, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@test'); writeFileSync(join(dir, 'source.txt'), 'inert'); git('add', 'source.txt'); git('commit', '-m', 'fixture');
  const revision = git('rev-parse', 'HEAD');
  const marker = join(dir, 'fsmonitor-ran'), trace = join(dir, 'inherited-env-trace');
  const monitor = join(dir, 'hostile-monitor'); writeFileSync(monitor, `#!/bin/sh\necho unexpected > '${marker}'\n`, { mode: 0o700 }); git('config', 'core.fsmonitor', monitor);
  vi.stubEnv('GITHUB_TOKEN', 'fixture-only-never-a-real-token'); vi.stubEnv('GIT_DIR', '/definitely-missing-unsafe-override'); vi.stubEnv('GIT_CONFIG_COUNT', '1'); vi.stubEnv('GIT_CONFIG_KEY_0', 'core.fsmonitor'); vi.stubEnv('GIT_CONFIG_VALUE_0', monitor); vi.stubEnv('GIT_TRACE2_EVENT', trace); vi.stubEnv('GIT_TRACE2_ENV_VARS', 'GITHUB_TOKEN');
  vi.stubEnv('GITHUB_REPOSITORY_PATHS', JSON.stringify({ [repositoryId]: dir }));
  const first = (await service.tick(now))[0]; expect(first.status).toBe('queued'); expect(existsSync(marker)).toBe(false); expect(existsSync(trace)).toBe(false); expect((await service.tick(now))[0].status).toBe('duplicate');
  const metadata = JSON.parse((db.prepare('SELECT metadata FROM tasks WHERE id=?').get(first.taskId) as { metadata: string }).metadata);
  expect(metadata.djimitsecScan.commit).toBe(revision); expect(metadata.djimitsecScanTrigger.githubHeadFreshness).toBe('UNKNOWN');
  db.prepare("UPDATE tasks SET status='completed'").run(); expect((await service.tick(new Date(now.getTime() + 3600000)))[0].status).toBe('queued');
  db.prepare("UPDATE tasks SET status='completed'").run(); expect((await service.tick(new Date(now.getTime() + 7200000)))[0]).toMatchObject({ status: 'held', reason: 'daily_budget' });
  vi.stubEnv('GITHUB_REPOSITORY_PATHS', '{}'); expect((await service.tick(now))[0].reason).toBe('repository_unmapped');
  vi.stubEnv('DJIMITSEC_SCAN_TRIGGERS', 'off'); expect(await service.tick(now)).toEqual([]);
});

import { AuthService } from '../services/auth-service';
import { createAuthMiddleware } from '../middleware/auth';
import { createTaskRoutes } from '../routes/tasks';
import type { WebSocketService } from '../services/websocket-service';
it('uses canonical creation audit/notifications and prevents task edits from erasing trigger dedupe/budget history', async () => {
  const broadcast = vi.fn(), ws = { broadcastTaskEvent: broadcast } as unknown as WebSocketService;
  service = new DjimitSecTriggerService(db, engine, ws);
  const queued = service.webhook('push', 'immutable-history', push(), now)!;
  service.webhook('push', 'immutable-history', push(), now);
  expect(broadcast).toHaveBeenCalledTimes(1);
  expect(db.prepare("SELECT COUNT(*) n FROM audit_events WHERE task_id=? AND action='task_created'").get(queued.taskId)).toEqual({ n: 1 });
  const authService = new AuthService(db), auth = createAuthMiddleware(authService), token = authService.generateToken(authService.findUserById(actor)!);
  const app = express(); app.use(express.json()); app.use('/api/tasks', rateLimit({ windowMs: 60000, limit: 300 }), auth.requireAuth, createTaskRoutes(db, engine, auth)); app.use(errorHandler);
  const before = JSON.parse((db.prepare('SELECT metadata FROM tasks WHERE id=?').get(queued.taskId) as { metadata: string }).metadata);
  const changed = await request(app).patch(`/api/tasks/${queued.taskId}`).set('authorization', `Bearer ${token}`).send({ metadata: { executor: 'codex', djimitsecScan: { repositoryId: 'foreign/repo', commit: 'b'.repeat(40) }, djimitsecScanTrigger: { dedupeKey: 'forged' } } });
  expect(changed.status).toBe(200); expect(changed.body.metadata.djimitsecScanTrigger).toEqual(before.djimitsecScanTrigger); expect(changed.body.metadata.djimitsecScan).toEqual(before.djimitsecScan); expect(changed.body.metadata.executor).toBe('djimitsec');
  const created = await request(app).post('/api/tasks').set('authorization', `Bearer ${token}`).send({ title: 'Unprivileged task', description: 'No scan', use_swarm_context: false, metadata: { djimitsecScanTrigger: { dedupeKey: 'forged-budget' } } });
  expect(created.status).toBe(201); expect(created.body.metadata.djimitsecScanTrigger).toBeUndefined();
  expect(service.webhook('push', 'new-delivery-same-scan', push(), now)?.taskId).toBe(queued.taskId); expect(engine.executeTask).toHaveBeenCalledTimes(1);
  let limited = false;
  for (let attempt = 0; attempt < 305; attempt++) {
    const observed = await request(app).get(`/api/tasks/${queued.taskId}`).set('authorization', `Bearer ${token}`);
    if (observed.status === 429) { limited = true; break; }
    expect(observed.status).toBe(200);
  }
  expect(limited).toBe(true);
  expect((await request(app).get(`/api/tasks/${queued.taskId}`)).status).toBe(429);
});
