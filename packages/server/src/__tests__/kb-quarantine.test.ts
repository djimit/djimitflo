import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import request from 'supertest';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { ingestKbPages, kbContext, kbPendingSafety, kbQuarantine, releaseKbPage } from '../services/kb-corpus';
import { resetContentSafetyPause } from '../services/content-safety';
import { similarKbPages } from '../services/ace-001';
import { knowledgeOverview } from '../services/knowledge-overview';
import { createRemoteGymRoutes } from '../routes/remote-gym';

/**
 * Operator decision 31-10: before CONTENT_SAFETY_MODEL moves to Llama Guard 4 (3/50 known-safe KB pages flagged S14 on
 * technical code text), a KB page judged 'unsafe' is quarantined — kept with its verdict, not served, reversible — not deleted.
 */
let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  db.exec('CREATE TABLE IF NOT EXISTS proposal_embeddings (proposal_id TEXT PRIMARY KEY, model TEXT NOT NULL, vector BLOB NOT NULL, created_at TEXT NOT NULL)');
  vi.stubEnv('NVIDIA_API_KEY', 'k'); vi.stubEnv('CONTENT_SAFETY_MODE', 'shadow'); vi.stubEnv('KB_CONTEXT_ENABLED', 'true');
  resetContentSafetyPause();
});
afterEach(() => { vi.unstubAllEnvs(); db.close(); });

