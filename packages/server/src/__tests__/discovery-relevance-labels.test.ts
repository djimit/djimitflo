import express from 'express';
import { rateLimit } from 'express-rate-limit';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { UserRole } from '@djimitflo/shared';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { AuthService } from '../services/auth-service';
import { createAuthMiddleware } from '../middleware/auth';
import { errorHandler } from '../middleware/error-handler';
import { createSelfImprovementRoutes } from '../routes/self-improvement';
import { EVAL_SAMPLE_PATH, loadEvalSample, overlapSubset, recordRelevanceLabel, relevanceQueue } from '../services/discovery-relevance-labels';

const DAY = 86_400_000;
const CARD_KEYS = ['note', 'pass', 'ref', 'source', 'title', 'url'];
// strings that only exist in the blind fields (jev verdict, taxonomy/admission state); none may reach a card response
const BLIND = ['JEV-MARKER', 'open_problem', 'CAPABILITY_INFERRED', 'FILTER-MARKER', 'discovery_pending', 'admit', 'protected', '"al"'];

describe('DI-001 blind discovery-relevance labelling', () => {
  const db = new Database(':memory:');
  const originalSecret = process.env.JWT_SECRET;
  const tokens = new Map<UserRole, string>();
  let server: Server; let base: string;
  const sample = loadEvalSample();
  const target = sample.refs[0].ref;
  const rows = () => db.prepare("SELECT * FROM judgments WHERE judgment = 'operator_label' AND state_hash = 'discovery_relevance'").all() as Array<Record<string, unknown>>;
  const call = (role: UserRole | null, path: string, method = 'GET', body?: unknown) => fetch(`${base}${path}`, {
    method, headers: { ...(role ? { authorization: `Bearer ${tokens.get(role)}` } : {}), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const event = (ref: string, agent: string, extra: Record<string, unknown> = {}) => db.prepare(`INSERT INTO external_events (id, event_type, source, dedupe_key, occurred_at, payload)
    VALUES (?, 'discovery.paper', 'bus', ?, ?, ?)`).run(`ev-${ref}`, `discovery:${ref}`, '2026-10-01T00:00:00Z',
    JSON.stringify({ ref, agent, title: `Title of ${ref}`, note: `Abstract of ${ref}`, url: 'javascript:alert(1)', ...extra }));

  beforeAll(async () => {
    process.env.JWT_SECRET = 'relevance-label-test-secret-'.repeat(3);
    db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF');
    const authService = new AuthService(db);
    for (const role of Object.values(UserRole)) tokens.set(role, authService.generateToken(authService.createUser(`${role}@rel.test`, 'Relevance-test-only-password-123!', role)));
    // a protected ref whose stored state carries every blind field: jev verdict, taxonomy match, an admitted unit
    event(target, 'djimitflo-scout', { relevance: 'JEV-MARKER', capabilities: ['FILTER-MARKER'], admission: 'CAPABILITY_INFERRED' });
    db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
      VALUES ('jev-1', 'discovery_relevance', 'discovery_pending', ?, 'h', 'shadow', 'yes', 'JEV-MARKER', '{"relevance":{"choice":"open_problem","confidence":0.9}}', '2026-10-02T00:00:00Z')`).run(target);
    // AL pool: in scope and outside the protected set; plus one out-of-scope source that must never be served
    for (let i = 0; i < 3; i++) event(`arxiv:2609.0000${i}`, 'operator-chatgpt');
    event('arxiv:2609.09999', 'hermes-macmini');
    const auth = createAuthMiddleware(authService);
    const app = express(); app.use(rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: 'draft-8', legacyHeaders: false })); app.use(express.json());
    app.use('/self-improve', auth.requireAuth, createSelfImprovementRoutes(db, auth));
    app.use(errorHandler);
    server = await new Promise((resolve) => { const l = app.listen(0, () => resolve(l)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    db.close();
    if (originalSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = originalSecret;
  });

  it('the manifest is the frozen sample (sha256 verified at load); a tampered copy is refused', () => {
    expect(sample.refs).toHaveLength(340);
    const dir = mkdtempSync(join(tmpdir(), 'di001-'));
    const tampered = join(dir, 'eval-sample.json');
    writeFileSync(tampered, readFileSync(EVAL_SAMPLE_PATH, 'utf8').replace('arxiv:2303.17760', 'arxiv:2303.17761'));
    expect(() => loadEvalSample(tampered)).toThrow('EVAL_SAMPLE_SHA_MISMATCH');
    expect(() => loadEvalSample(EVAL_SAMPLE_PATH, '0'.repeat(64))).toThrow('EVAL_SAMPLE_SHA_MISMATCH');
  });

  it('the overlap subset is 20 % (68), stratified like the sample', () => {
    const overlap = overlapSubset(sample);
    expect(overlap.size).toBe(68);
    const per = (set: Set<string>) => sample.refs.filter((r) => set.has(r.ref)).reduce<Record<string, number>>((a, r) => ({ ...a, [`${r.src}|${r.week}`]: (a[`${r.src}|${r.week}`] ?? 0) + 1 }), {});
    expect(per(overlap)).toEqual({ 'djimitflo-scout|2026-W39': 1, 'djimitflo-scout|2026-W40': 29, 'djimitflo-scout|2026-W41': 26, 'djimitflo-scout|2026-W42': 1, 'operator-chatgpt|2026-W39': 11 });
  });

  it('cards are blind: only title, note, source, link — no jev, filter result, admission or tier; unsafe links replaced', async () => {
    const res = await call(UserRole.VIEWER, '/self-improve/discovery-labels/next?limit=20');
    expect(res.status).toBe(200);
    const body = await res.json() as ReturnType<typeof relevanceQueue>;
    expect(body.cards).toHaveLength(20);
    for (const c of body.cards) { expect(Object.keys(c).sort()).toEqual(CARD_KEYS); expect(c.pass).toBe('first'); expect(sample.refs.some((r) => r.ref === c.ref)).toBe(true); }
    // the order is a per-day shuffle: walk days until the seeded ref is served, checking every card on the way
    let seeded: (typeof body.cards)[number] | undefined;
    for (let d = 0; d < 400 && !seeded; d++) {
      const cards = relevanceQueue(db, 20, Date.now() + d * DAY).cards;
      for (const marker of BLIND) expect(JSON.stringify(cards)).not.toContain(marker);
      seeded = cards.find((c) => c.ref === target);
    }
    expect(seeded).toEqual({ ref: target, pass: 'first', title: `Title of ${target}`, note: `Abstract of ${target}`, source: 'djimitflo-scout', url: `https://arxiv.org/abs/${target.slice(6)}` });
  });

  it('labels are validated at the trust boundary, need write:governance, and record the session actor', async () => {
    const before = rows().length;
    expect((await call(null, '/self-improve/discovery-labels/next')).status).toBe(401);
    for (const role of [UserRole.VIEWER, UserRole.AUDITOR, UserRole.CHECKER, UserRole.MAKER]) {
      expect((await call(role, '/self-improve/discovery-labels', 'POST', { ref: target, pass: 'first', label: 'relevant' })).status, role).toBe(403);
    }
    for (const bad of [{ ref: 'x', pass: 'first', label: 'relevant' }, { ref: target, pass: 'third', label: 'relevant' }, { ref: target, pass: 'first', label: 'yes' },
      { ref: target, pass: 'first', label: 'relevant', seconds: -1 }, { ref: target, pass: 'first', label: 'relevant', seconds: 'a' }]) {
      expect((await call(UserRole.ADMIN, '/self-improve/discovery-labels', 'POST', bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await call(UserRole.ADMIN, '/self-improve/discovery-labels', 'POST', { ref: 'arxiv:2609.09999', pass: 'first', label: 'relevant' })).status).toBe(404); // out of scope
    expect((await call(UserRole.ADMIN, '/self-improve/discovery-labels', 'POST', { ref: 'arxiv:1111.11111', pass: 'first', label: 'relevant' })).status).toBe(404); // unknown
    expect(rows().length).toBe(before);
  });

  it('is idempotent per (ref, pass): a repeat is a no-op, a different answer is refused', async () => {
    const post = (label: string) => call(UserRole.ADMIN, '/self-improve/discovery-labels', 'POST', { ref: target, pass: 'first', label, seconds: 42, actor: 'spoofed' });
    const first = await post('unclear');
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ recorded: true, ref: target, pass: 'first', label: 'unclear' });
    expect((await post('unclear')).status).toBe(200);
    expect((await post('relevant')).status).toBe(409);
    const mine = rows().filter((r) => r.subject_id === target);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ subject_type: 'discovery', mode: 'operator_label', decision: 'unclear', latency_ms: 42_000 });
    const answers = JSON.parse(String(mine[0].answers_json));
    expect(answers).toMatchObject({ label: 'unclear', pass: 'first', sample: 'protected', stratum: `${sample.refs[0].src}|${sample.refs[0].week}`, seconds: 42 });
    expect(answers.actor).not.toBe('spoofed');
    // a re-label too early is refused, and the labelled ref leaves the first-pass queue
    expect((await call(UserRole.ADMIN, '/self-improve/discovery-labels', 'POST', { ref: target, pass: 'relabel', label: 'unclear' })).status).toBe(overlapSubset(sample).has(target) ? 409 : 404);
    const queue = relevanceQueue(db, 20);
    expect(queue.progress.protected).toEqual({ labelled: 1, total: 340 });
    expect(queue.today).toMatchObject({ labels: 1, seconds: 42, median_seconds: 42, target_seconds: 1800, remaining_seconds: 1758, est_cards_left: 41 });
  });

  it('after the protected pass, due re-labels come blind to the first label, then active-learning refs outside the protected set', async () => {
    const eightDaysAgo = Date.now() - 8 * DAY;
    sample.refs.forEach((r, i) => { if (r.ref !== target) recordRelevanceLabel(db, { ref: r.ref, pass: 'first', label: i % 2 ? 'relevant' : 'not_relevant' }, 'op', eightDaysAgo); });
    // the target was labelled today, so its re-label is not due; every other overlap ref is
    const overlap = overlapSubset(sample);
    const q = relevanceQueue(db, 20);
    expect(q.progress.protected.labelled).toBe(340);
    expect(q.progress.relabel.due).toBe(overlap.size - (overlap.has(target) ? 1 : 0));
    expect(q.cards.every((c) => c.pass === 'relabel' && overlap.has(c.ref) && c.ref !== target)).toBe(true);
    const res = await call(UserRole.VIEWER, '/self-improve/discovery-labels/next?limit=20');
    const text = await res.text();
    for (const leak of ['relevant', '"yes"', '"no"', '"unclear"', 'decision']) expect(text).not.toContain(leak);
    const relabel = q.cards[0];
    expect((await call(UserRole.ADMIN, '/self-improve/discovery-labels', 'POST', { ref: relabel.ref, pass: 'relabel', label: 'relevant' })).status).toBe(201);
    expect(rows().filter((r) => r.subject_id === relabel.ref).map((r) => JSON.parse(String(r.answers_json)).pass).sort()).toEqual(['first', 'relabel']);
    // finish the re-labels: only in-scope refs outside the protected set are served next (never the out-of-scope source)
    for (const ref of overlap) if (ref !== target && ref !== relabel.ref) recordRelevanceLabel(db, { ref, pass: 'relabel', label: 'unclear' }, 'op');
    const al = relevanceQueue(db, 20).cards;
    expect(al.map((c) => c.ref).sort()).toEqual(['arxiv:2609.00000', 'arxiv:2609.00001', 'arxiv:2609.00002']);
    expect((await call(UserRole.ADMIN, '/self-improve/discovery-labels', 'POST', { ref: al[0].ref, pass: 'first', label: 'not_relevant' })).status).toBe(201);
    expect(JSON.parse(String(rows().find((r) => r.subject_id === al[0].ref)!.answers_json))).toMatchObject({ sample: 'al', al_cell: 'random' });
    expect(relevanceQueue(db, 20).progress.al.labelled).toBe(1);
  });
});
