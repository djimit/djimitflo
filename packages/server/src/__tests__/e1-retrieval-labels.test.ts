import express from 'express';
import { rateLimit } from 'express-rate-limit';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
import type { ContextResult } from '../services/context-injection-service';
import { scoreE1 } from '../services/retrieval-eval';
import { E1_LABEL_SOURCE, e1LabelQueue, exportE1Labels, generateE1Tasks, loggedQueries, recordE1Label, type E1LabelQueue } from '../services/e1-retrieval-labels';

const SRC = join(__dirname, '..');
const SCORER = join(__dirname, '..', '..', '..', '..', 'scripts', 'e1-rrf-score.mjs');
// strings that exist only in the hidden fields (source, raw score, trust tier, candidate id); none may reach the labeller
const HIDDEN = ['qdrant_swarm', 'djimitkb_search', 'okf_search', 'okf_related', 'experience_retrieval', 'validated', 'approved', 'agent_generated', '0.734251', '13.4421', 'CID-MARKER', 'score', 'trust', 'source'];

const fresh = () => { const db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF'); return db; };
const seedLogs = (db: Database.Database) => {
  const task = db.prepare(`INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode, metadata, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', 'low', 'low', 'dry_run', ?, ?, ?)`);
  for (let i = 0; i < 45; i++) {
    const at = `2026-10-0${1 + (i % 9)}T00:00:${String(i).padStart(2, '0')}Z`;
    const ctx = i === 0 ? '## Context (Swarm + Knowledge)\n\n### a' : '';
    task.run(`task-${i}`, `Task ${i}${i === 3 ? ' single' : ''}`, `Fix thing ${i}${ctx ? `\n\n${ctx}` : ''}`, JSON.stringify({ swarm_context: ctx || undefined, context_snapshot: { sha256: 'x', sources: [] } }), at, at);
  }
  task.run('task-dup', 'Task 1', 'Fix thing 1', JSON.stringify({ context_snapshot: {} }), '2026-10-10T00:00:00Z', '2026-10-10T00:00:00Z'); // same query text
  task.run('task-nolog', 'No retrieval', 'never asked', JSON.stringify({}), '2026-10-10T00:00:00Z', '2026-10-10T00:00:00Z');
  task.run('task-bad', 'Bad', 'bad metadata', '{not json', '2026-10-10T00:00:00Z', '2026-10-10T00:00:00Z');
  db.prepare(`INSERT INTO specialist_panels (id, topic, question, status, risk_class, context_json) VALUES ('panel-1', 'Panel topic', 'Should we?', 'reviewing', 'low', '{"k":1}')`).run();
  db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at)
    VALUES ('kb-1', 'kb_retrieval', 'specialist_panel', 'panel-1', 'p', 'shadow', 'yes', 'p.md@0.31', '2026-10-02T00:00:00Z')`).run();
};
let version = 0; // a later retrieval returns different candidates: frozen tasks must not follow
const collect = async (q: string): Promise<ContextResult[]> => {
  const n = q.length;
  const out: ContextResult[] = [
    { source: 'qdrant_swarm', concept_id: `CID-MARKER-q${n}-${version}`, title: `Memory ${n}`, score: 0.734251, excerpt: `memory text ${n}`, trust_level: 'validated' },
    { source: 'qdrant_swarm', concept_id: `CID-MARKER-r${n}-${version}`, title: `Memory b ${n}`, score: 0.6, excerpt: `memory text b ${n}` },
    { source: 'okf_related', concept_id: `CID-MARKER-o${n}`, title: `Concept ${n} (related)`, score: 0.55, excerpt: 'related body', trust_level: 'agent_generated' },
    { source: 'experience_retrieval', score: 0.4, excerpt: '## Past Experience (advisory observed episodes)\n\n### Observed Success: x' },
  ];
  if (!q.includes('single')) out.push({ source: 'djimitkb_search', title: `KB page ${n}`, score: 13.4421, excerpt: `kb text ${n}`, trust_level: 'approved' });
  return q.includes('single') ? out.filter((c) => c.source === 'qdrant_swarm') : out;
};

describe('E1 blind query-level retrieval labels', () => {
  const db = fresh();
  const originalSecret = process.env.JWT_SECRET;
  const tokens = new Map<UserRole, string>();
  let server: Server; let base: string;
  const labels = () => db.prepare("SELECT * FROM judgments WHERE judgment = 'operator_label' AND state_hash = 'e1_retrieval'").all() as Array<Record<string, unknown>>;
  const call = (role: UserRole | null, path: string, method = 'GET', body?: unknown) => fetch(`${base}${path}`, {
    method, headers: { ...(role ? { authorization: `Bearer ${tokens.get(role)}` } : {}), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  beforeAll(async () => {
    process.env.JWT_SECRET = 'e1-label-test-secret-'.repeat(3);
    seedLogs(db);
    const authService = new AuthService(db);
    for (const role of Object.values(UserRole)) tokens.set(role, authService.generateToken(authService.createUser(`${role}@e1.test`, 'E1-test-only-password-123!', role)));
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

  it('samples logged queries only (task context requests + panel KB lookups), one per distinct text, the stored context stripped', () => {
    const qs = loggedQueries(db);
    expect(qs).toHaveLength(46); // 45 tasks + 1 panel; the duplicate text, the task without a snapshot and bad metadata are not queries
    expect(qs.find((q) => q.id === 'task-0')!.query).toBe('Task 0 Fix thing 0');
    expect(qs.find((q) => q.id === 'panel-1')).toMatchObject({ kind: 'panel_kb', query: 'Panel topic\n{"k":1}' });
    expect(qs.some((q) => q.id === 'task-dup' || q.id === 'task-nolog' || q.id === 'task-bad')).toBe(false);
  });

  it('generates at most 40 tasks in a seeded, reproducible order; single-source snapshots are skipped; the seed is binding', async () => {
    const r = await generateE1Tasks(db, { seed: 7, collect });
    expect(r).toMatchObject({ created: 40, tasks: 40, seed: 7, pool: 46, failed: 0 });
    const origins = () => (db.prepare("SELECT subject_id FROM judgments WHERE judgment = 'e1_retrieval_task' ORDER BY created_at, rowid").all() as Array<{ subject_id: string }>).map((x) => x.subject_id);
    const first = origins();
    expect(first).not.toContain('task_context:task-3'); // its snapshot has one source
    // same seed on a copy → the same sample; another seed → another sample
    const twin = fresh(); seedLogs(twin); await generateE1Tasks(twin, { seed: 7, collect });
    expect((twin.prepare("SELECT subject_id FROM judgments WHERE judgment = 'e1_retrieval_task' ORDER BY created_at, rowid").all() as Array<{ subject_id: string }>).map((x) => x.subject_id)).toEqual(first);
    const other = fresh(); seedLogs(other); await generateE1Tasks(other, { seed: 8, collect });
    expect((other.prepare("SELECT subject_id FROM judgments WHERE judgment = 'e1_retrieval_task' ORDER BY created_at, rowid").all() as Array<{ subject_id: string }>).map((x) => x.subject_id)).not.toEqual(first);
    // a top-up at 40 is a no-op and keeps the recorded seed
    version = 1;
    expect(await generateE1Tasks(db, { seed: 99, collect })).toMatchObject({ created: 0, tasks: 40, seed: 7 });
    expect(origins()).toEqual(first);
    // the export records the seed
    expect(exportE1Labels(db).seed).toBe(7);
  });

  it('the labelling payload is blind: query + handle/title/excerpt in hash order, never source, score, trust tier or id', async () => {
    const res = await call(UserRole.VIEWER, '/self-improve/e1-labels/next');
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const marker of HIDDEN) expect(text, marker).not.toContain(marker);
    const body = JSON.parse(text) as E1LabelQueue;
    expect(Object.keys(body).sort()).toEqual(['progress', 'task']);
    expect(Object.keys(body.task!).sort()).toEqual(['candidates', 'query', 'task_id']);
    for (const c of body.task!.candidates) expect(Object.keys(c).sort()).toEqual(['excerpt', 'handle', 'title']);
    expect(body.task!.candidates).toHaveLength(5);
    expect(body.task!.candidates.map((c) => c.title)).not.toContain(expect.stringContaining('(related)'));
    expect(body.task!.candidates.find((c) => c.excerpt.includes('Observed Success'))!.excerpt).not.toContain('Past Experience');
    expect(body.progress).toEqual({ labelled: 0, tasks: 40, target: 30, max_tasks: 40 });
  });

  it('candidates are frozen: a changed retrieval does not move a task; a tampered snapshot is refused', async () => {
    version = 2;
    const before = e1LabelQueue(db).task!;
    await generateE1Tasks(db, { collect });
    expect(e1LabelQueue(db).task).toEqual(before);
    const row = db.prepare("SELECT id, answers_json FROM judgments WHERE id = ?").get(before.task_id) as { id: string; answers_json: string };
    const tampered = JSON.parse(row.answers_json); tampered.candidates[0].score = 99;
    db.prepare('UPDATE judgments SET answers_json = ? WHERE id = ?').run(JSON.stringify(tampered), row.id);
    expect((await call(UserRole.VIEWER, '/self-improve/e1-labels/next')).status).toBe(503);
    expect((await call(UserRole.ADMIN, '/self-improve/e1-labels/export')).status).toBe(503);
    db.prepare('UPDATE judgments SET answers_json = ? WHERE id = ?').run(row.answers_json, row.id);
    expect(e1LabelQueue(db).task).toEqual(before);
  });

  it('labelling needs write:governance; generate and export need manage:config', async () => {
    const task = e1LabelQueue(db).task!;
    const body = { task_id: task.task_id, relevant: [task.candidates[0].handle] };
    expect((await call(null, '/self-improve/e1-labels/next')).status).toBe(401);
    for (const role of [UserRole.VIEWER, UserRole.AUDITOR, UserRole.CHECKER, UserRole.MAKER, UserRole.APPROVER, UserRole.PLATFORM_ADMIN]) {
      expect((await call(role, '/self-improve/e1-labels', 'POST', body)).status, role).toBe(403);
    }
    for (const role of [UserRole.VIEWER, UserRole.AUDITOR, UserRole.CHECKER, UserRole.MAKER, UserRole.APPROVER]) {
      expect((await call(role, '/self-improve/e1-labels/generate', 'POST', {})).status, role).toBe(403);
      expect((await call(role, '/self-improve/e1-labels/export')).status, role).toBe(403);
    }
    expect((await call(UserRole.PLATFORM_ADMIN, '/self-improve/e1-labels/export')).status).toBe(200);
    // at 40 tasks the generator stops before any retrieval call, so this never reaches a network source
    expect(await (await call(UserRole.ADMIN, '/self-improve/e1-labels/generate', 'POST', { seed: 1 })).json()).toMatchObject({ created: 0, tasks: 40, seed: 7 });
    expect((await call(UserRole.ADMIN, '/self-improve/e1-labels/generate', 'POST', { seed: 'x' })).status).toBe(400);
    expect(labels()).toHaveLength(0);
  });

  it('one label per task, validated at the boundary; the session actor is recorded', async () => {
    const task = e1LabelQueue(db).task!;
    const [a, b] = task.candidates.map((c) => c.handle);
    for (const bad of [{ task_id: 'x', relevant: [a] }, { task_id: task.task_id, relevant: 'a' }, { task_id: task.task_id, relevant: [] },
      { task_id: task.task_id, relevant: [a], none_relevant: true }, { task_id: task.task_id, relevant: [a], seconds: -1 }]) {
      expect((await call(UserRole.ADMIN, '/self-improve/e1-labels', 'POST', bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await call(UserRole.ADMIN, '/self-improve/e1-labels', 'POST', { task_id: task.task_id, relevant: ['hnope'] })).status).toBe(404);
    expect((await call(UserRole.ADMIN, '/self-improve/e1-labels', 'POST', { task_id: '00000000-0000-0000-0000-000000000000', relevant: [a] })).status).toBe(404);
    const post = (relevant: string[]) => call(UserRole.ADMIN, '/self-improve/e1-labels', 'POST', { task_id: task.task_id, relevant, seconds: 20, actor: 'spoofed' });
    expect((await post([b, a])).status).toBe(201);
    expect((await post([a, b])).status).toBe(200);
    expect((await post([a])).status).toBe(409);
    expect((await call(UserRole.ADMIN, '/self-improve/e1-labels', 'POST', { task_id: task.task_id, relevant: [], none_relevant: true })).status).toBe(409);
    const mine = labels().filter((r) => r.subject_id === task.task_id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ subject_type: 'e1_retrieval_query', mode: 'operator_label', decision: 'yes', latency_ms: 20_000 });
    const answers = JSON.parse(String(mine[0].answers_json));
    expect(answers.relevant).toHaveLength(2);
    expect(answers).toMatchObject({ none_relevant: false, label_source: E1_LABEL_SOURCE, seconds: 20 });
    expect(answers.actor).not.toBe('spoofed');
    // the labelled task leaves the queue; progress counts it
    const q = e1LabelQueue(db);
    expect(q.task!.task_id).not.toBe(task.task_id);
    expect(q.progress.labelled).toBe(1);
    // 'none relevant' is an explicit answer
    expect((await call(UserRole.ADMIN, '/self-improve/e1-labels', 'POST', { task_id: q.task!.task_id, relevant: [], none_relevant: true })).status).toBe(201);
    expect(labels().find((r) => r.subject_id === q.task!.task_id)).toMatchObject({ decision: 'no' });
  });

  it('the export is exactly the scorer input (single human source, opaque ids, labelled tasks only) and scores', async () => {
    for (let i = 0; i < 40; i++) {
      const t = e1LabelQueue(db).task; if (!t) break;
      recordE1Label(db, { task_id: t.task_id, relevant: [t.candidates[i % t.candidates.length].handle] }, 'op');
    }
    const res = await call(UserRole.ADMIN, '/self-improve/e1-labels/export');
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const marker of ['CID-MARKER', 'Memory', 'KB page', 'memory text', 'Fix thing', 'Panel topic']) expect(text, marker).not.toContain(marker); // no prod text
    const exp = JSON.parse(text) as ReturnType<typeof exportE1Labels>;
    expect(exp).toMatchObject({ label_source: E1_LABEL_SOURCE, tasks: 40, seed: 7 });
    expect(exp.queries).toHaveLength(40);
    for (const q of exp.queries) {
      expect(Object.keys(q).sort()).toEqual(['candidates', 'id', 'relevant']);
      for (const c of q.candidates) { expect(['id', 'score', 'source', 'trust_level']).toEqual(expect.arrayContaining(Object.keys(c))); expect(typeof c.score).toBe('number'); }
      expect(q.relevant.every((id) => q.candidates.some((c) => c.id === id))).toBe(true);
    }
    expect(exp.queries.find((q) => q.relevant.length === 0)).toBeTruthy(); // the 'none relevant' task is exported (scorer excludes it)
    const report = scoreE1(exp.queries);
    expect(report.n_eligible).toBe(39);
    expect(report.verdict).not.toBe('INSUFFICIENT');
    // the real CLI accepts the file (label source check, one source per run); scoreE1 stubbed so no build is needed
    const dir = mkdtempSync(join(tmpdir(), 'e1-'));
    writeFileSync(join(dir, 'export.json'), text);
    writeFileSync(join(dir, 'stub.cjs'), 'exports.scoreE1 = (q) => ({ n_eligible: q.length, verdict: "STUB" });');
    const out = JSON.parse(execFileSync(process.execPath, [SCORER, join(dir, 'export.json')], { env: { ...process.env, E1_DIST: join(dir, 'stub.cjs') } }).toString());
    expect(out).toMatchObject({ label_source: E1_LABEL_SOURCE, n_input: 40, n_eligible: 40, verdict: 'STUB' });
  });

  it('no prod decision path reads the E1 rows: only the E1 module and its routes name them; every other operator_label reader is narrowed', () => {
    const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? (f === '__tests__' ? [] : files(p)) : p.endsWith('.ts') ? [p] : []; });
    const src = files(SRC).map((p) => ({ p: p.slice(SRC.length + 1), s: readFileSync(p, 'utf8') }));
    expect(src.filter((f) => /e1_retrieval|e1-retrieval-labels/.test(f.s)).map((f) => f.p).sort()).toEqual(['routes/self-improvement.ts', 'services/e1-retrieval-labels.ts']);
    // a reader of operator_label rows must narrow by state_hash / subject_type / a proposal join (E1 labels match none of them);
    // evolution-lineage only counts operator decisions for display
    const loose: string[] = [];
    for (const f of src) {
      if (f.p === 'services/e1-retrieval-labels.ts' || f.p === 'services/evolution-lineage.ts') continue;
      f.s.split('\n').forEach((line, i) => {
        if (!line.includes("'operator_label'") || /^\s*(\*|\/\/)/.test(line) || /INSERT INTO judgments/.test(line)) return;
        const window = f.s.split('\n').slice(Math.max(0, i - 2), i + 3).join('\n');
        if (!/state_hash|subject_type|subject_id = s\.id|judgment = 'attribution_audit'|VALUES/.test(window)) loose.push(`${f.p}:${i + 1}`);
      });
    }
    expect(loose).toEqual([]);
  });
});
