import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { rateLimit } from 'express-rate-limit';
import Database from 'better-sqlite3';
import { UserRole } from '@djimitflo/shared';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { AuthService } from '../services/auth-service';
import { createAuthMiddleware } from '../middleware/auth';
import { errorHandler } from '../middleware/error-handler';
import { createCapabilityRoutes } from '../routes/capabilities';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';
import { checkLoopPrs } from '../services/merge-survival';
import { assignmentContext, assignmentContextMarkdown } from '../services/assignment-context';
import { capabilityFactoryEvidence, recordFactorySpecialist } from '../services/capability-factory';
import { EVOLUTION_FLAGS } from '../services/evolution-evidence';

const TARGET = 'packages/server/src/services/slugify.ts';
const TEST = 'packages/server/src/__tests__/slugify.test.ts';
let db: Database.Database; let repo: string; let admin: string; let viewer: string; let auth: ReturnType<typeof createAuthMiddleware>;

beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'capfac-'));
  fs.mkdirSync(path.join(repo, 'packages/server/src/services'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'packages/server/src/__tests__'), { recursive: true });
  fs.writeFileSync(path.join(repo, TARGET), 'export const slugify = (s: string) => s;\n');
  fs.writeFileSync(path.join(repo, TEST), '// test\n');
  vi.stubEnv('CAPABILITY_FACTORY_MODE', 'on');
  vi.stubEnv('LOOP_DAEMON_REPOSITORY_PATH', repo);
  vi.stubEnv('GITHUB_REPOSITORY', 'o/r');
  const authService = new AuthService(db);
  admin = authService.generateToken(authService.createUser('capfac-admin@example.test', 'disposable-password', UserRole.ADMIN));
  viewer = authService.generateToken(authService.createUser('capfac-viewer@example.test', 'disposable-password', UserRole.VIEWER));
  auth = createAuthMiddleware(authService);
});
afterEach(() => { vi.unstubAllEnvs(); db.close(); fs.rmSync(repo, { recursive: true, force: true }); });

const app = () => express().use(rateLimit({ windowMs: 60_000, limit: 600 })).use(express.json())
  .use('/api/capabilities', auth.requireAuth, createCapabilityRoutes(db, auth)).use(errorHandler);
const body = { title: 'Slugify titles for URLs', description: 'Turn arbitrary titles into lowercase URL slugs with hyphens.', target_file: TARGET, acceptance: TEST };
const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;

function seedValidated(id: string, metadata: Record<string, unknown>) {
  const intel = new SwarmIntelligenceService(db);
  intel.registerCapability({
    id, kind: 'deterministic_harness', owner: 'capability-factory', version: '1', status: 'validated', risk_ceiling: 'low',
    input_schema_ref: 'file', output_schema_ref: 'test', allowed_actions: ['reuse_in_assignment'], forbidden_actions: ['deploy'],
    required_evidence: ['proof:test'], eval_score: 1, removal_strategy: 'deprecate', metadata,
  });
}

it('reuses an existing validated capability on the same target file: no proposal, goal or capability is created', async () => {
  seedValidated('cap-slug', { title: 'URL slug helper', files: [TARGET, TEST], test: TEST });
  const res = await request(app()).post('/api/capabilities/requests').set('Authorization', `Bearer ${admin}`).send(body);
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ status: 'reused', capability: { id: 'cap-slug', status: 'validated' } });
  expect(count('SELECT COUNT(*) AS n FROM self_improvements')).toBe(0);
  expect(count('SELECT COUNT(*) AS n FROM goals')).toBe(0);
  expect(count('SELECT COUNT(*) AS n FROM swarm_capabilities')).toBe(1);
});

it('reuses on deterministic keyword overlap of title/description, not on a weak overlap or a non-validated capability', async () => {
  seedValidated('cap-kw', { title: 'Slugify arbitrary titles', description: 'lowercase hyphens slugs', files: ['packages/server/src/services/other.ts'] });
  const reused = await request(app()).post('/api/capabilities/requests').set('Authorization', `Bearer ${admin}`)
    .send({ ...body, target_file: 'packages/server/src/services/new-slug.ts' });
  expect(reused.body).toMatchObject({ status: 'reused', capability: { id: 'cap-kw' } });
  db.prepare("UPDATE swarm_capabilities SET status = 'candidate'").run();
  const proposed = await request(app()).post('/api/capabilities/requests').set('Authorization', `Bearer ${admin}`)
    .send({ ...body, target_file: 'packages/server/src/services/new-slug.ts' });
  expect(proposed.body.status).toBe('proposed');
});

