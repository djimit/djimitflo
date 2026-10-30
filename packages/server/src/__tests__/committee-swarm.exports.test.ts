import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import {
  seedCommittee,
  memberWeights,
  startCommitteeEvolution,
  SEED_MEMBERS,
} from '../services/committee-swarm';

let db: Database.Database;
const NOW = '2026-10-17T00:00:00.000Z';

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(schema);
  runMigrations(db);
});
afterEach(() => { db.close(); });

describe('seedCommittee', () => {
  it('inserts every SEED_MEMBER as an active seed row with the given timestamp', () => {
    seedCommittee(db, NOW);
    const rows = db.prepare("SELECT id, persona, knowledge, status, origin, created_at FROM committee_genomes ORDER BY id")
      .all() as Array<{ id: string; persona: string; knowledge: string; status: string; origin: string; created_at: string }>;
    expect(rows).toHaveLength(SEED_MEMBERS.length);
    expect(rows.map((r) => r.id)).toEqual(SEED_MEMBERS.map((m) => m.id).sort());
    for (const r of rows) {
      expect(r.status).toBe('active');
      expect(r.origin).toBe('seed');
      expect(r.created_at).toBe(NOW);
    }
    expect(rows.find((r) => r.id === 'cm-skeptic')?.persona).toBe('Skeptic');
  });

  it('is idempotent (INSERT OR IGNORE): re-running does not duplicate or overwrite rows', () => {
    seedCommittee(db, NOW);
    const before = (db.prepare('SELECT COUNT(*) AS n FROM committee_genomes').get() as { n: number }).n;
    seedCommittee(db, '2020-01-01T00:00:00.000Z');
    const after = (db.prepare('SELECT COUNT(*) AS n FROM committee_genomes').get() as { n: number }).n;
    expect(after).toBe(before);
    expect(after).toBe(SEED_MEMBERS.length);
    // created_at is preserved (not overwritten by the second call)
    const row = db.prepare("SELECT created_at FROM committee_genomes WHERE id = 'cm-oracle'").get() as { created_at: string };
    expect(row.created_at).toBe(NOW);
  });
});

describe('memberWeights', () => {
  const insForecast = (subjectId: string, member: string, p: number, asOf: string) => {
    db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
      VALUES (?, ?, 'self_improvement', ?, ?, 'shadow', ?, '', ?, ?)`)
      .run(randomUUID(), `forecast:committee:${member}`, subjectId, 'job-1', p >= 0.5 ? 'yes' : 'no',
        JSON.stringify({ p, as_of: asOf }), asOf);
  };
  const insProposal = (id: string, status: string, source = 'test-lane') => {
    db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, created_at, updated_at)
      VALUES (?, 'test', ?, '', '', ?, ?, ?, ?)`)
      .run(id, `t-${id}`, source, status, '2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z');
  };

  it('returns an empty map when no committee forecasts have been scored', () => {
    seedCommittee(db, NOW);
    expect(memberWeights(db).size).toBe(0);
  });

  it('ignores non-committee forecasters (only forecast:committee:* keys are weighted)', () => {
    insProposal('si-1', 'verified');
    // a resident forecast (forecast:resident:*) is scored but never weighted by the committee
    db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
      VALUES (?, ?, 'self_improvement', ?, ?, 'shadow', ?, '', ?, ?)`)
      .run(randomUUID(), 'forecast:resident:hermes', 'si-1', 'job-1', 'yes',
        JSON.stringify({ p: 0.9, as_of: '2026-10-01T12:00:00.000Z' }), '2026-10-01T12:00:00.000Z');
    expect(memberWeights(db).size).toBe(0);
  });

  it('weighs a member 1 when it has fewer than 10 resolved forecasts (regardless of skill)', () => {
    seedCommittee(db, NOW);
    for (let i = 0; i < 3; i++) {
      insProposal(`si-v${i}`, 'verified');
      insForecast(`si-v${i}`, 'cm-skeptic', 0.1, '2026-10-01T12:00:00.000Z');
    }
    const w = memberWeights(db);
    expect(w.get('cm-skeptic')).toBe(1);
  });

  it('weighs a member by its Brier skill once it has >= 10 resolved forecasts', () => {
    seedCommittee(db, NOW);
    // 5 verified (p=0.9) + 5 regressed (p=0.1): base rate 0.5, forecaster near-perfect → skill ≈ 0.96
    for (let i = 0; i < 5; i++) {
      insProposal(`si-ok${i}`, 'verified');
      insForecast(`si-ok${i}`, 'cm-skeptic', 0.9, '2026-10-01T12:00:00.000Z');
    }
    for (let i = 0; i < 5; i++) {
      insProposal(`si-no${i}`, 'regressed');
      insForecast(`si-no${i}`, 'cm-skeptic', 0.1, '2026-10-01T12:00:00.000Z');
    }
    const w = memberWeights(db);
    const wt = w.get('cm-skeptic');
    expect(wt).toBeDefined();
    expect(wt).toBeGreaterThan(1);
    // weight = max(0.05, 1 + 2*skill)
    expect(wt).toBeLessThanOrEqual(1 + 2 * 1);
  });

  it('floors a badly-calibrated member (skill < 0) at 0.05 but never below', () => {
    seedCommittee(db, NOW);
    // 10 verified, forecaster always says p=0.1 → very negative skill
    for (let i = 0; i < 10; i++) {
      insProposal(`si-bad${i}`, 'verified');
      insForecast(`si-bad${i}`, 'cm-oracle', 0.1, '2026-10-01T12:00:00.000Z');
    }
    const w = memberWeights(db);
    expect(w.get('cm-oracle')).toBeGreaterThanOrEqual(0.05);
  });
});

describe('startCommitteeEvolution', () => {
  const KEY = 'COMMITTEE_SWARM_ENABLED';
  let original: string | undefined;

  beforeEach(() => { original = process.env[KEY]; });
  afterEach(() => {
    if (original === undefined) delete process.env[KEY]; else process.env[KEY] = original;
  });

  it('returns null when COMMITTEE_SWARM_ENABLED is not "true" (scheduler not armed)', () => {
    delete process.env[KEY];
    expect(startCommitteeEvolution(db)).toBeNull();
  });

  it('returns a stop function that clears the interval when enabled', () => {
    process.env[KEY] = 'true';
    const stop = startCommitteeEvolution(db, 100);
    expect(typeof stop).toBe('function');
    expect(() => stop()).not.toThrow();
  });
});