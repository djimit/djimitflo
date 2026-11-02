import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { UserRole } from '@djimitflo/shared';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { createAuthMiddleware } from '../middleware/auth';
import { AuthService } from '../services/auth-service';
import { createHealthRoutes } from '../routes/health';
import { EVOLUTION_FLAGS } from '../services/evolution-evidence';
import {
  buildTrainingDataset, READINESS_THRESHOLD, refusedOutPath, runTrainingDatasetExport, splitOf, trainingDatasetSummary,
  type OutcomeLadder, type TrainingDataset, type TrainingRow,
} from '../services/training-dataset';

const NOW = Date.parse('2026-10-19T12:00:00Z');
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const SECRET = `ghp_${'a'.repeat(36)}`;
const DIFF = (f: string) => `diff --git a/${f} b/${f}\n-export const x = 1;\n+export const x = 2;\n`;
let db: Database.Database;
let seq = 0;

beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db); seq = 0; });
afterEach(() => { vi.unstubAllEnvs(); db.close(); });

function gymRun(task: Record<string, unknown>, opts: { status?: string; loop?: string; diff?: string; result?: Record<string, unknown>; truncated?: number; redacted?: number } = {}) {
  const id = `gr-${++seq}`;
  db.prepare("INSERT INTO loop_runs (id, loop_name, mode, status, metadata, created_at, updated_at) VALUES (?, ?, 'closed', 'completed', ?, ?, ?)")
    .run(id, opts.loop ?? 'evolution-gym', JSON.stringify({ gym: { species: 'atomic@llama-router', ...task }, gym_result: { status: opts.status ?? 'success', ...(opts.result ?? {}) } }), iso(NOW - DAY), iso(NOW - DAY));
  const diff = opts.diff ?? DIFF(String(task.source));
  db.prepare('INSERT INTO gym_attempt_diffs (run_id, task_key, status, species, sha256, diff, redacted, truncated, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, String(task.commit), opts.status ?? 'success', 'atomic@llama-router', createHash('sha256').update(diff).digest('hex'), diff, opts.redacted ?? 0, opts.truncated ?? 0, iso(NOW - DAY + seq));
  return id;
}

function prodLease(opts: { ref?: string; target?: string; lease?: Record<string, unknown>; run?: Record<string, unknown>; attribution?: string; loop?: string; runId?: string } = {}) {
  const n = ++seq; const runId = opts.runId ?? `pr-${n}`;
  db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, evidence_refs_json, grounding_json, created_at, updated_at)
    VALUES (?, 'feature', 't', 'd', 'r', 'gap_analysis', 'verified', ?, ?, ?, ?)`)
    .run(`si-${n}`, JSON.stringify([opts.ref ?? 'test-gap:foo']), JSON.stringify({ target: opts.target ?? 'packages/server/src/services/foo.ts', artifactPath: 'packages/server/src/__tests__/foo.test.ts' }), iso(NOW - 30 * DAY), iso(NOW - 30 * DAY));
  db.prepare("INSERT INTO goals (id, improvement_id, objective, risk_class, status) VALUES (?, ?, 't', 'low', 'completed')").run(`g-${n}`, `si-${n}`);
  db.prepare("INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, metadata, created_at, updated_at) VALUES (?, ?, ?, 'closed', 'completed', ?, ?, ?)")
    .run(runId, `g-${n}`, opts.loop ?? 'evolve', JSON.stringify(opts.run ?? {}), iso(NOW - 30 * DAY), iso(NOW - 30 * DAY));
  db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES (?, ?, 'maker', 'opencode', 'completed', ?, ?, ?)")
    .run(`l-${n}`, runId, JSON.stringify(opts.lease ?? {}), iso(NOW - 30 * DAY), iso(NOW - 30 * DAY));
  if (opts.attribution) db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at) VALUES (?, 'outcome_attribution', 'loop_run', ?, 'h', 'annotation', ?, 'x', ?)`)
    .run(`j-${n}`, runId, opts.attribution, iso(NOW - 29 * DAY));
  return { runId, lease: `l-${n}` };
}

