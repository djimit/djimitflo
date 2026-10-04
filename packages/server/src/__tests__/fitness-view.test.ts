import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { fitnessKeys, fitnessPosterior, recordFitnessShadow } from '../services/fitness-view';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';

let db: Database.Database;
const NOW = Date.parse('2026-10-03T12:00:00Z');
beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db); new SkillEvolutionEngine(db); });
afterEach(() => { vi.unstubAllEnvs(); db.close(); });
const outcome = (skill: string, model: string, success: boolean, created = '2026-10-03T11:00:00Z') => db.prepare(`INSERT INTO skill_outcomes
  (id, skill_id, success, tokens_used, duration_ms, domain, model, created_at) VALUES (?, ?, ?, 0, 0, 'x', ?, ?)`).run(`${Math.random()}`, skill, success ? 1 : 0, model, created);
const OPENCODE = { runtime: 'opencode' };
const REMOTE = { runtime: 'remote', model: 'workstation/atomic@llama-router' };

it('D0: a remote species trains in the gym under its own runtime@model; merge has its own key', () => {
  expect(fitnessKeys('doc-drift-and-small-fix-loop', REMOTE)).toEqual([
    { source: 'production', skillId: 'loop-maker:doc-drift-and-small-fix-loop:remote', model: 'workstation/atomic@llama-router' },
    { source: 'gym', skillId: 'loop-maker:gym:atomic', model: 'llama-router' },
    { source: 'merge', skillId: 'loop-maker:merge:remote', model: 'workstation/atomic@llama-router' },
  ]);
});

it('D0: a gym win and a surviving merged PR move the posterior (they never reached the bandit), weighted 0.25 and 3', () => {
  const lane = 'doc-drift-and-small-fix-loop';
  const before = fitnessPosterior(db, lane, [REMOTE], NOW)[0];
  expect(before).toMatchObject({ alpha: 1, beta: 1, mean: 0.5 });
  outcome('loop-maker:gym:atomic', 'llama-router', true, new Date(NOW).toISOString());
  const gym = fitnessPosterior(db, lane, [REMOTE], NOW)[0];
  expect(gym.alpha).toBeCloseTo(1.25, 2); expect(gym.sources.gym).toEqual({ n: 1, ok: 1 });
  outcome('loop-maker:merge:remote', 'workstation/atomic@llama-router', true, new Date(NOW).toISOString());
  expect(fitnessPosterior(db, lane, [REMOTE], NOW)[0].alpha).toBeCloseTo(4.25, 2);
});

it('D0: old outcomes decay with the half-life (30 d by default)', () => {
  outcome('loop-maker:l:opencode', '', false, new Date(NOW - 30 * 86_400_000).toISOString());
  expect(fitnessPosterior(db, 'l', [OPENCODE], NOW)[0].beta).toBeCloseTo(1.5, 2);
});

it('D0 shadow: records what the fitness view would pick next to the bandit choice, with the full table; off by default', () => {
  db.prepare("INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at) VALUES ('r1', 'l', 'closed', 'running', '[]', '{}', '[]', '[]', '{}', datetime('now'), datetime('now'))").run();
  for (let i = 0; i < 4; i++) outcome('loop-maker:l:opencode', '', i === 0, new Date(NOW).toISOString());
  for (let i = 0; i < 8; i++) outcome('loop-maker:gym:atomic', 'llama-router', true, new Date(NOW).toISOString());
  recordFitnessShadow(db, 'r1', 'l', [OPENCODE, REMOTE], 'opencode', NOW);
  expect(db.prepare("SELECT COUNT(*) AS n FROM loop_events WHERE event_type = 'fitness_shadow'").get()).toEqual({ n: 0 });
  vi.stubEnv('FITNESS_SHADOW_ENABLED', 'true');
  recordFitnessShadow(db, 'r1', 'l', [OPENCODE, REMOTE], 'opencode', NOW);
  const ev = db.prepare("SELECT metadata FROM loop_events WHERE event_type = 'fitness_shadow'").get() as { metadata: string };
  const meta = JSON.parse(ev.metadata);
  expect(meta).toMatchObject({ would_pick: 'remote@workstation/atomic@llama-router', actual: 'opencode', agree: false });
  expect(meta.table).toHaveLength(2);
});

it('D0 cap: hundreds of gym wins stay a prior (≤ 5 pseudo-observations) — real failures still decide (prod 03-10)', () => {
  const at = new Date(NOW).toISOString();
  for (let i = 0; i < 300; i++) outcome('loop-maker:gym:atomic', 'llama-router', i % 5 !== 0, at); // 80 % in the gym
  for (let i = 0; i < 9; i++) outcome('loop-maker:l:remote', 'workstation/atomic@llama-router', false, at); // 0/9 real
  for (let i = 0; i < 9; i++) outcome('loop-maker:l:opencode', '', i < 3, at); // 3/9 real
  const [oc, ws] = fitnessPosterior(db, 'l', [OPENCODE, REMOTE], NOW);
  expect(ws.alpha + ws.beta).toBeCloseTo(2 + 9 + 5, 1); // prior + 9 real + gym capped at 5
  expect(oc.mean).toBeGreaterThan(ws.mean);
});