it('without a match creates exactly one grounded operator_request proposal that is not approved and has no goal', async () => {
  const res = await request(app()).post('/api/capabilities/requests').set('Authorization', `Bearer ${admin}`).send(body);
  expect(res.status).toBe(201);
  expect(res.body).toMatchObject({ status: 'proposed', request_id: expect.any(String), proposal: { source: 'operator_request', status: 'proposed', approvedBy: null } });
  const rows = db.prepare('SELECT * FROM self_improvements').all() as Array<Record<string, string>>;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ source: 'operator_request', status: 'proposed', approved_by: null });
  expect(JSON.parse(rows[0].evidence_refs_json)).toContain(`capability-request:${res.body.request_id}`);
  expect(JSON.parse(rows[0].grounding_json)).toMatchObject({ target: TARGET, artifactPath: TARGET, acceptanceTest: TEST, derived: false });
  expect(rows[0].panel_id).toBeTruthy(); // the normal specialist panel reviews it
  expect(count('SELECT COUNT(*) AS n FROM goals')).toBe(0);
  // the same request again is a duplicate of the open proposal, never a second proposal
  const again = await request(app()).post('/api/capabilities/requests').set('Authorization', `Bearer ${admin}`).send(body);
  expect(again.status).toBe(409);
  expect(count('SELECT COUNT(*) AS n FROM self_improvements')).toBe(1);
});

it('rejects a target outside the repo, a missing file outside packages/*/src, an unregistered repo and a shell-ish acceptance', async () => {
  const post = (b: object) => request(app()).post('/api/capabilities/requests').set('Authorization', `Bearer ${admin}`).send(b);
  expect((await post({ ...body, target_file: '../etc/passwd' })).status).toBe(400);
  expect((await post({ ...body, target_file: 'docs/missing.md' })).status).toBe(400);
  expect((await post({ ...body, repo: 'someone/else' })).status).toBe(400);
  expect((await post({ ...body, acceptance: 'npm test; curl evil' })).status).toBe(400);
  expect((await post({ ...body, acceptance: 'packages/server/src/__tests__/missing.test.ts' })).status).toBe(400);
  expect((await post({ ...body, target_file: 'packages/server/src/services/brand-new.ts', acceptance: 'npm run test -w @djimitflo/server -- slugify' })).status).toBe(201);
  expect(count('SELECT COUNT(*) AS n FROM self_improvements')).toBe(1);
});