// embeddings: everything about "retry" points one way; Llama Guard flags any text containing "rm -rf" as S14
const fake = vi.fn(async (url: string, init: { body: string }) => {
  const body = JSON.parse(init.body);
  if (String(url).endsWith('/embeddings')) return { ok: true, json: async () => ({ data: [{ embedding: /retry/i.test(body.input[0]) ? [1, 0] : [0, 1] }] }) };
  const text = body.messages?.[0]?.content ?? '';
  return { ok: true, json: async () => ({ choices: [{ message: { content: /rm -rf/.test(text) ? 'unsafe\nS14' : 'safe' } }] }) };
}) as unknown as typeof fetch;
const safetyCalls = () => (fake as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((c) => String(c[0]).endsWith('/chat/completions')).length;
const FLAGGED = { path: 'concepts/retry-cleanup.md', title: 'Retry cleanup', body: 'Retry the job, then `rm -rf build/` before the next attempt' };
const FIXED = { ...FLAGGED, body: 'Retry the job, then clean the build directory before the next attempt' };
const served = () => kbContext(db, { type: 'specialist_panel', id: 'p1' }, 'add a retry to the worker', 3, fake);
const row = (p = FLAGGED.path) => db.prepare('SELECT body, quarantined_at, quarantine_reason FROM kb_pages WHERE path = ?').get(p) as { body: string; quarantined_at: string | null; quarantine_reason: string | null } | undefined;

it('an unsafe verdict on ingest keeps the page in the DB, quarantined with its verdict and categories, and it is not served', async () => {
  expect(await ingestKbPages(db, 'workstation', [FLAGGED], fake)).toEqual({ accepted: [], pending: [], unsafe: [FLAGGED.path], failed: [] });
  const r = row();
  expect(r?.body).toBe(FLAGGED.body);
  expect(r?.quarantined_at).toBeTruthy();
  expect(r?.quarantine_reason).toBe('verdict=unsafe categories=S14');
  expect(await served()).toBeNull(); // panels (kbContext)
  // makers (ACE R=1 context): the quarantined page is not offered either
  const v = new Float32Array([1, 0]);
  db.prepare('INSERT INTO proposal_embeddings (proposal_id, model, vector, created_at) VALUES (?, ?, ?, ?)').run('goal-1', 'test', Buffer.from(v.buffer), new Date().toISOString());
  expect(similarKbPages(db, 'goal-1')).toEqual([]);
  // re-sent unchanged by kb-sync (it never remembers unsafe pages): stays quarantined, no second safety call
  const calls = safetyCalls();
  expect((await ingestKbPages(db, 'workstation', [FLAGGED], fake)).unsafe).toEqual([FLAGGED.path]);
  expect(safetyCalls()).toBe(calls);
  expect(kbPendingSafety(db, 'workstation')).toEqual({ pending: [], total: 0 }); // judged, so not a pending re-check
});

it('an unsafe verdict on changed text quarantines the page instead of deleting it (the earlier safe text is not served either)', async () => {
  await ingestKbPages(db, 'workstation', [FIXED], fake);
  expect(await served()).toContain(`[kb:${FLAGGED.path}]`);
  expect((await ingestKbPages(db, 'workstation', [FLAGGED], fake)).unsafe).toEqual([FLAGGED.path]);
  expect(row()?.body).toBe(FLAGGED.body);
  expect(row()?.quarantined_at).toBeTruthy();
  expect(await served()).toBeNull();
});

it('an operator release serves the page again, records who released it and why, and survives a re-send', async () => {
  await ingestKbPages(db, 'workstation', [FLAGGED], fake);
  expect(releaseKbPage(db, FLAGGED.path, 'operator@example', 'S14 false positive on a shell snippet')).toEqual({ released: true, path: FLAGGED.path });
  expect(row()?.quarantined_at).toBeNull();
  expect(await served()).toContain(`[kb:${FLAGGED.path}]`);
  const verdict = db.prepare("SELECT decision, mode, model, reason FROM judgments WHERE judgment = 'content_safety' AND subject_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(FLAGGED.path) as Record<string, string>;
  expect(verdict).toMatchObject({ decision: 'yes', mode: 'enforce', model: 'operator' });
  expect(verdict.reason).toContain('operator@example');
  expect(verdict.reason).toContain('S14 false positive');
  expect(verdict.reason).toContain('categories=S14');
  // the release is bound to this exact text: an unchanged re-send is accepted without a new model call
  const calls = safetyCalls();
  expect((await ingestKbPages(db, 'workstation', [FLAGGED], fake)).accepted).toEqual([FLAGGED.path]);
  expect(safetyCalls()).toBe(calls);
  expect(() => releaseKbPage(db, FLAGGED.path, 'operator@example', 'again')).toThrow('KB_PAGE_NOT_QUARANTINED');
  expect(() => releaseKbPage(db, 'concepts/none.md', 'operator@example', 'x')).toThrow('KB_PAGE_NOT_FOUND');
});

it('a later safe verdict on changed text clears the quarantine', async () => {
  await ingestKbPages(db, 'workstation', [FLAGGED], fake);
  expect(await ingestKbPages(db, 'workstation', [FIXED], fake)).toEqual({ accepted: [FLAGGED.path], pending: [], unsafe: [], failed: [] });
  expect(row()).toEqual({ body: FIXED.body, quarantined_at: null, quarantine_reason: null });
  expect(await served()).toContain(`[kb:${FLAGGED.path}]`);
});

it('changed text without a verdict (429 / error) does not lift the quarantine', async () => {
  await ingestKbPages(db, 'workstation', [FLAGGED], fake);
  const http500 = vi.fn(async (url: string, init: { body: string }) => String(url).endsWith('/embeddings') ? fake(url, init)
    : { ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) }) as unknown as typeof fetch;
  expect(await ingestKbPages(db, 'workstation', [FIXED], http500)).toEqual({ accepted: [], pending: [FLAGGED.path], unsafe: [], failed: [] });
  expect(row()?.body).toBe(FIXED.body);
  expect(row()?.quarantined_at).toBeTruthy();
  vi.stubEnv('CONTENT_SAFETY_MODE', ''); // no safety regime: an unknown page would be served, a quarantined one still is not
  expect(await served()).toBeNull();
});

it('evidence counts quarantined pages by category (knowledge overview)', async () => {
  await ingestKbPages(db, 'workstation', [FLAGGED, { path: 'concepts/b.md', title: 'b', body: 'rm -rf node_modules' }, { path: 'concepts/ok.md', title: 'ok', body: 'fine' }], fake);
  const q = kbQuarantine(db);
  expect(q.pages).toBe(2);
  expect(q.by_category).toEqual({ S14: 2 });
  expect(q.items.map((i) => i.path).sort()).toEqual(['concepts/b.md', FLAGGED.path]);
  expect(knowledgeOverview(db).kb_quarantine).toMatchObject({ pages: 2, by_category: { S14: 2 } });
});

it('POST /kb/release: needs write:governance and a reason; releases the page', async () => {
  await ingestKbPages(db, 'workstation', [FLAGGED], fake);
  const perms: string[] = [];
  const auth = {
    requireAuth: (req: any, _res: any, next: any) => { req.user = { sub: 'u1', email: 'operator@example' }; next(); },
    requirePermission: (p: string) => (_req: any, res: any, next: any) => { perms.push(p); if (p === 'write:governance') next(); else res.status(403).end(); },
  };
  const app = express(); app.use(rateLimit({ windowMs: 60_000, limit: 600 })); app.use(express.json());
  app.use('/gym-worker', createRemoteGymRoutes(db, auth as never));
  await request(app).post('/gym-worker/kb/release').send({ path: FLAGGED.path }).expect(400);
  await request(app).post('/gym-worker/kb/release').send({ path: 'concepts/none.md', reason: 'x' }).expect(404);
  const res = await request(app).post('/gym-worker/kb/release').send({ path: FLAGGED.path, reason: 'reviewed: S14 false positive' }).expect(200);
  expect(res.body).toEqual({ released: true, path: FLAGGED.path });
  expect(perms).toContain('write:governance');
  await request(app).post('/gym-worker/kb/release').send({ path: FLAGGED.path, reason: 'again' }).expect(409);
  expect(row()?.quarantined_at).toBeNull();
});
