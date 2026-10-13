import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { buildEvolutionEvidence } from '../services/evolution-evidence';
import { operatorCockpit } from '../services/operator-cockpit';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';

// Cockpit 3.0 adversarial scenarios (TEST_EVIDENCE.md): activity that looks like learning must not be reported as improvement
const NOW = Date.parse('2026-10-10T12:00:00Z');
const ago = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF'); new SkillEvolutionEngine(db); });
afterEach(() => db.close());
const metrics = (e: ReturnType<typeof buildEvolutionEvidence>) => {
  expect(e.intelligence?.metrics?.length).toBeGreaterThan(0); // the section computed; an empty list would pass vacuously
  return e.intelligence!.metrics;
};
const improvementClaims = (e: ReturnType<typeof buildEvolutionEvidence>) =>
  metrics(e).filter((m) => ['VIG', 'RIR', 'GTI', 'CLY', 'ESE', 'SCIG'].includes(m.metric_id) && m.status === 'ok').map((m) => m.metric_id);

it('scenario 6: a gym win rate rising to 95 % with flat production outcomes claims no improvement and greens no realm gate', () => {
  const out = db.prepare('INSERT INTO skill_outcomes (id, skill_id, success, domain, created_at) VALUES (?, ?, ?, ?, ?)');
  // gym: 50 % three weeks ago → 95 % this week
  for (let i = 0; i < 40; i++) out.run(`g-old-${i}`, 'loop-maker:gym:atomic', i % 2, 'gym', ago(20));
  for (let i = 0; i < 40; i++) out.run(`g-new-${i}`, 'loop-maker:gym:atomic', i < 38 ? 1 : 0, 'gym', ago(1));
  // production: the same 50 % in both windows
  for (let i = 0; i < 10; i++) out.run(`p-old-${i}`, 'loop-maker:test-gap:opencode', i % 2, 'loop', ago(20));
  for (let i = 0; i < 10; i++) out.run(`p-new-${i}`, 'loop-maker:test-gap:opencode', i % 2, 'loop', ago(1));
  const e = buildEvolutionEvidence(db, {}, NOW);
  expect(improvementClaims(e)).toEqual([]);
  expect(Object.values(e.gates).some((g) => g.state === 'green')).toBe(false);
  // the cockpit keeps gym and production makers in separate tables, never one merged win rate
  const scopes = new Set(operatorCockpit(db, NOW, {}).genomes.map((g) => g.scope));
  expect(scopes.has('production') && scopes.has('gym') ? 'mixed' : 'separate').toBe('separate');
});

it('scenario 11: memory reads rising tenfold without an outcome difference claims no learning gain', () => {
  const read = db.prepare('INSERT INTO memory_access_log (id, candidate_id, agent_id, accessed_at) VALUES (?, ?, ?, ?)');
  for (let i = 0; i < 300; i++) read.run(`r${i}`, 'rule-1', 'maker', ago(i < 30 ? 20 : 1));
  const e = buildEvolutionEvidence(db, {}, NOW);
  const cly = metrics(e).find((m) => m.metric_id === 'CLY');
  expect(cly?.status).toBe('INSUFFICIENT_EVIDENCE');
  expect(cly?.value).toBeNull(); // never a 0 that reads as 'measured, no gain' nor a number from read counts
  expect(e.memory_holdout.rules.verified_rate).toBeNull();
  expect(improvementClaims(e)).toEqual([]);
  // the cockpit reports reads as a count, not as a learning metric
  expect(operatorCockpit(db, NOW, {}).scorecard.memory_reads_7d).toBe(270);
});