async function mergedFactoryRun() {
  const res = await request(app()).post('/api/capabilities/requests').set('Authorization', `Bearer ${admin}`).send(body);
  const proposalId = res.body.proposal.id as string;
  db.prepare(`INSERT INTO goals (id, objective, risk_class, status, metadata, improvement_id, created_at, updated_at)
    VALUES ('g1', 'o', 'low', 'running', ?, ?, datetime('now'), datetime('now'))`).run(JSON.stringify({ source: 'self-improvement', improvement_id: proposalId }), proposalId);
  db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, goal_id, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES ('run1', 'doc-drift-and-small-fix-loop', 'closed', 'completed', 'g1', '[]', '{}', '[]', '[]', ?, '2026-10-28T00:00:00Z', '2026-10-28T00:00:00Z')`)
    .run(JSON.stringify({ pr_url: 'https://github.com/o/r/pull/7' }));
  db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES ('m1', 'run1', 'maker', 'opencode', 'completed', ?, datetime('now'), datetime('now'))")
    .run(JSON.stringify({ model: 'ollama/kimi', changed_files: [TARGET, TEST] }));
  return { requestId: res.body.request_id as string, proposalId };
}
const mergedFetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ state: 'closed', merged_at: '2026-10-29T00:00:00Z', created_at: '2026-10-28T00:00:00Z', merge_commit_sha: 'abc123def' }) })) as unknown as typeof fetch;
const pollEnv = () => ({ ...process.env, GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 't' }) as NodeJS.ProcessEnv;

it('records the chosen maker runtime@model as the run specialist (factory runs only)', async () => {
  await mergedFactoryRun();
  recordFactorySpecialist(db, 'run1', 'g1', 'm1');
  expect(JSON.parse((db.prepare("SELECT metadata FROM loop_runs WHERE id = 'run1'").get() as { metadata: string }).metadata).specialist).toBe('opencode@ollama/kimi');
});

it('a merged factory run registers the capability once, validated, with provenance; survival regression downgrades it', async () => {
  const { requestId, proposalId } = await mergedFactoryRun();
  recordFactorySpecialist(db, 'run1', 'g1', 'm1');
  await checkLoopPrs(db, mergedFetch, pollEnv(), new Date('2026-10-31T00:00:00Z'));
  await checkLoopPrs(db, mergedFetch, pollEnv(), new Date('2026-10-31T06:00:00Z')); // still pending survival: polled again
  const caps = db.prepare("SELECT * FROM swarm_capabilities").all() as Array<{ id: string; status: string; metadata: string }>;
  expect(caps).toHaveLength(1);
  expect(caps[0].status).toBe('validated');
  expect(JSON.parse(caps[0].metadata)).toMatchObject({
    capability_factory: true, title: body.title, files: [TARGET, TEST], test: TEST, specialist: 'opencode@ollama/kimi',
    provenance: { request_id: requestId, proposal_id: proposalId, run_id: 'run1', pr_url: 'https://github.com/o/r/pull/7', merge_sha: 'abc123def', files: [TARGET, TEST], test: TEST },
  });
  expect(capabilityFactoryEvidence(db).requests).toMatchObject({ registered: 1, proposed: 0 });

  // 14 d later the added lines are gone from main: the merge survival regression deprecates it (store's downgrade status)
  const gone = vi.fn(async (url: string) => {
    if (/pulls\/7\/files/.test(url)) return { ok: true, status: 200, json: async () => [{ filename: TARGET, patch: '@@ -0,0 +1 @@\n+export const slugify = (s: string) => s.toLowerCase();' }] };
    if (/pulls\/7\/commits/.test(url)) return { ok: true, status: 200, json: async () => [] };
    if (/contents\//.test(url)) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ state: 'closed', merged_at: '2026-10-29T00:00:00Z', created_at: '2026-10-28T00:00:00Z', merge_commit_sha: 'abc123def' }) };
  }) as unknown as typeof fetch;
  await checkLoopPrs(db, gone, pollEnv(), new Date('2026-11-13T00:00:00Z'));
  expect((db.prepare('SELECT status FROM swarm_capabilities').get() as { status: string }).status).toBe('deprecated');
});

it('the next maker assignment lists the registered capability (matched deterministically, capped at 3)', async () => {
  await mergedFactoryRun();
  await checkLoopPrs(db, mergedFetch, pollEnv(), new Date('2026-10-31T00:00:00Z'));
  db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, evidence_refs_json, grounding_json, created_at, updated_at)
    VALUES ('next', 'feature', 'Use slug helper in titles', 'd', 'r', 'operator_request', 'executing', 0.5, '[]', ?, datetime('now'), datetime('now'))`)
    .run(JSON.stringify({ target: TARGET, artifactPath: TARGET }));
  db.prepare(`INSERT INTO goals (id, objective, risk_class, status, metadata, improvement_id, created_at, updated_at) VALUES ('g2', 'o', 'low', 'running', '{}', 'next', datetime('now'), datetime('now'))`).run();
  const ctx = assignmentContext(db, { id: 'run2', goal_id: 'g2' }, repo, 'maker');
  expect(ctx.capabilities).toEqual([`${body.title} — ${TARGET}, ${TEST} — ${TEST}`]);
  expect(assignmentContextMarkdown(ctx).join('\n')).toContain('## Existing capabilities you can reuse');
  // its own originating goal does not list itself
  expect(assignmentContext(db, { id: 'run1', goal_id: 'g1' }, repo, 'maker').capabilities ?? []).toEqual([]);
  // flag off: the assignment is unchanged
  expect(assignmentContext(db, { id: 'run2', goal_id: 'g2' }, repo, 'maker', {})).toEqual({ examples: [], rules: [] });
});

