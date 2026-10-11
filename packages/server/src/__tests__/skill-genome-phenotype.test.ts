import { beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';

// CODEX directive inv. 2 / fitness audit: skill genome traits are measured phenotype, never mutable genotype.
let db: Database.Database;
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
  engine.recordOutcome('s', { success: true, tokensUsed: 500, durationMs: 1, domain: 'd' });
  engine.recordOutcome('s', { success: false, tokensUsed: 500, durationMs: 1, domain: 'd' });
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
    for (const s of ok) engine.recordOutcome(id, { success: s === 1, tokensUsed: 100, durationMs: 1, domain: 'd' });
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
