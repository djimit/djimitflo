import { beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { MAKER_TEMPLATE_HASH, runGenome, skillContentHash } from '../services/maker-genome';
import { operatorCockpit } from '../services/operator-cockpit';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db); new SkillEvolutionEngine(db); });

const context = (run: string, examples: string[], ruleIds: string[]) => db.prepare(`INSERT INTO loop_events (id, loop_run_id, event_type, level, message, metadata, created_at)
  VALUES (?, ?, 'assignment_context', 'info', 'x', ?, datetime('now'))`).run(`ev-${run}`, run, JSON.stringify({ examples, rule_ids: ruleIds }));

it('Y2: the genome is the template, the examples and the sealed rules — order-free, and a changed rule is a new genome', () => {
  db.prepare("INSERT INTO memory_candidates (id, title, content, memory_type, status, promotion_status, sensitivity, content_hash) VALUES ('r1', 't', 'c', 'engineering_rule', 'promoted', 'promoted', 'normal', 'aaaaaaaaaaaaaaaa')").run();
  context('run-a', ['b.test.ts — B', 'a.test.ts — A'], ['r1']);
  context('run-b', ['a.test.ts — A', 'b.test.ts — B'], ['r1']);
  const a = runGenome(db, 'run-a');
  expect(a).toMatchObject({ template: MAKER_TEMPLATE_HASH, examples: ['a.test.ts — A', 'b.test.ts — B'], rules: ['r1:aaaaaaaaaaaa'] });
  expect(runGenome(db, 'run-b').id).toBe(a.id);
  db.prepare("UPDATE memory_candidates SET content_hash = 'bbbbbbbbbbbbbbbb' WHERE id = 'r1'").run();
  expect(runGenome(db, 'run-b').id).not.toBe(a.id);
  expect(runGenome(db, 'run-without-context')).toMatchObject({ examples: [], rules: [] });
});

it('Y2: the cockpit shows real outcomes per genome', () => {
  const engine = new SkillEvolutionEngine(db);
  for (const [i, ok] of [[1, true], [2, false], [3, true]] as const) {
    engine.recordOutcome('loop-maker:test-gap:opencode', { success: ok, tokensUsed: 0, durationMs: 1, domain: 'test-gap', taskId: `run-${i}`, agentId: `m${i}`, evidenceRefs: [`loop_run:run-${i}`, 'genome:g1'] });
  }
  expect(operatorCockpit(db).genomes).toEqual([{ genome: 'g1', skill_id: 'loop-maker:test-gap:opencode', outcomes: 3, wins: 2, win_pct: 67, scope: 'production' }]);
});

it('§16 step 9: the skill content hash is sha256 of what shaped the run — stable for identical inputs, new when a rule changes', () => {
  db.prepare("INSERT INTO memory_candidates (id, title, content, memory_type, status, promotion_status, sensitivity, content_hash) VALUES ('r1', 't', 'c', 'engineering_rule', 'promoted', 'promoted', 'normal', 'aaaaaaaaaaaaaaaa')").run();
  context('run-a', ['b.test.ts — B', 'a.test.ts — A'], ['r1']);
  context('run-b', ['a.test.ts — A', 'b.test.ts — B'], ['r1']);
  const a = skillContentHash(runGenome(db, 'run-a'), 'sg-1');
  expect(a).toMatch(/^[a-f0-9]{64}$/);
  expect(skillContentHash(runGenome(db, 'run-b'), 'sg-1')).toBe(a); // same template, examples (any order), rules + seals, genome
  expect(skillContentHash(runGenome(db, 'run-b'), 'sg-2')).not.toBe(a); // another strategy genome
  expect(skillContentHash(runGenome(db, 'run-b'), null)).not.toBe(a);
  context('run-c', ['a.test.ts — A'], ['r1']);
  expect(skillContentHash(runGenome(db, 'run-c'), 'sg-1')).not.toBe(a); // another example set
  db.prepare("UPDATE memory_candidates SET content_hash = 'bbbbbbbbbbbbbbbb' WHERE id = 'r1'").run();
  expect(skillContentHash(runGenome(db, 'run-b'), 'sg-1')).not.toBe(a); // a resealed rule
});
