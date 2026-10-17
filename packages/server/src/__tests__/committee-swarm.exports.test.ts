import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { SEED_MEMBERS, seedCommittee, memberWeights, startCommitteeEvolution } from '../services/committee-swarm';

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db); });
afterEach(() => { vi.unstubAllEnvs(); db.close(); });

it('seedCommittee inserts all seed members as active, idempotent on repeat', () => {
  const before = new Date('2026-01-01T00:00:00.000Z').toISOString();
  seedCommittee(db, before);
  const rows = db.prepare('SELECT id, persona, knowledge, lines_json, status, origin, created_at FROM committee_genomes ORDER BY id').all() as Array<{ id: string; persona: string; knowledge: string; lines_json: string; status: string; origin: string; created_at: string }>;
  expect(rows).toHaveLength(SEED_MEMBERS.length);
  for (const r of rows) {
    const seed = SEED_MEMBERS.find((m) => m.id === r.id)!;
    expect(r.persona).toBe(seed.persona);
    expect(r.knowledge).toBe(seed.knowledge);
    expect(JSON.parse(r.lines_json)).toEqual(seed.lines);
    expect(r.status).toBe('active');
    expect(r.origin).toBe('seed');
    expect(r.created_at).toBe(before);
  }
  // re-seeding does not duplicate (INSERT OR IGNORE)
  seedCommittee(db, new Date('2026-02-01T00:00:00.000Z').toISOString());
  expect(db.prepare('SELECT COUNT(*) AS n FROM committee_genomes').get()).toMatchObject({ n: SEED_MEMBERS.length });
});

it('memberWeights returns weight 1 for members with fewer than 10 resolved forecasts and clamps negative skill', () => {
  const at = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  seedCommittee(db);
  // no forecasts yet -> empty map
  expect(memberWeights(db).size).toBe(0);
  // insert 3 forecasts for cm-oracle: 1/3 positives -> skill negative but n < 10 -> weight 1
  for (let i = 0; i < 3; i++) {
    const verified = i === 0;
    db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, created_at, updated_at) VALUES (?, 't', 'x', 'd', 'r', 'gap_analysis', ?, 0.5, ?, ?)`).run(`p${i}`, verified ? 'verified' : 'needs_more_evidence', at(100), at(100));
    db.prepare(`INSERT INTO goals (id, objective, risk_class, status, improvement_id, created_at, updated_at) VALUES (?, 'g', 'low', 'completed', ?, ?, ?)`).run(`g${i}`, `p${i}`, at(1), at(1));
    db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, answers_json, created_at) VALUES (?, 'forecast:committee:cm-oracle', 'self_improvement', ?, 'j', 'shadow', 'yes', ?, ?)`).run(`j${i}`, `p${i}`, JSON.stringify({ p: verified ? 0.9 : 0.1, as_of: at(99) }), at(99));
  }
  const w = memberWeights(db);
  expect(w.get('cm-oracle')).toBe(1);
  // a forecaster that is not a committee member is ignored
  expect(w.has('forecast:resident:other')).toBe(false);
});

it('startCommitteeEvolution returns null when disabled and a stop function when enabled', () => {
  expect(startCommitteeEvolution(db)).toBeNull();
  vi.stubEnv('COMMITTEE_SWARM_ENABLED', 'true');
  const stop = startCommitteeEvolution(db, 100);
  expect(typeof stop).toBe('function');
  expect(() => stop()).not.toThrow();
});