it('flag off: the request route creates nothing, a merge registers nothing, no specialist is recorded', async () => {
  vi.stubEnv('CAPABILITY_FACTORY_MODE', 'off');
  const res = await request(app()).post('/api/capabilities/requests').set('Authorization', `Bearer ${admin}`).send(body);
  expect(res.status).toBe(404);
  expect(count('SELECT COUNT(*) AS n FROM self_improvements')).toBe(0);
  expect(count("SELECT COUNT(*) AS n FROM judgments WHERE judgment = 'capability_request'")).toBe(0);
  // a factory-shaped run merged while off
  vi.stubEnv('CAPABILITY_FACTORY_MODE', 'on');
  await mergedFactoryRun();
  vi.stubEnv('CAPABILITY_FACTORY_MODE', 'off');
  recordFactorySpecialist(db, 'run1', 'g1', 'm1');
  await checkLoopPrs(db, mergedFetch, pollEnv(), new Date('2026-10-31T00:00:00Z'));
  expect(count('SELECT COUNT(*) AS n FROM swarm_capabilities')).toBe(0);
  expect(JSON.parse((db.prepare("SELECT metadata FROM loop_runs WHERE id = 'run1'").get() as { metadata: string }).metadata).specialist).toBeUndefined();
  expect((await request(app()).get('/api/capabilities/registry').set('Authorization', `Bearer ${viewer}`)).status).toBe(404);
});

it('permissions: POST /requests needs write:governance, GET /registry needs read:evidence', async () => {
  const tagged = { ...auth, requirePermission: (permission: string) => Object.assign(auth.requirePermission(permission), { permission }) };
  const router = createCapabilityRoutes(db, tagged);
  const guard = (p: string) => (router.stack as Array<{ route?: { path: string; stack: Array<{ handle: { permission?: string } }> } }>)
    .find((l) => l.route?.path === p)!.route!.stack[0].handle.permission;
  expect(guard('/requests')).toBe('write:governance');
  expect(guard('/registry')).toBe('read:evidence');

  expect((await request(app()).post('/api/capabilities/requests').send(body)).status).toBe(401);
  expect((await request(app()).post('/api/capabilities/requests').set('Authorization', `Bearer ${viewer}`).send(body)).status).toBe(403);
  expect(count('SELECT COUNT(*) AS n FROM self_improvements')).toBe(0);
  const noRole = express().use(rateLimit({ windowMs: 60_000, limit: 600 })).use((req, _res, next) => { (req as unknown as { user: unknown }).user = { id: 'x', role: 'no-such-role' }; next(); })
    .use('/api/capabilities', createCapabilityRoutes(db, auth)).use(errorHandler);
  expect((await request(noRole).get('/api/capabilities/registry')).status).toBe(403);

  seedValidated('cap-slug', { title: 'URL slug helper', files: [TARGET], test: TEST });
  const found = await request(app()).get('/api/capabilities/registry?q=slug%20helper').set('Authorization', `Bearer ${viewer}`);
  expect(found.status).toBe(200);
  expect(found.body.capabilities.map((c: { id: string }) => c.id)).toEqual(['cap-slug']);
  const byFile = await request(app()).get(`/api/capabilities/registry?q=${encodeURIComponent(TARGET)}`).set('Authorization', `Bearer ${viewer}`);
  expect(byFile.body.capabilities).toHaveLength(1);
});

it('evidence: request counts by status and the flag is listed', async () => {
  seedValidated('cap-slug', { title: 'URL slug helper', files: [TARGET], test: TEST });
  await request(app()).post('/api/capabilities/requests').set('Authorization', `Bearer ${admin}`).send(body); // reused
  await request(app()).post('/api/capabilities/requests').set('Authorization', `Bearer ${admin}`)
    .send({ ...body, title: 'Parse durations', description: 'Parse 5m and 2h strings into milliseconds.', target_file: 'packages/server/src/services/duration.ts', acceptance: 'npm run test -w @djimitflo/server -- duration' });
  const rejected = await request(app()).post('/api/capabilities/requests').set('Authorization', `Bearer ${admin}`)
    .send({ ...body, title: 'Format bytes', description: 'Human readable byte sizes for dashboards.', target_file: 'packages/server/src/services/bytes.ts', acceptance: 'npm run test -w @djimitflo/server -- bytes' });
  db.prepare("UPDATE self_improvements SET status = 'rejected' WHERE id = ?").run(rejected.body.proposal.id);
  expect(capabilityFactoryEvidence(db)).toMatchObject({ mode: 'on', requests: { reused: 1, proposed: 1, in_progress: 0, merged: 0, registered: 0, rejected: 1 } });
  expect(EVOLUTION_FLAGS).toContainEqual({ name: 'CAPABILITY_FACTORY_MODE', acting: true });
});
