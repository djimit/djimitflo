import express from 'express';
import { rateLimit } from 'express-rate-limit';
import Database from 'better-sqlite3';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { UserRole } from '@djimitflo/shared';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { AuthService } from '../services/auth-service';
import { createAuthMiddleware } from '../middleware/auth';
import { errorHandler } from '../middleware/error-handler';
import { createSelfImprovementRoutes } from '../routes/self-improvement';
import { attributionAuditSample } from '../services/outcome-attribution';

// §16 step 4: adjudicating a sampled attribution is an authenticated operator action (write:governance, like the D5 labels)
const db = new Database(':memory:');
const saved = process.env.JWT_SECRET;
let server: Server; let base = ''; let adminToken = ''; let approverToken = '';

beforeAll(async () => {
  process.env.JWT_SECRET = 'attribution-audit-route-secret-'.repeat(3);
  db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF');
  const authService = new AuthService(db);
  adminToken = authService.generateToken(authService.createUser('admin@audit.test', 'Audit-route-test-password-123!', UserRole.ADMIN));
  approverToken = authService.generateToken(authService.createUser('approver@audit.test', 'Audit-route-test-password-123!', UserRole.APPROVER));
  // attributed last week, so it is in this week's frame whatever day the test runs
  db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
    VALUES ('oa1', 'outcome_attribution', 'loop_run', 'run-1', 'maker_failure', 'annotation', 'maker_failure', 'gate tests_lint_typecheck failed', '{"computed":true}', ?)`)
    .run(new Date(Date.now() - 8 * 86_400_000).toISOString());
  const auth = createAuthMiddleware(authService);
  const app = express(); app.use(rateLimit({ windowMs: 60_000, limit: 600 })); app.use(express.json());
  app.use('/api/self-improve', auth.requireAuth, createSelfImprovementRoutes(db, auth));
  app.use(errorHandler);
  server = await new Promise((resolve) => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/self-improve`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  if (saved === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = saved;
});

const post = (run: string, body: unknown, token?: string) => fetch(`${base}/attribution-audit/${run}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
const labels = () => db.prepare("SELECT subject_id, decision, mode FROM judgments WHERE judgment = 'attribution_audit'").all();

it('§16 step 4: only write:governance may adjudicate; bad verdicts and unsampled runs are refused; the label is stored for the actor', async () => {
  expect(attributionAuditSample(db).items.map((i) => i.run_id)).toEqual(['run-1']);
  expect((await post('run-1', { verdict: 'correct' })).status).toBe(401);
  expect((await post('run-1', { verdict: 'correct' }, approverToken)).status).toBe(403);
  expect(labels()).toEqual([]);
  expect((await post('run-1', { verdict: 'maybe' }, adminToken)).status).toBe(400);
  expect((await post('run-1', { verdict: 'correct', note: 7 }, adminToken)).status).toBe(400);
  expect((await post('run-404', { verdict: 'correct' }, adminToken)).status).toBe(404);
  expect((await post('run-1', { verdict: 'wrong', note: 'the checker did answer' }, adminToken)).status).toBe(204);
  expect(labels()).toEqual([{ subject_id: 'run-1', decision: 'wrong', mode: 'operator_label' }]);
  const inbox = await (await fetch(`${base}/decisions`, { headers: { authorization: `Bearer ${adminToken}` } })).json() as { attribution_audit: { items: Array<{ verdict: string | null }> } };
  expect(inbox.attribution_audit.items[0].verdict).toBe('wrong');
});
