import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { activeMembers, claimCommittee, enqueueCommittee, recordCommittee, SEED_MEMBERS } from '../services/committee-swarm';
import { forecastScores } from '../services/forecast-scoring';

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db); });
afterEach(() => { vi.unstubAllEnvs(); db.close(); });
const prop = (id: string, status = 'proposed', created = new Date().toISOString()) => db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, created_at, updated_at)
  VALUES (?, 'test', ?, 'Add tests for x.ts', 'untested', 'gap_analysis', ?, 0.5, ?, ?)`).run(id, `Add unit tests ${id}`, status, created, created);

it('AR-W: one committee job per new proposal, off by default, capped per day; the workstation claims it with the active members', () => {
  prop('p1');
  expect(enqueueCommittee(db, { id: 'p1', title: 't', source: 'gap_analysis' })).toBeNull(); // flag off
  vi.stubEnv('COMMITTEE_SWARM_ENABLED', 'true'); vi.stubEnv('COMMITTEE_MAX_PER_DAY', '2');
  const job = enqueueCommittee(db, { id: 'p1', title: 't', source: 'gap_analysis' });
  expect(job).toBeTruthy();
  expect(enqueueCommittee(db, { id: 'p1', title: 't', source: 'gap_analysis' })).toBeNull(); // once per proposal
  enqueueCommittee(db, { id: 'p2', title: 't', source: 'gap_analysis' });
  expect(enqueueCommittee(db, { id: 'p3', title: 't', source: 'gap_analysis' })).toBeNull(); // daily cap
  const claim = claimCommittee(db, 'workstation')!;
  expect(claim.jobId).toBe(job);
  expect(claim.members.map((m) => m.id)).toEqual(SEED_MEMBERS.map((m) => m.id).sort());
  expect(activeMembers(db)).toHaveLength(5);
});

it('AR-W: member forecasts become forecast:committee:<member> rows; scoring counts them from as_of (before the goal), not from when they were written', () => {
  vi.stubEnv('COMMITTEE_SWARM_ENABLED', 'true');
  const asOf = new Date(Date.now() - 3 * 3_600_000);
  prop('p1', 'verified', asOf.toISOString()); prop('p2', 'needs_more_evidence', asOf.toISOString());
  const j1 = enqueueCommittee(db, { id: 'p1', title: 't', source: 'gap_analysis' }, asOf)!;
  const j2 = enqueueCommittee(db, { id: 'p2', title: 't', source: 'gap_analysis' }, asOf)!;
  // the goals were created after the question was frozen, but before the workstation answered
  for (const p of ['p1', 'p2']) db.prepare("INSERT INTO goals (id, objective, risk_class, status, improvement_id, created_at, updated_at) VALUES (?, 'g', 'low', 'completed', ?, ?, ?)").run(`g-${p}`, p, new Date(Date.now() - 2 * 3_600_000).toISOString(), new Date().toISOString());
  for (const j of [j1, j2]) claimCommittee(db, 'workstation');
  expect(() => recordCommittee(db, j1, 'other-host', [])).toThrow('COMMITTEE_JOB_NOT_FOUND');
  expect(recordCommittee(db, j1, 'workstation', [{ member: 'cm-oracle', p: 0.8 }, { member: 'cm-skeptic', p: 0.3 }, { member: 'nobody', p: 0.5 }, { member: 'cm-engineer', p: 2 }])).toBe(2);
  recordCommittee(db, j2, 'workstation', [{ member: 'cm-oracle', p: 0.2 }]);
  expect(() => recordCommittee(db, j1, 'workstation', [])).toThrow('COMMITTEE_JOB_ALREADY_DONE');
  const oracle = forecastScores(db).find((s) => s.forecaster === 'forecast:committee:cm-oracle');
  expect(oracle).toMatchObject({ n: 2, positives: 1 });
});
