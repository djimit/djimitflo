import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { activeMembers, claimCommittee, enqueueCommittee, evolveCommittee, memberContext, recordCommittee, SEED_MEMBERS, EXTINCT_MIN_N } from '../services/committee-swarm';
import { forecastScores } from '../services/forecast-scoring';

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db); });
afterEach(() => { vi.unstubAllEnvs(); db.close(); });
const prop = (id: string, status = 'proposed', created = new Date().toISOString()) => db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, created_at, updated_at)
  VALUES (?, 'test', ?, 'Add tests for x.ts', 'untested', 'gap_analysis', ?, 0.5, ?, ?)`).run(id, `Add unit tests ${id}`, status, created, created);

it('AR-W: one committee job per new proposal, off by default, capped per day; the workstation claims it with the active members', async () => {
  prop('p1');
  expect(enqueueCommittee(db, { id: 'p1', title: 't', source: 'gap_analysis' })).toBeNull(); // flag off
  vi.stubEnv('COMMITTEE_SWARM_ENABLED', 'true'); vi.stubEnv('COMMITTEE_MAX_PER_DAY', '2');
  const job = enqueueCommittee(db, { id: 'p1', title: 't', source: 'gap_analysis' });
  expect(job).toBeTruthy();
  expect(enqueueCommittee(db, { id: 'p1', title: 't', source: 'gap_analysis' })).toBeNull(); // once per proposal
  enqueueCommittee(db, { id: 'p2', title: 't', source: 'gap_analysis' });
  expect(enqueueCommittee(db, { id: 'p3', title: 't', source: 'gap_analysis' })).toBeNull(); // daily cap
  const claim = (await claimCommittee(db, 'workstation'))!;
  expect(claim.jobId).toBe(job);
  expect(claim.members.map((m) => m.id)).toEqual(SEED_MEMBERS.map((m) => m.id).sort());
  expect(activeMembers(db)).toHaveLength(SEED_MEMBERS.length);
  expect(claim.members.every((m) => typeof m.context === 'string')).toBe(true);
});

it('AR-W: member forecasts become forecast:committee:<member> rows; scoring counts them from as_of (before the goal), not from when they were written', async () => {
  vi.stubEnv('COMMITTEE_SWARM_ENABLED', 'true');
  const asOf = new Date(Date.now() - 3 * 3_600_000);
  prop('p1', 'verified', asOf.toISOString()); prop('p2', 'needs_more_evidence', asOf.toISOString());
  const j1 = enqueueCommittee(db, { id: 'p1', title: 't', source: 'gap_analysis' }, asOf)!;
  const j2 = enqueueCommittee(db, { id: 'p2', title: 't', source: 'gap_analysis' }, asOf)!;
  // the goals were created after the question was frozen, but before the workstation answered
  for (const p of ['p1', 'p2']) db.prepare("INSERT INTO goals (id, objective, risk_class, status, improvement_id, created_at, updated_at) VALUES (?, 'g', 'low', 'completed', ?, ?, ?)").run(`g-${p}`, p, new Date(Date.now() - 2 * 3_600_000).toISOString(), new Date().toISOString());
  for (const _ of [j1, j2]) await claimCommittee(db, 'workstation');
  expect(() => recordCommittee(db, j1, 'other-host', [])).toThrow('COMMITTEE_JOB_NOT_FOUND');
  expect(recordCommittee(db, j1, 'workstation', [{ member: 'cm-oracle', p: 0.8 }, { member: 'cm-skeptic', p: 0.3 }, { member: 'nobody', p: 0.5 }, { member: 'cm-engineer', p: 2 }])).toBe(2);
  recordCommittee(db, j2, 'workstation', [{ member: 'cm-oracle', p: 0.2 }]);
  expect(() => recordCommittee(db, j1, 'workstation', [])).toThrow('COMMITTEE_JOB_ALREADY_DONE');
  const oracle = forecastScores(db).find((s) => s.forecaster === 'forecast:committee:cm-oracle');
  expect(oracle).toMatchObject({ n: 2, positives: 1 });
});

it('AR-W3: recipes give members Djimitflo knowledge — expert claims, promoted rules, verified examples — never outcomes', async () => {
  db.prepare(`INSERT INTO expert_claims (id, expert_id, subject, relation, object, evidence_refs_json, confidence, created_at)
    VALUES ('c1', 'e', 'mutation testing', 'improves', 'fault detection', '["paper:x"]', 0.8, datetime('now'))`).run();
  db.prepare(`INSERT INTO memory_candidates (id, title, content, memory_type, source_ref, status, promotion_status, sensitivity, created_at, updated_at)
    VALUES ('r1', 'One file per change', 'Keep a maker change inside the named file.', 'engineering_rule', 'x', 'promoted', 'promoted', 'normal', datetime('now'), datetime('now'))`).run();
  prop('v1', 'verified'); db.prepare("UPDATE self_improvements SET title = 'Test untested exports of a.ts' WHERE id = 'v1'").run();
  const q = { proposal: { title: 'Raise the mutation score of x.ts', description: 'mutation testing for x', source: 'gap_analysis' } };
  expect(await memberContext(db, 'experts', q, 'p9')).toContain('mutation testing improves fault detection');
  expect(await memberContext(db, 'memory', q, 'p9')).toContain('One file per change');
  expect(await memberContext(db, 'skills', q, 'p9')).toContain('Test untested exports of a.ts');
  expect(await memberContext(db, 'none', q, 'p9')).toBe('');
});

it('AR-W3: the committee records its own skill-weighted forecast next to the members', async () => {
  vi.stubEnv('COMMITTEE_SWARM_ENABLED', 'true');
  prop('p1');
  const j = enqueueCommittee(db, { id: 'p1', title: 't', source: 'gap_analysis' })!;
  await claimCommittee(db, 'workstation');
  recordCommittee(db, j, 'workstation', [{ member: 'cm-oracle', p: 0.2 }, { member: 'cm-skeptic', p: 0.6 }]);
  const agg = db.prepare("SELECT answers_json FROM judgments WHERE judgment = 'forecast:committee'").get() as { answers_json: string };
  expect(JSON.parse(agg.answers_json).p).toBeCloseTo(0.4, 3); // equal weights below 10 resolved forecasts
});

it('AR-W3: survival of the fittest — no extinction below n = 30; the best member reproduces once a day with one gene changed', () => {
  vi.stubEnv('COMMITTEE_SWARM_ENABLED', 'true');
  const at = (d: number) => new Date(Date.now() - d * 3_600_000).toISOString();
  enqueueCommittee(db, { id: 'seed', title: 't', source: 'gap_analysis' }); // seeds the members
  // resolved proposals; oracle forecasts well, skeptic badly
  const N = EXTINCT_MIN_N + 2;
  for (let i = 0; i < N; i++) {
    const verified = i % 4 === 0;
    prop(`r${i}`, verified ? 'verified' : 'needs_more_evidence', at(100));
    const f = (member: string, p: number) => db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, answers_json, created_at)
      VALUES (?, ?, 'self_improvement', ?, 'j', 'shadow', 'yes', ?, ?)`).run(`${member}-${i}`, `forecast:committee:${member}`, `r${i}`, JSON.stringify({ p, as_of: at(99) }), at(99));
    f('cm-oracle', verified ? 0.8 : 0.1);
    f('cm-skeptic', verified ? 0.1 : 0.9);
    if (i < 5) f('cm-scout', 0.9); // too few forecasts to be judged
  }
  const r = evolveCommittee(db);
  expect(r.retired).toEqual(['cm-skeptic']);
  const child = db.prepare('SELECT parent_id, persona, knowledge, lines_json FROM committee_genomes WHERE id = ?').get(r.born) as { parent_id: string; persona: string; knowledge: string; lines_json: string };
  expect(child.parent_id).toBe('cm-oracle');
  const parent = SEED_MEMBERS.find((m) => m.id === 'cm-oracle')!;
  const genesChanged = Number(child.knowledge !== parent.knowledge) + Number(child.lines_json !== JSON.stringify(parent.lines));
  expect(genesChanged).toBe(1);
  expect(evolveCommittee(db).born).toBeNull(); // once a day
});
