import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { UserRole } from '@djimitflo/shared';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { createTestDb } from './helpers/test-db';
import { createAuthMiddleware } from '../middleware/auth';
import { AuthService } from '../services/auth-service';
import { createHealthRoutes } from '../routes/health';
import { MemoryCandidateService } from '../services/memory-candidate-service';
import { memoryTemplateAnalysis, templateFingerprint } from '../services/memory-template-dedup';

// the knowledge-runtime-service closeLoopLearning lesson template, as written to memory_candidates
const lesson = (run: string, score: string) => `Loop ${run} closed with score ${score} (+0.05 vs previous); preserve checker evidence, gates and runtime artifacts for the next run.`;
const SEVEN = ['0.82', '0.90', '1.00', '0.33', '0.67', '0.75', '0.10'].map((s) => lesson(randomUUID(), s));

const count = (db: Database.Database, sql: string) => (db.prepare(sql).get() as { n: number }).n;
// promoted memory fixture without promote()'s OKF sink write (no filesystem side effects in tests)
const markPromoted = (db: Database.Database, id: string) => db.prepare("UPDATE memory_candidates SET status = 'promoted', promotion_status = 'promoted' WHERE id = ?").run(id);
const judgments = (db: Database.Database) => db.prepare("SELECT * FROM judgments WHERE judgment = 'memory_template_duplicate'").all() as Array<Record<string, any>>;

describe('templateFingerprint', () => {
  it('is equal for the 7 loop-closure variants that differ only in loop id and score', () => {
    expect(new Set(SEVEN.map(templateFingerprint)).size).toBe(1);
    expect(templateFingerprint('Run abc1234f on 2026-10-01T12:00:00Z took 42 s')).toBe(templateFingerprint('Run 9f8e7d6c5b on 2026-10-13 took 7.5 s'));
  });

  it('differs for genuinely different texts', () => {
    const fps = new Set([
      SEVEN[0],
      'Capability tests on codex: the approach failed. Consider a different runtime or split the finding before retrying.',
      'Capability tests on codex: the approach succeeded. Apply the same capability-runtime pairing for similar findings.',
      'All deploys require approval.',
    ].map(templateFingerprint));
    expect(fps.size).toBe(4);
  });
});

describe('MemoryCandidateService.create with MEMORY_TEMPLATE_DEDUP_MODE', () => {
  let db: Database.Database;
  let svc: MemoryCandidateService;
  beforeEach(() => {
    db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(schema); runMigrations(db);
    svc = new MemoryCandidateService(db);
  });
  afterEach(() => { vi.unstubAllEnvs(); db?.close(); });

  it('off (default) records nothing and creates every candidate', () => {
    for (const c of SEVEN) svc.create({ title: 'Loop learning', content: c });
    expect(count(db, 'SELECT COUNT(*) AS n FROM memory_candidates')).toBe(7);
    expect(judgments(db)).toHaveLength(0);
  });

  it('shadow records a memory_template_duplicate judgment (subject = new candidate, refs = matches) and still creates it', () => {
    vi.stubEnv('MEMORY_TEMPLATE_DEDUP_MODE', 'shadow');
    const first = svc.create({ title: 'Loop learning', content: SEVEN[0], source_ref: 'loop:a' });
    markPromoted(db, first.id);
    const second = svc.create({ title: 'Loop learning', content: SEVEN[1], source_ref: 'loop:b' });
    svc.create({ title: 'Other', content: 'All deploys require approval.', memory_type: 'policy_rule' });
    expect(count(db, 'SELECT COUNT(*) AS n FROM memory_candidates')).toBe(3);
    const j = judgments(db);
    expect(j).toHaveLength(1);
    expect(j[0]).toMatchObject({ subject_id: second.id, subject_type: 'memory_candidate', mode: 'shadow', decision: 'would_skip' });
    expect(JSON.parse(j[0].answers_json).refs).toEqual([first.id]);
    expect(svc.get(first.id).status).toBe('promoted'); // matched memory untouched
  });

  it('enforce skips the template-only candidate, returns the existing match and records the skip', () => {
    vi.stubEnv('MEMORY_TEMPLATE_DEDUP_MODE', 'enforce');
    const first = svc.create({ title: 'Loop learning', content: SEVEN[0] });
    const again = svc.create({ title: 'Loop learning', content: SEVEN[1] });
    expect(again.id).toBe(first.id);
    expect(count(db, 'SELECT COUNT(*) AS n FROM memory_candidates')).toBe(1);
    expect(judgments(db)).toMatchObject([{ mode: 'enforce', decision: 'skipped' }]);
  });
});

describe('memoryTemplateAnalysis', () => {
  it('groups template rows across candidates and promoted memories, proposes a consolidation and changes no row', () => {
    const db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(schema); runMigrations(db);
    const svc = new MemoryCandidateService(db);
    const runs = SEVEN.map((_, i) => `run-${i}`);
    const ids = SEVEN.map((c, i) => svc.create({ title: 'Loop learning', content: c, source_ref: `loop:${runs[i]}`, metadata: { loop_run_id: runs[i] } }).id);
    markPromoted(db, ids[0]); markPromoted(db, ids[1]);
    svc.create({ title: 'Policy', content: 'All deploys require approval.', memory_type: 'policy_rule' });
    const snapshot = JSON.stringify(db.prepare('SELECT * FROM memory_candidates ORDER BY id').all());
    const total = count(db, 'SELECT COUNT(*) AS n FROM memory_candidates');

    const a = memoryTemplateAnalysis(db);
    expect(a.group_count).toBe(1);
    const g = a.groups[0];
    expect(g).toMatchObject({ fingerprint: templateFingerprint(SEVEN[0]), size: 7, distinct_source_runs: 7 });
    expect([...g.ids].sort()).toEqual([...ids].sort());
    expect([...g.promoted_ids].sort()).toEqual([ids[0], ids[1]].sort());
    expect(g.candidate_ids).toHaveLength(5);
    expect(g.first_created_at <= g.last_created_at).toBe(true);
    expect(g.proposal.applied).toBe(false);
    expect([...g.proposal.supporting_runs].sort()).toEqual([...runs].sort());
    expect(g.proposal.consolidated_text).toContain('preserve checker evidence');

    expect(count(db, 'SELECT COUNT(*) AS n FROM memory_candidates')).toBe(total);
    expect(JSON.stringify(db.prepare('SELECT * FROM memory_candidates ORDER BY id').all())).toBe(snapshot);
    db.close();
  });

  it('GET /api/health/memory-templates requires read:evidence and returns the analysis', async () => {
    const db = createTestDb();
    const authService = new AuthService(db);
    const auth = createAuthMiddleware(authService);
    const viewer = authService.generateToken(authService.createUser('mt-viewer@example.test', 'disposable-password', UserRole.VIEWER));
    const app = express().use('/api/health', createHealthRoutes(db, auth));
    expect((await request(app).get('/api/health/memory-templates')).status).toBe(401);
    const res = await request(app).get('/api/health/memory-templates').set('Authorization', `Bearer ${viewer}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: 'off', groups: expect.any(Array), group_count: expect.any(Number) });
  });
});
