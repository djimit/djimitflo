import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { buildEvolutionEvidence } from '../services/evolution-evidence';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';

const NOW = Date.parse('2026-10-04T20:00:00Z');
const ago = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
let db: Database.Database;
afterEach(() => db?.close());

it('RX-1: an empty or partial schema returns every section and never throws', () => {
  db = new Database(':memory:');
  const e = buildEvolutionEvidence(db, {}, NOW);
  expect(Object.keys(e)).toEqual(['at', 'window_days', 'flags', 'outcomes', 'outcomes_tagged', 'merge', 'drafts', 'genomes', 'gym', 'trials', 'models', 'oracle', 'commons', 'forecasts_v2', 'hacks', 'estimates', 'ope', 'gates']);
  expect(e.outcomes).toEqual([]); expect(e.genomes.holdout).toEqual({ mined: null, mutant: null });
  expect(e.gates.B.state).toBe('red'); expect(e.gates.A.state).toBe('unknown');
  expect(e.flags.every((f) => f.value === null)).toBe(true);
});

it('RX-1: counts outcomes per source, loop PRs, genomes and gym tiers like hand SQL (foreign keys on)', () => {
  db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = ON'); new SkillEvolutionEngine(db);
  const out = db.prepare("INSERT INTO skill_outcomes (id, skill_id, success, domain, created_at) VALUES (?, ?, ?, ?, ?)");
  out.run('a', 'loop-maker:test-gap:opencode', 1, 'loop', ago(1)); out.run('b', 'loop-maker:test-gap:opencode', 0, 'loop', ago(2));
  out.run('c', 'loop-maker:gym:atomic', 1, 'gym', ago(1)); out.run('old', 'loop-maker:gym:atomic', 1, 'gym', ago(40));
  out.run('m', 'loop-maker:merge:opencode', 1, 'merge', ago(1));
  const run = db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES (?, ?, 'closed', 'completed', '[]', '{}', '[]', '[]', ?, ?, ?)`);
  run.run('p1', 'test-gap', JSON.stringify({ pr_url: 'u1', pr_outcome: { state: 'merged', survived: true, settled_at: ago(1) } }), ago(20), ago(1));
  run.run('p2', 'test-gap', JSON.stringify({ pr_url: 'u2' }), ago(3), ago(3));
  run.run('p3', 'test-gap', JSON.stringify({ pr_url: 'u3' }), ago(1), ago(1));
  run.run('g1', 'evolution-gym', JSON.stringify({ gym: { commit: 'mut:abc:x:4:1', tier: 4 }, gym_result: { status: 'failure' } }), ago(1), ago(1));
  run.run('g2', 'evolution-gym', JSON.stringify({ gym: { commit: 'abc' }, gym_result: { status: 'success' } }), ago(1), ago(1));
  db.prepare("INSERT INTO maker_genomes (id, origin, status, created_at, updated_at) VALUES ('g-1', 'dream', 'retired', ?, ?)").run(ago(1), ago(1));
  db.prepare("INSERT INTO gym_holdout (commit_sha, created_at) VALUES ('c1', ?)").run(ago(5));

  const e = buildEvolutionEvidence(db, { LOOP_BANDIT_ENABLED: 'true' }, NOW, 30);
  expect(e.outcomes).toEqual(expect.arrayContaining([
    { domain: 'loop', skill: 'loop-maker:test-gap', n: 2, ok: 1 }, { domain: 'gym', skill: 'loop-maker:gym', n: 1, ok: 1 }, { domain: 'merge', skill: 'loop-maker:merge', n: 1, ok: 1 }]));
  expect(e.merge).toMatchObject({ merge_outcomes: 1, settled: [{ state: 'merged', survived: 1, n: 1 }] });
  expect(e.drafts).toMatchObject({ unsettled: 2, unsettled_open_or_recent: 2, age_days_max: 3 });
  expect(e.gates.C.reason).toContain('open or merged < 14 d ago');
  expect(e.genomes.by_status).toEqual([{ status: 'retired', origin: 'dream', n: 1 }]);
  expect(e.genomes.holdout).toEqual({ mined: 1, mutant: 0 });
  expect(e.gym).toEqual(expect.arrayContaining([{ kind: 'mutant', tier: 4, status: 'failure', n: 1 }, { kind: 'mined', tier: null, status: 'success', n: 1 }]));
  expect(e.flags.find((f) => f.name === 'LOOP_BANDIT_ENABLED')).toMatchObject({ value: 'true', acting: true });
  expect(e.gates.B.reason).toContain('1 settled');
});

it('RX-1: the window is clamped to 1–90 days', () => {
  db = new Database(':memory:');
  expect(buildEvolutionEvidence(db, {}, NOW, 999).window_days).toBe(90);
  expect(buildEvolutionEvidence(db, {}, NOW, -5).window_days).toBe(1);
});

it('RX-3: the share of production maker zeros that are infra / no change / eligible evolve losses, per skill', () => {
  db = new Database(':memory:'); db.exec(schema); runMigrations(db); new SkillEvolutionEngine(db);
  const out = db.prepare("INSERT INTO skill_outcomes (id, skill_id, success, domain, evidence_refs_json, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  const skill = 'loop-maker:test-gap:opencode';
  out.run('a', skill, 0, 'test-gap', '["outcome_class:infra_failed"]', ago(1)); out.run('b', skill, 0, 'test-gap', '["evolve:lost_eligible"]', ago(1));
  out.run('c', skill, 0, 'test-gap', '["outcome_class:regressed"]', ago(1)); out.run('d', skill, 1, 'test-gap', '[]', ago(1));
  out.run('g', 'loop-maker:gym:atomic', 0, 'gym', '["outcome_class:infra_failed"]', ago(1));
  expect(buildEvolutionEvidence(db, {}, NOW).outcomes_tagged).toEqual([{ skill, total: 4, failures: 3, tagged: 2, share: 0.5 }]);
});
