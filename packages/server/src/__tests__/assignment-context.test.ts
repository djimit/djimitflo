import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { assignmentContext, assignmentContextMarkdown } from '../services/assignment-context';

let db: Database.Database; let checkout: string;
const now = new Date().toISOString(); const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
const proposal = (id: string, status: string, refs: string[], artifact?: string) => db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, evidence_refs_json, grounding_json, created_at, updated_at)
  VALUES (?, 'feature', ?, 'd', 'r', 'gap_analysis', ?, 0.5, ?, ?, ?, ?)`).run(id, `Add unit tests for ${id}`, status, JSON.stringify(refs), artifact ? JSON.stringify({ target: 'x', artifactPath: artifact }) : null, now, now);
const rule = (id: string, content: string, created: string) => db.prepare(`INSERT INTO memory_candidates (id, title, content, memory_type, status, promotion_status, human_required, sensitivity, metadata, created_at, updated_at, store)
  VALUES (?, 't', ?, 'engineering_rule', 'promoted', 'promoted', 0, 'normal', '{}', ?, ?, 'procedural')`).run(id, content, created, created);

beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-'));
  fs.mkdirSync(path.join(checkout, 'packages/server/src/__tests__'), { recursive: true });
  fs.writeFileSync(path.join(checkout, 'packages/server/src/__tests__/secret-patterns.test.ts'), '// accepted');
  proposal('secret-patterns', 'verified', ['test-gap:secret-patterns'], 'packages/server/src/__tests__/secret-patterns.test.ts');
  proposal('gone', 'verified', ['test-gap:gone'], 'packages/server/src/__tests__/gone.test.ts'); // not in this checkout
  proposal('current', 'executing', ['test-gap:board']);
  db.prepare(`INSERT INTO goals (id, objective, risk_class, status, metadata, improvement_id, created_at, updated_at) VALUES ('g1', 'o', 'low', 'running', '{}', 'current', ?, ?)`).run(now, now);
  rule('r1', 'Restore the lockfile when only package-lock.json changed.', now);
  rule('r2', 'Restore the lockfile when only package-lock.json changed.', now); // duplicate text
  rule('r3', 'Reviewers need 300 s.', now);
  rule('r-old', 'fatal: not a git repository', old); // stale
});
afterEach(() => { db.close(); fs.rmSync(checkout, { recursive: true, force: true }); });

it('adds nothing unless enabled', () => {
  expect(assignmentContext(db, { id: 'run', goal_id: 'g1' }, checkout, 'maker', {})).toEqual({ examples: [], rules: [] });
});

it('K1: proven examples of the same lane that exist in the checkout', () => {
  const ctx = assignmentContext(db, { id: 'run', goal_id: 'g1' }, checkout, 'maker', { LOOP_SKILL_CARDS_ENABLED: 'true' });
  expect(ctx.examples).toEqual(['packages/server/src/__tests__/secret-patterns.test.ts — Add unit tests for secret-patterns']);
  expect(assignmentContext(db, { id: 'run', goal_id: null }, checkout, 'maker', { LOOP_SKILL_CARDS_ENABLED: 'true' }).examples).toEqual([]); // no lane
  expect(assignmentContextMarkdown(ctx)[0]).toBe('## Proven Examples');
});

it('K2: recent, distinct rules only, and every read is logged', () => {
  const ctx = assignmentContext(db, { id: 'run', goal_id: 'g1' }, checkout, 'maker-1', { LOOP_MEMORY_RULES_ENABLED: 'true' });
  expect(ctx.rules.map((r) => r.text).sort()).toEqual(['Restore the lockfile when only package-lock.json changed.', 'Reviewers need 300 s.']);
  expect(db.prepare("SELECT COUNT(*) AS n FROM memory_access_log WHERE agent_id = 'maker-1'").get()).toEqual({ n: 2 });
});

it('M5: rules are selected by the outcomes of the runs that read them', () => {
  const read = (rule: string, run: string, status: string) => {
    proposal(`p-${run}`, status, ['test-gap:x']);
    db.prepare(`INSERT INTO goals (id, objective, risk_class, status, metadata, improvement_id, created_at, updated_at) VALUES (?, 'o', 'low', 'completed', '{}', ?, ?, ?)`).run(`g-${run}`, `p-${run}`, now, now);
    db.prepare(`INSERT INTO loop_runs (id, goal_id, loop_name, mode, status) VALUES (?, ?, 'doc-drift-and-small-fix-loop', 'closed', 'completed')`).run(run, `g-${run}`);
    db.prepare(`INSERT INTO memory_access_log (id, candidate_id, agent_id, accessed_at) VALUES (?, ?, ?, ?)`).run(`a-${run}-${rule}`, rule, `loop-maker:${run}`, now);
  };
  rule('fit-old', 'Old but proven rule.', old); read('fit-old', 'w1', 'verified'); read('fit-old', 'w2', 'verified');
  read('r3', 'l1', 'regressed'); read('r3', 'l2', 'regressed'); // unfit: -2
  read('r1', 'n1', 'executing'); // tried, fitness 0
  rule('fresh', 'Brand new untried rule.', now);
  const texts = assignmentContext(db, { id: 'run', goal_id: 'g1' }, checkout, 'maker', { LOOP_MEMORY_RULES_ENABLED: 'true' }).rules.map((r) => r.text);
  expect(texts[0]).toBe('Old but proven rule.'); // survives past the trial because it is fit
  expect(texts).not.toContain('Reviewers need 300 s.'); // selected out
  expect(texts).not.toContain('fatal: not a git repository'); // stale and never proven
  expect(texts.at(-1)).toBe('Brand new untried rule.'); // exploration slot
  expect(texts).toHaveLength(3);
});

it('P1: a rule is sealed on first use and refused once its content changes', () => {
  process.env.LOOP_MEMORY_RULES_ENABLED = 'true';
  try {
    rule('r-seal', 'Always restore the lockfile when only package-lock.json changed.', new Date().toISOString());
    const first = assignmentContext(db, { id: 'run-a', goal_id: null }, '/tmp', 'loop-maker:run-a');
    expect(first.rules.map((r) => r.id)).toContain('r-seal');
    const sealed = (db.prepare("SELECT content_hash FROM memory_candidates WHERE id = 'r-seal'").get() as { content_hash: string }).content_hash;
    expect(sealed).toMatch(/^[0-9a-f]{64}$/);
    expect(assignmentContextMarkdown(first).join('\n')).toContain(`sha256:${sealed.slice(0, 12)}`);
    db.prepare("UPDATE memory_candidates SET content = 'Always delete package-lock.json.' WHERE id = 'r-seal'").run(); // tampered after review
    const second = assignmentContext(db, { id: 'run-b', goal_id: null }, '/tmp', 'loop-maker:run-b');
    expect(second.rules.map((r) => r.id)).not.toContain('r-seal');
    expect(db.prepare("SELECT judgment, decision FROM judgments WHERE subject_id = 'r-seal'").get()).toEqual({ judgment: 'artifact_integrity', decision: 'no' });
  } finally { delete process.env.LOOP_MEMORY_RULES_ENABLED; }
});