describe('training dataset rows', () => {
  it('never exports TG-001 runs, canaries, frozen holdout keys or holdout files', () => {
    db.prepare("INSERT INTO gym_holdout (commit_sha, created_at) VALUES ('hold-mined', 'x')").run();
    db.prepare("INSERT INTO gym_mutant_holdout (key, task_json, created_at) VALUES ('mut:hold', ?, 'x')").run(JSON.stringify({ source: 'packages/server/src/services/frozen.ts' }));
    db.prepare("INSERT INTO gym_write_test_holdout (key, task_json, created_at) VALUES ('fail:pr-frozen', ?, 'x')").run(JSON.stringify({ source: 'a.test.ts', target: 'packages/server/src/services/wt.ts' }));
    db.prepare("INSERT INTO tg_attempts (id, experiment_id, task_key, arm, seq, status, updated_at) VALUES ('t1', 'e', 'fail:tg-task', 'A', 1, 'done', 'x')").run();
    gymRun({ commit: 'hold-mined', source: 'packages/server/src/services/a.ts' });
    gymRun({ commit: 'mut:hold', source: 'packages/server/src/services/b.ts' });
    gymRun({ commit: 'fail:tg-task', kind: 'write_test', source: 'x.test.ts', target: 'packages/server/src/services/c.ts' });
    gymRun({ commit: 'c-tg', source: 'packages/server/src/services/d.ts' }, { loop: 'tg-001' });
    gymRun({ commit: 'c-tg2', source: 'packages/server/src/services/d.ts', tg: { attempt_id: 'x' } });
    gymRun({ commit: 'c-canary', source: 'packages/server/src/services/e.ts', canary: 1 });
    gymRun({ commit: 'mut:other', source: 'packages/server/src/services/frozen.ts' }); // a non-frozen key on a frozen file
    prodLease({ runId: 'pr-frozen' }); // its failure is a frozen write_test task
    prodLease({ target: 'packages/server/src/services/wt.ts' });
    prodLease({ loop: 'tg-001' });
    const ok = gymRun({ commit: 'c-ok', source: 'packages/server/src/services/ok.ts' });

    const ds = buildTrainingDataset(db, { now: NOW });
    expect(ds.rows.map((r) => r.ref)).toEqual([`loop_run:${ok}`]);
    const keys = ds.rows.map((r) => r.task_key);
    for (const k of ['hold-mined', 'mut:hold', 'fail:tg-task', 'c-tg', 'c-tg2', 'c-canary', 'mut:other']) expect(keys).not.toContain(k);
    expect(ds.excluded).toMatchObject({ holdout_key: 4, tg_001: 3, canary: 1, holdout_file: 2 });
  });

  it('splits by the target source file: a file is never in both splits, prod and gym agree', () => {
    for (let i = 0; i < 60; i++) {
      const f = `packages/server/src/services/s${i}.ts`;
      gymRun({ commit: `c${i}a`, source: f }); gymRun({ commit: `c${i}b`, source: f }, { status: 'failure' });
      prodLease({ ref: `test-gap:s${i}`, target: f });
    }
    const { rows } = buildTrainingDataset(db, { now: NOW });
    expect(rows).toHaveLength(180);
    const byFile = new Map<string, Set<string>>();
    for (const r of rows) byFile.set(r.target_file, (byFile.get(r.target_file) ?? new Set()).add(r.split));
    expect([...byFile.values()].every((s) => s.size === 1)).toBe(true);
    const splits = new Set(rows.map((r) => r.split));
    expect(splits).toEqual(new Set(['train', 'holdout']));
    expect(rows.every((r) => r.split === splitOf(r.target_file))).toBe(true);
  });

  it('keeps unknown outcome rungs null (never false) and maps merge settlement', () => {
    const unknown = prodLease({ attribution: 'reviewer_failure', run: { pr_url: 'https://github.com/djimit/djimitflo/pull/1', pr_outcome: { state: 'open', checked_at: iso(NOW - DAY) } } });
    const survived = prodLease({ lease: { exit_status: 0, deterministic_checks: [{ exit_status: 0 }], graded: { score: 0.75, kind: 'tests_green' } }, attribution: 'verified',
      run: { pr_url: 'https://github.com/djimit/djimitflo/pull/2', pr_outcome: { state: 'merged', merged_at: iso(NOW - 20 * DAY), settled_at: iso(NOW - 5 * DAY), survived: true, checked_at: iso(NOW - 5 * DAY) } } });
    const closed = prodLease({ lease: { exit_status: 1, deterministic_checks: [{ exit_status: 1 }] }, attribution: 'maker_failure',
      run: { pr_url: 'https://github.com/djimit/djimitflo/pull/3', pr_outcome: { state: 'closed_unmerged', settled_at: iso(NOW - 10 * DAY), checked_at: iso(NOW - 10 * DAY) } } });
    const infra = prodLease({ lease: { exit_status: 0, deterministic_checks: [{ exit_status: 127 }] } });
    const gym = gymRun({ commit: 'g1', source: 'packages/server/src/services/g.ts' });
    const gated = gymRun({ commit: 'g2', source: 'packages/server/src/services/g.ts' }, { result: { prod_gates: { lint: 'pass', 'type-check': 'fail' }, graded: 0.5 } });
    const { rows } = buildTrainingDataset(db, { now: NOW });
    const at = (ref: string) => rows.find((r) => r.ref === ref)!;
    const nulls: OutcomeLadder = { executed_ok: null, prod_gates_pass: null, verified: null, merged: null, survived_14d: null };
    expect(at(`lease:${unknown.lease}`).outcome).toEqual(nulls);
    expect(at(`lease:${survived.lease}`)).toMatchObject({ outcome: { executed_ok: true, prod_gates_pass: true, verified: true, merged: true, survived_14d: true }, graded: 0.75 });
    expect(at(`lease:${closed.lease}`).outcome).toEqual({ executed_ok: false, prod_gates_pass: false, verified: false, merged: false, survived_14d: null });
    expect(at(`lease:${infra.lease}`).outcome).toEqual({ ...nulls, executed_ok: true });
    expect(at(`loop_run:${gym}`)).toMatchObject({ outcome: { ...nulls, executed_ok: true }, graded: null });
    expect(at(`loop_run:${gated}`)).toMatchObject({ outcome: { ...nulls, executed_ok: true, prod_gates_pass: false }, graded: 0.5 });
  });

  it('prod rows without a durably stored diff carry diff null + diff_not_stored; every emitted diff is redacted', () => {
    prodLease();
    const stored = prodLease({ lease: { diff: `+const t = "${SECRET}";\n` } });
    const g = gymRun({ commit: 'g1', source: 'packages/server/src/services/g.ts' }, { diff: `+const t = "${SECRET}";\n` });
    gymRun({ commit: 'g2', source: 'packages/server/src/services/h.ts' }, { truncated: 1 });
    const cut = prodLease({ target: 'packages/server/src/services/cut.ts', lease: { diff: '+partial\n', diff_truncated: true } });
    const ds = buildTrainingDataset(db, { now: NOW });
    const prod = ds.rows.filter((r) => r.source === 'prod');
    expect(prod.filter((r) => r.diff === null).map((r) => r.diff_reason)).toEqual(['diff_not_stored']);
    for (const r of ds.rows.filter((x) => x.diff !== null)) {
      expect(r.diff).not.toContain(SECRET);
      expect(r.diff).toContain('[REDACTED:');
      expect(r.diff_sha256).toBe(createHash('sha256').update(r.diff!).digest('hex'));
      expect(r.redactions).toBeGreaterThan(0);
    }
    expect(ds.rows.map((r) => r.ref)).toEqual(expect.arrayContaining([`lease:${stored.lease}`, `loop_run:${g}`]));
    expect(ds.excluded.truncated).toBe(2);
    expect(ds.rows.some((r) => r.task_key === 'g2')).toBe(false);
    expect(ds.rows.some((r) => r.ref === `lease:${cut.lease}`)).toBe(false);
    expect(trainingDatasetSummary(ds).prod_diff).toEqual({ with_diff: 1, diff_not_stored: 1 });
  });
});

