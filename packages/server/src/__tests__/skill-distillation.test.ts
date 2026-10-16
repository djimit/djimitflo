import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import request from 'supertest';
import Database from 'better-sqlite3';
import { UserRole } from '@djimitflo/shared';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { distillSkills, skillCardsView, targetPattern, startSkillDistillation } from '../services/skill-distillation';
import { EVOLUTION_FLAGS } from '../services/evolution-evidence';
import { LoopService, type LoopFinding, type LoopRunRecord } from '../services/loop-service';
import { createHealthRoutes } from '../routes/health';
import { createAuthMiddleware } from '../middleware/auth';
import { AuthService } from '../services/auth-service';

const NOW = Date.parse('2026-10-16T12:00:00Z');
const DAY = 86_400_000;
const iso = (ago: number) => new Date(NOW - ago).toISOString();
const SHADOW = { SKILL_DISTILLATION_MODE: 'shadow' };
let db: Database.Database;

beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db); });
afterEach(() => db.close());

/** One attributed run: proposal → goal → run (+ PR) → maker lease → checker lease → outcome_attribution judgment. */
function seed(id: string, outcome: string, opts: { failed_gates?: string[]; failure_reason?: string; pr_outcome?: Record<string, unknown> } = {}) {
  db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, evidence_refs_json, created_at, updated_at) VALUES (?, 'test_gap', 't', 'd', 'r', 'gap_analysis', 'executing', '[]', ?, ?)`).run(`s-${id}`, iso(30 * DAY), iso(30 * DAY));
  db.prepare(`INSERT INTO goals (id, improvement_id, objective, risk_class, status) VALUES (?, ?, 'o', 'low', 'completed')`).run(`g-${id}`, `s-${id}`);
  const meta = { pr_url: `https://github.com/o/r/pull/${id.length}`, failed_gates: opts.failed_gates ?? [], ...(opts.pr_outcome ? { pr_outcome: opts.pr_outcome } : {}) };
  db.prepare(`INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at) VALUES (?, ?, 'test-gap-loop', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, ?, ?)`)
    .run(id, `g-${id}`, JSON.stringify(meta), iso(30 * DAY), iso(30 * DAY));
  db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata) VALUES (?, ?, 'maker', 'opencode', 'completed', ?)`).run(`m-${id}`, id, JSON.stringify({
    model: 'ollama/kimi-k2.6:cloud', genome_id: 'gen-7', exit_status: 0, completed_at: 'x', diff_lines: 42,
    changed_files: ['packages/server/src/__tests__/a.test.ts', 'packages/server/src/__tests__/b.test.ts'],
    deterministic_checks: [{ name: 'test', status: 'pass' }, { name: 'lint', status: opts.failure_reason ? 'fail' : 'pass' }],
    ...(opts.failure_reason ? { failure_reason: opts.failure_reason } : {}),
  }));
  db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata) VALUES (?, ?, 'checker', 'opencode', 'completed', ?)`).run(`c-${id}`, id, JSON.stringify({ maker_lease_id: `m-${id}`, verdict: 'accepted' }));
  db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at) VALUES (?, 'outcome_attribution', 'loop_run', ?, ?, 'annotation', ?, ?, '{"computed":true}', ?)`)
    .run(`oa-${id}`, id, outcome, outcome, outcome === 'verified' ? 'all gates passed' : 'gate tests_lint_typecheck failed', iso(29 * DAY));
}
const cards = () => db.prepare('SELECT run_id, kind, status, content_sha256 FROM skill_cards ORDER BY run_id').all() as Array<{ run_id: string; kind: string; status: string; content_sha256: string }>;
const card = (id: string) => JSON.parse((db.prepare('SELECT card_json FROM skill_cards WHERE run_id = ?').get(id) as { card_json: string }).card_json);

describe('K4 skill distillation (record-only)', () => {
  it('is off by default: nothing written, no table, the view says unknown (null) rather than 0', () => {
    seed('rv', 'verified');
    expect(distillSkills(db, {}, NOW)).toEqual({ mode: 'off', created: 0, anti_patterns: 0, upgraded: 0 });
    expect(startSkillDistillation(db, {})).toBeNull();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'skill_cards'").get()).toBeUndefined();
    expect(skillCardsView(db, {})).toMatchObject({ mode: 'off', total: null, by_lane: [], latest: [] });
    expect(EVOLUTION_FLAGS).toContainEqual({ name: 'SKILL_DISTILLATION_MODE', acting: false });
  });

  it('a verified run becomes one candidate skill card with shape, checks, verdicts, runtime, genome and provenance', () => {
    seed('rv', 'verified');
    expect(distillSkills(db, SHADOW, NOW)).toMatchObject({ mode: 'shadow', created: 1, anti_patterns: 0 });
    expect(cards()).toEqual([{ run_id: 'rv', kind: 'skill', status: 'candidate', content_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
    expect(card('rv')).toEqual({
      kind: 'skill', lane: 'test-gap-loop', task_kind: 'test_gap', target_pattern: ['packages/server/src/__tests__/*.test.ts'],
      // lines added/removed are not recorded on the lease: null (unknown), never 0
      diff_shape: { files_changed: 2, diff_lines: 42, lines_added: null, lines_removed: null, test_only: true },
      checks_passed: ['test', 'lint'], checker_verdict: { checker: 'accepted', security_checker: null },
      runtime: 'opencode', model: 'ollama/kimi-k2.6:cloud', genome_id: 'gen-7',
      provenance: { proposal_id: 's-rv', run_id: 'rv', lease_id: 'm-rv', pr_url: 'https://github.com/o/r/pull/2', attribution_id: 'oa-rv' },
    });
  });

  it('reviewer_failure and environment_failure runs get no card; maker_failure gets an anti-pattern card', () => {
    seed('rr', 'reviewer_failure', { failed_gates: ['checker_verdict'] });
    seed('re', 'environment_failure', { failed_gates: ['worktree_isolation'] });
    seed('rm', 'maker_failure', { failed_gates: ['tests_lint_typecheck: checks failed'], failure_reason: 'deterministic_checks_failed:lint(exit=1)' });
    expect(distillSkills(db, SHADOW, NOW)).toMatchObject({ created: 0, anti_patterns: 1 });
    expect(cards().map((c) => [c.run_id, c.kind])).toEqual([['rm', 'anti_pattern']]);
    expect(card('rm').failure).toMatchObject({ gate: 'tests_lint_typecheck', signature: expect.stringMatching(/^[0-9a-f]{16}$/), error_class: expect.stringContaining('deterministic_checks_failed') });
    expect(card('rm').checks_passed).toEqual(['test']);
  });

  it('settled survival upgrades the status; a pending PR leaves it candidate', () => {
    seed('rs', 'verified', { pr_outcome: { state: 'merged', merged_at: iso(28 * DAY), checked_at: iso(DAY), settled_at: iso(DAY), survived: true } });
    seed('rg', 'verified', { pr_outcome: { state: 'merged', merged_at: iso(28 * DAY), checked_at: iso(DAY), settled_at: iso(DAY), survived: false } });
    seed('rp', 'verified', { pr_outcome: { state: 'merged', merged_at: iso(3 * DAY), checked_at: iso(DAY) } });
    distillSkills(db, SHADOW, NOW);
    expect(cards().map((c) => [c.run_id, c.status])).toEqual([['rg', 'regressed'], ['rp', 'candidate'], ['rs', 'survived']]);
  });

  it('is idempotent per run: a re-run writes nothing new and keeps the hash; a later settlement still upgrades', () => {
    seed('rv', 'verified');
    distillSkills(db, SHADOW, NOW);
    const before = cards();
    expect(distillSkills(db, SHADOW, NOW)).toMatchObject({ created: 0, anti_patterns: 0, upgraded: 0 });
    expect(cards()).toEqual(before);
    db.prepare("UPDATE loop_runs SET metadata = json_set(metadata, '$.pr_outcome', json(?)) WHERE id = 'rv'")
      .run(JSON.stringify({ state: 'merged', merged_at: iso(20 * DAY), checked_at: iso(DAY), settled_at: iso(DAY), survived: true }));
    expect(distillSkills(db, SHADOW, NOW)).toMatchObject({ created: 0, upgraded: 1 });
    expect(cards()).toEqual([{ ...before[0], status: 'survived' }]);
  });

  it('targetPattern keeps multi-part extensions and reports unknown as null', () => {
    expect(targetPattern(['README.md', 'docs/a.md', 'src/x.spec.tsx', 'src/y.d.ts'])).toEqual(['./*.md', 'docs/*.md', 'src/*.d.ts', 'src/*.spec.tsx']);
    expect(targetPattern([])).toBeNull();
    expect(targetPattern(undefined)).toBeNull();
  });

  it('GET /api/health/skills needs auth and reports counts by lane/kind/status and the latest cards', async () => {
    const saved = process.env.JWT_SECRET; const savedMode = process.env.SKILL_DISTILLATION_MODE;
    process.env.JWT_SECRET = 'skill-distillation-test-secret-'.repeat(3); process.env.SKILL_DISTILLATION_MODE = 'shadow';
    try {
      seed('rv', 'verified'); seed('rm', 'maker_failure', { failed_gates: ['tests_lint_typecheck'], failure_reason: 'x' });
      distillSkills(db, SHADOW, NOW);
      const authService = new AuthService(db);
      const viewer = authService.generateToken(authService.createUser('skills-viewer@example.test', 'disposable-password', UserRole.VIEWER));
      const app = express().use(rateLimit({ windowMs: 60_000, limit: 600 })).use('/api/health', createHealthRoutes(db, createAuthMiddleware(authService)));
      expect((await request(app).get('/api/health/skills')).status).toBe(401);
      const res = await request(app).get('/api/health/skills').set('Authorization', `Bearer ${viewer}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ mode: 'shadow', total: 2, by_lane: [
        { lane: 'test-gap-loop', kind: 'anti_pattern', status: 'candidate', n: 1 }, { lane: 'test-gap-loop', kind: 'skill', status: 'candidate', n: 1 }] });
      expect(res.body.latest.map((c: { run_id: string }) => c.run_id).sort()).toEqual(['rm', 'rv']);
      expect(res.body.note).toMatch(/never injected/);
    } finally {
      if (saved === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = saved;
      if (savedMode === undefined) delete process.env.SKILL_DISTILLATION_MODE; else process.env.SKILL_DISTILLATION_MODE = savedMode;
    }
  });

  it('ACE-001 guard: writeWorkAssignment output is byte-identical with the flag on and cards recorded', () => {
    const write = () => {
      const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-k4-'));
      try {
        const run = { id: 'assignment-run', loop_name: 'test-gap-loop', goal_id: null, mode: 'closed', status: 'planning', metadata: {}, gates: [], next_actions: [], plan: {}, state_file: null, repository_path: worktree } as unknown as LoopRunRecord;
        const finding = { id: 'finding-1', type: 'test_gap', severity: 'low', file: 'packages/server/src/__tests__/a.test.ts', line: 1, message: 'Add tests for a', evidence: 'fixture', suggested_fix: 'add a test' } as LoopFinding;
        const loops = new LoopService(db);
        loops.writeWorkAssignment(worktree, run, finding, 'opencode');
        return fs.readFileSync(loops.workAssignmentPath(worktree), 'utf8');
      } finally { fs.rmSync(worktree, { recursive: true, force: true }); }
    };
    seed('rv', 'verified'); seed('rm', 'maker_failure', { failed_gates: ['tests_lint_typecheck'], failure_reason: 'x' });
    const saved = process.env.SKILL_DISTILLATION_MODE;
    try {
      delete process.env.SKILL_DISTILLATION_MODE;
      const off = write();
      process.env.SKILL_DISTILLATION_MODE = 'shadow';
      expect(distillSkills(db, process.env, NOW)).toMatchObject({ created: 1, anti_patterns: 1 });
      const on = write();
      expect(on).toBe(off);
      expect(on).not.toContain('skill_card');
    } finally { if (saved === undefined) delete process.env.SKILL_DISTILLATION_MODE; else process.env.SKILL_DISTILLATION_MODE = saved; }
  });
});
