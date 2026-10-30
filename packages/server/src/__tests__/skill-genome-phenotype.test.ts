import { beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';

// CODEX directive inv. 2 / fitness audit: skill genome traits are measured phenotype, never mutable genotype.
let db: Database.Database;
// skill fitness counts only delivered attribution (INT-004): these phenotype tests record delivered outcomes
const DELIVERED = ['skill_delivery:delivered'];
beforeEach(() => { db = new Database(':memory:'); });

it('fitness without outcomes is null (INSUFFICIENT_EVIDENCE), whatever traits are declared', () => {
  const engine = new SkillEvolutionEngine(db);
  const g = engine.registerSkill('s', { reliability: 1, efficiency: 1, generality: 1, complexity: 0, adaptability: 1 });
  expect(g.fitness).toBeNull();
  expect(g.traits.reliability).toBeNull();
  expect(engine.getStats().avgFitness).toBeNull();
});

it('arbitrary trait mutation cannot raise fitness', () => {
  const engine = new SkillEvolutionEngine(db);
  engine.recordOutcome('s', { success: true, tokensUsed: 500, durationMs: 1, domain: 'd', evidenceRefs: DELIVERED });
  engine.recordOutcome('s', { success: false, tokensUsed: 500, durationMs: 1, domain: 'd', evidenceRefs: DELIVERED });
  const g = engine.registerSkill('s');
  expect(g.fitness).toBe(0.5);
  engine.mutate(g);
  expect(g.fitness).toBe(0.5);
  expect(g.traits.reliability).toBe(0.5);
  expect(g.mutations.at(-1)).toMatch(/^refused/);
});

it('property: fitness never changes across random evolution without new outcomes', () => {
  let seed = 7; const rand = () => { seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31; return seed / 2 ** 31; };
  const engine = new SkillEvolutionEngine(db, rand);
  for (const [id, ok] of [['a', [1, 1, 0]], ['b', [0, 1]], ['c', [1]]] as const) {
    for (const s of ok) engine.recordOutcome(id, { success: s === 1, tokensUsed: 100, durationMs: 1, domain: 'd', evidenceRefs: DELIVERED });
    engine.registerSkill(id, { reliability: rand(), efficiency: rand() });
  }
  const before = engine.getStats().avgFitness;
  for (let i = 0; i < 25; i++) {
    for (const g of engine.evolve()) {
      // a child has no outcomes of its own; a copied parent carries exactly its measured success share
      const rows = db.prepare('SELECT AVG(success) AS r, COUNT(*) AS n FROM skill_outcomes WHERE skill_id = ?').get(g.skillId) as { r: number | null; n: number };
      expect(g.fitness).toBe(rows.n ? rows.r : null);
    }
  }
  expect(engine.getStats().avgFitness).toBe(before);
});

it('unknown token usage is stored as null and drops out of efficiency instead of scoring 1', () => {
  const engine = new SkillEvolutionEngine(db);
  engine.recordOutcome('s', { success: true, tokensUsed: null, durationMs: 1, domain: 'd', evidenceRefs: DELIVERED });
  expect((db.prepare("SELECT tokens_used FROM skill_outcomes WHERE skill_id = 's'").get() as { tokens_used: number | null }).tokens_used).toBeNull();
  expect(engine.measuredTraits('s')).toMatchObject({ reliability: 1, efficiency: null });
  engine.recordOutcome('s', { success: true, tokensUsed: 2000, durationMs: 1, domain: 'd', evidenceRefs: DELIVERED });
  expect(engine.measuredTraits('s').efficiency).toBe(0.5); // the known row only
});

it('a completed_unverified zero is neither a success nor a failure of the skill', () => {
  const engine = new SkillEvolutionEngine(db);
  engine.recordOutcome('s', { success: false, tokensUsed: 10, durationMs: 1, domain: 'd', evidenceRefs: ['outcome_class:completed_unverified', ...DELIVERED] });
  expect(engine.measuredTraits('s').reliability).toBeNull();
  engine.recordOutcome('s', { success: true, tokensUsed: 10, durationMs: 1, domain: 'd', evidenceRefs: DELIVERED });
  expect(engine.measuredTraits('s').reliability).toBe(1);
});

it('widens a legacy NOT NULL tokens_used column once, keeping every row and ALTER-added column', () => {
  db.exec(`CREATE TABLE skill_outcomes (id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, success INTEGER NOT NULL DEFAULT 0,
    tokens_used INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0, domain TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  db.prepare("INSERT INTO skill_outcomes (id, skill_id, success, tokens_used, duration_ms, domain) VALUES ('old', 'loop-maker:x:opencode', 1, 0, 5, 'x')").run();
  const engine = new SkillEvolutionEngine(db);
  const cols = db.prepare('PRAGMA table_info(skill_outcomes)').all() as Array<{ name: string; notnull: number }>;
  expect(cols.find((c) => c.name === 'tokens_used')?.notnull).toBe(0);
  expect(cols.map((c) => c.name)).toEqual(expect.arrayContaining(['model', 'evidence_refs_json', 'skill_content_hash']));
  expect(db.prepare('SELECT id, success, tokens_used, duration_ms, model, evidence_refs_json FROM skill_outcomes').all())
    .toEqual([{ id: 'old', success: 1, tokens_used: 0, duration_ms: 5, model: null, evidence_refs_json: '[]' }]);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_skill_outcomes_skill_id'").get()).toBeTruthy();
  engine.recordOutcome('s', { success: true, tokensUsed: null, durationMs: 1, domain: 'd', evidenceRefs: DELIVERED });
  new SkillEvolutionEngine(db); // idempotent: a second construction leaves the widened table and its rows alone
  expect((db.prepare('SELECT COUNT(*) AS n FROM skill_outcomes').get() as { n: number }).n).toBe(2);
});