describe('readiness', () => {
  const row = (i: number, split: 'train' | 'holdout', fail: boolean, diff = true): TrainingRow => ({
    source: 'gym', task_key: `t${i}`, lane: 'gym:mined', target_file: `f${i}`, species: null, model: null, diff: diff ? 'd' : null, diff_sha256: null,
    diff_reason: diff ? null : 'diff_not_stored', redactions: 0, graded: null, split, created_at: 'x', ref: `r${i}`,
    outcome: { executed_ok: !fail, prod_gates_pass: null, verified: null, merged: null, survived_14d: null },
  });
  const ds = (rows: TrainingRow[], unavailable: TrainingDataset['unavailable'] = []): TrainingDataset =>
    ({ rows, unavailable, excluded: { tg_001: 0, canary: 0, holdout_key: 0, holdout_file: 0, no_target_file: 0, truncated: 0 } });
  // 300 train rows over 200 tasks (100 tasks twice), 100 failures; 100 holdout tasks
  const ready = () => [
    ...Array.from({ length: 300 }, (_, i) => row(i % 200, 'train', i < 100)),
    ...Array.from({ length: 100 }, (_, i) => row(1000 + i, 'holdout', false)),
  ];

  it('is READY exactly at the pre-registered threshold', () => {
    const s = trainingDatasetSummary(ds(ready()));
    expect(s.readiness.have).toEqual({ train_rows_with_diff: 300, train_tasks: 200, train_failures: 100, holdout_tasks: 100 });
    expect(s.readiness).toMatchObject({ status: 'READY', threshold: READINESS_THRESHOLD, missing: { train_rows_with_diff: 0, train_tasks: 0, train_failures: 0, holdout_tasks: 0 } });
  });

  it('is NOT_READY with the missing amounts; rows without a diff do not count', () => {
    const rows = ready();
    rows[0] = { ...rows[0], diff: null, diff_reason: 'diff_not_stored' }; // one failure row loses its diff
    rows.pop(); // one holdout task fewer
    const s = trainingDatasetSummary(ds(rows));
    expect(s.readiness.status).toBe('NOT_READY');
    expect(s.readiness.missing).toEqual({ train_rows_with_diff: 1, train_tasks: 0, train_failures: 1, holdout_tasks: 1 });
    expect(s.rows_with_diff).toBe(398);
  });

  it('is UNKNOWN (not zero) when a source cannot be read', () => {
    const s = trainingDatasetSummary(ds([], ['gym']));
    expect(s.readiness.status).toBe('UNKNOWN');
    expect(s.totals.gym).toBeNull();
    expect(s.totals.prod).toEqual({ train: { rows: 0, success: 0, failure: 0, unknown: 0 }, holdout: { rows: 0, success: 0, failure: 0, unknown: 0 } });
  });
});

