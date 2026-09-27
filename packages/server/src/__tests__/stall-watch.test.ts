import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { detectStalls } from '../services/stall-watch';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';

let db: Database.Database;
const NOW = Date.parse('2026-09-27T18:00:00Z');
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF'); new SkillEvolutionEngine(db); });
afterEach(() => db.close());
const subsystems = (env: NodeJS.ProcessEnv = {}) => detectStalls(db, NOW, env).map((s) => s.subsystem).sort();

it('is quiet on a healthy system', () => {
  db.prepare("INSERT INTO skill_outcomes (id, skill_id, success, tokens_used, duration_ms, domain, created_at) VALUES ('o1', 'loop-maker:gym:atomic', 1, 0, 1, 'gym', ?)").run(at(1));
  expect(subsystems({ EVOLUTION_GYM_ENABLED: 'true' })).toEqual([]);
});

it('fires on the three silent failures of 2026-09-27', () => {
  // gym benched: last outcome 10 h ago, three infra discards since
  db.prepare("INSERT INTO skill_outcomes (id, skill_id, success, tokens_used, duration_ms, domain, created_at) VALUES ('o1', 'loop-maker:gym:atomic', 1, 0, 1, 'gym', ?)").run(at(10));
  for (const i of [1, 2, 3]) db.prepare("INSERT INTO loop_runs (id, loop_name, mode, status, metadata, created_at) VALUES (?, 'evolution-gym', 'closed', 'completed', ?, ?)").run(`g${i}`, JSON.stringify({ gym_result: { reason: 'infra: maker produced nothing (no change)' } }), at(9 - i));
  // safety check swallowed by 429s
  for (let i = 0; i < 12; i++) db.prepare("INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at) VALUES (?, 'content_safety', 'kb_page', ?, 'h', 'shadow', ?, 'x', ?)").run(`j${i}`, `p${i}`, i < 8 ? 'error' : 'yes', at(1));
  // review goal left running after its run completed
  db.prepare("INSERT INTO goals (id, objective, risk_class, status, created_at, updated_at) VALUES ('g-z', 'review', 'low', 'running', ?, ?)").run(at(20), at(20));
  db.prepare("INSERT INTO loop_runs (id, loop_name, mode, status, goal_id, created_at) VALUES ('r-z', 'repo-maintenance-loop', 'closed', 'completed', 'g-z', ?)").run(at(20));
  expect(subsystems({ EVOLUTION_GYM_ENABLED: 'true' })).toEqual(['goals', 'gym', 'judgment:content_safety']);
  expect(detectStalls(db, NOW, { EVOLUTION_GYM_ENABLED: 'true' }).find((s) => s.subsystem === 'gym')?.detail).toContain('3 infra discard');
  expect(subsystems()).not.toContain('gym'); // gym disabled: not a stall
});
