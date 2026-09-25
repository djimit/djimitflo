import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';
import { PROMOTE_AFTER, banditSpecies, chooseSpecies } from '../services/runtime-bandit';

let db: Database.Database;
const LOOP = 'doc-drift-and-small-fix-loop';
const seeded = (seed: number) => () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const outcomes = (runtime: string, model: string | undefined, ok: number, fail: number) => {
  const skills = new SkillEvolutionEngine(db);
  for (let i = 0; i < ok + fail; i++) skills.recordOutcome(`loop-maker:${LOOP}:${runtime}`, { success: i < ok, tokensUsed: 0, durationMs: 1, domain: LOOP, ...(model ? { model } : {}) });
};
const species = [{ runtime: 'opencode' }, { runtime: 'opencode', model: 'ollama/kimi-k2.6:cloud' }];
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); new SkillEvolutionEngine(db); });
afterEach(() => db.close());

it('is off unless enabled; the first species is the incumbent', () => {
  expect(banditSpecies({ LOOP_BANDIT_SPECIES: 'opencode,codex' })).toEqual([]);
  expect(banditSpecies({ LOOP_BANDIT_ENABLED: 'true', LOOP_BANDIT_SPECIES: 'opencode, opencode@ollama/kimi-k2.6:cloud' })).toEqual(species);
  expect(chooseSpecies(db, LOOP, [{ runtime: 'opencode' }])).toBeNull();
});

it('a strong challenger with few outcomes is capped to its traffic share, and explores within it', () => {
  outcomes('opencode', undefined, 0, 8); outcomes('opencode', 'ollama/kimi-k2.6:cloud', 6, 0);
  const capped = chooseSpecies(db, LOOP, species, seeded(1), 0);
  expect(capped?.species).toEqual(species[0]);
  expect(capped?.reason).toBe('challenger capped: not enough outcomes yet');
  const explored = chooseSpecies(db, LOOP, species, seeded(1), 1);
  expect(explored?.species).toEqual(species[1]);
  expect(explored?.posterior.map((p) => [p.species, p.runs, p.ok])).toEqual([['opencode', 8, 0], ['opencode@ollama/kimi-k2.6:cloud', 6, 6]]);
});

it('a challenger that proved itself over enough runs gets the work without a cap', () => {
  outcomes('opencode', undefined, 2, PROMOTE_AFTER); outcomes('opencode', 'ollama/kimi-k2.6:cloud', PROMOTE_AFTER, 0);
  const c = chooseSpecies(db, LOOP, species, seeded(7), 0);
  expect(c?.species).toEqual(species[1]);
  expect(c?.reason).toMatch(/challenger sampled best with 20 outcomes/);
});