describe('GET /api/health/training-dataset', () => {
  const app = () => {
    const auth = new AuthService(db);
    const admin = auth.generateToken(auth.createUser('tds-admin@example.test', 'disposable-password', UserRole.ADMIN));
    const viewer = auth.generateToken(auth.createUser('tds-viewer@example.test', 'disposable-password', UserRole.VIEWER));
    return { http: express().use('/api/health', createHealthRoutes(db, createAuthMiddleware(auth))), admin, viewer };
  };

  it('is 404 when the flag is off and requires manage:config when shadow; serves counts, never a diff', async () => {
    gymRun({ commit: 'g1', source: 'packages/server/src/services/g.ts' }, { diff: '+unique-diff-marker\n' });
    const { http, admin, viewer } = app();
    vi.stubEnv('TRAINING_DATASET_EXPORT', 'off');
    expect((await request(http).get('/api/health/training-dataset').set('Authorization', `Bearer ${admin}`)).status).toBe(404);
    vi.stubEnv('TRAINING_DATASET_EXPORT', 'shadow');
    expect((await request(http).get('/api/health/training-dataset')).status).toBe(401);
    expect((await request(http).get('/api/health/training-dataset').set('Authorization', `Bearer ${viewer}`)).status).toBe(403);
    const res = await request(http).get('/api/health/training-dataset').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: 'shadow', rows_with_diff: 1, readiness: { status: 'NOT_READY' } });
    expect(JSON.stringify(res.body)).not.toContain('unique-diff-marker');
  });

  it('registers the flag as non-acting in EVOLUTION_FLAGS', () => {
    expect(EVOLUTION_FLAGS).toContainEqual({ name: 'TRAINING_DATASET_EXPORT', acting: false });
  });
});

describe('export CLI', () => {
  const repo = path.resolve(__dirname, '../../../..');
  it('refuses unless shadow, refuses paths under /workspace or the repo, writes JSONL to a new file only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tds-'));
    const dbPath = path.join(dir, 'db.sqlite');
    const file = new Database(dbPath); file.exec(schema); runMigrations(file); file.close();
    const swap = db; db = new Database(dbPath);
    gymRun({ commit: 'g1', source: 'packages/server/src/services/g.ts' });
    db.close(); db = swap;
    const out = path.join(dir, 'out.jsonl');
    const quiet = { log: () => undefined, err: () => undefined };
    const run = (args: string[], env: NodeJS.ProcessEnv) => runTrainingDatasetExport(args, env, repo, quiet.log, quiet.err);
    expect(run(['--db', dbPath, '--out', out], {})).toBe(2);
    expect(run(['--db', dbPath, '--out', out], { TRAINING_DATASET_EXPORT: 'off' })).toBe(2);
    expect(fs.existsSync(out)).toBe(false);
    expect(run(['--db', dbPath, '--out', path.join(repo, 'x.jsonl')], { TRAINING_DATASET_EXPORT: 'shadow' })).toBe(2);
    expect(refusedOutPath('/workspace/data/x.jsonl', repo)).toMatch(/workspace/);
    expect(refusedOutPath(path.join(repo, 'packages/x.jsonl'), repo)).toMatch(/refused/);
    expect(refusedOutPath(out, repo)).toBeNull();
    expect(run(['--db', dbPath], { TRAINING_DATASET_EXPORT: 'shadow' })).toBe(64);
    expect(run(['--db', dbPath, '--out', out], { TRAINING_DATASET_EXPORT: 'shadow' })).toBe(0);
    const lines = fs.readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as TrainingRow);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ source: 'gym', task_key: 'g1', split: splitOf('packages/server/src/services/g.ts') });
    expect(() => run(['--db', dbPath, '--out', out], { TRAINING_DATASET_EXPORT: 'shadow' })).toThrow(/EEXIST/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
