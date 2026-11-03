import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { BASELINE_GENOME, frozenHoldoutCommits, mutantHoldout, mutantHoldoutKeys, nextTrialAttempt, writeTestHoldoutKeys } from '../services/genome-registry';
import { evaluateTrials, gatedEvidence, mcnemarOneSided, minWinsNeeded, settleNoHeadroom, trialPower } from '../services/dream-evolution';
import { HOLDOUT_REUSE_LIMIT } from '../services/evolution-evidence';
import { holdoutReuseLimit } from '../services/genome-promotion';

/**
 * prod 26-10 (operator "Fix trial headroom"): which set decides a genome trial on the epoch-1 manifest holdout
 * (frozen 14-10: 40 mined, role no-regression in the manifest; 40 seeded mutants tiers 3–6, deciding; 5 write_test).
 * The deciding mutants are the ones the manifest froze. DREAM_TRIAL_MUTANT_TIERS unset (prod until 22-10 20:05Z) used to
 * filter them down to the 10 tier-3 tasks, where the parent fails ~3: "no_headroom: parent fails 3 of 10" for a parent
 * that passes only 60 % of the deciding set.
 */
const SPECIES = 'atomic@llama-router';
const FROZEN_0 = '2026-10-01T00:00:00Z'; const FROZEN_1 = '2026-10-14T10:00:00Z';
const AFTER = '2026-10-20T12:00:00Z'; const NOW = Date.parse('2026-10-26T12:00:00Z');
const MINED_0 = Array.from({ length: 20 }, (_, i) => `m0-${String(i).padStart(2, '0')}`);
const MUT_0 = Array.from({ length: 20 }, (_, i) => ({ key: `mut0-${String(i).padStart(2, '0')}`, tier: 2 + (i % 2) }));
const MINED_1 = Array.from({ length: 40 }, (_, i) => `m1-${String(i).padStart(2, '0')}`);
const MUT_1 = [3, 4, 5, 6].flatMap((tier) => Array.from({ length: 10 }, (_, i) => ({ key: `mut1-t${tier}-${i}`, tier })));
const WT_1 = Array.from({ length: 5 }, (_, i) => `fail:run-${i}`);
/** parent failures per epoch-1 tier: 3 + 4 + 4 + 5 = 16 of 40 → 60 % pass (prod gym: tier 3 73 %, 4 66 %, 5 61 %, 6 54 %) */
const FAILS_PER_TIER: Record<number, number> = { 3: 3, 4: 4, 5: 4, 6: 5 };
const PARENT_FAILS_1 = new Set(MUT_1.filter((m) => Number(m.key.split('-').pop()) < FAILS_PER_TIER[m.tier]).map((m) => m.key));

let db: Database.Database; let seq = 0;
const mutantJson = (key: string, tier: number) => JSON.stringify({ commit: key, base: 'b'.repeat(40), source: `packages/server/src/services/${key}.ts`, tests: ['t.test.ts'], sourceLines: 9, mutant: 'x', tier });
/** one production-gated, eligible scored attempt (#819): a success carries its own gate map */
const run = (commit: string, genomeId: string, ok: boolean, at = AFTER, gym: Record<string, unknown> = {}) => db.prepare(`INSERT INTO loop_runs
  (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
  VALUES (?, 'evolution-gym', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, ?, ?)`).run(`r${String(seq++).padStart(5, '0')}`, JSON.stringify({
  gym: { commit, species: SPECIES, genome: genomeId, prod_gates: 1, ...gym },
  gym_result: { status: ok ? 'success' : 'failure', reason: ok ? 'tests green, source only' : 'tests still red', ...(ok ? { prod_gates: { lint: 'pass', 'type-check': 'pass' } } : {}) } }), at, at);
const tierOf = (key: string) => MUT_1.find((m) => m.key === key)?.tier ?? MUT_0.find((m) => m.key === key)?.tier;
const trial = (id: string, created = '2026-10-16T23:50:32Z') => db.prepare("INSERT INTO maker_genomes (id, parent_id, gene, lines_json, origin, status, created_at, updated_at) VALUES (?, ?, 'strategy_lines', '[\"x\"]', 'dream', 'trial', ?, ?)")
  .run(id, BASELINE_GENOME, created, created);
const genomeRow = (id: string) => db.prepare('SELECT status, note FROM maker_genomes WHERE id = ?').get(id) as { status: string; note: string | null };
const trialRow = (id: string) => db.prepare('SELECT tier_set, deciding_n, f_parent_failures, state, epoch FROM genome_trial_results WHERE trial_id = ?').get(id);
/** the parent on the whole epoch-1 holdout: mined 29/40 (~71 %), mutants 24/40 (60 %), write_test 5/5 */
const parentOnEpoch1 = (minedFails = 11) => {
  MINED_1.forEach((c, i) => run(c, BASELINE_GENOME, i >= minedFails));
  MUT_1.forEach((m) => run(m.key, BASELINE_GENOME, !PARENT_FAILS_1.has(m.key), AFTER, { tier: m.tier }));
  WT_1.forEach((k) => run(k, BASELINE_GENOME, true, AFTER, { kind: 'write_test' }));
};
const epoch0Rows = () => ['gym_holdout', 'gym_mutant_holdout', 'gym_write_test_holdout'].map((t) => db.prepare(`SELECT * FROM ${t} WHERE epoch = 0 ORDER BY 1`).all());

beforeEach(() => {
  db = new Database(':memory:'); db.exec(schema); runMigrations(db);
  db.prepare("INSERT INTO maker_genomes (id, gene, lines_json, origin, status, created_at, updated_at) VALUES (?, 'baseline', '[]', 'baseline', 'active', ?, ?)")
    .run(BASELINE_GENOME, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');
  // epoch 0 (claim-time, 01-10): 20 mined + 20 tier 2–3 mutants; the parent passed 17 of those mutants (the 06-10..09-10 trials)
  for (const c of MINED_0) db.prepare('INSERT INTO gym_holdout (commit_sha, created_at, epoch) VALUES (?, ?, 0)').run(c, FROZEN_0);
  for (const m of MUT_0) db.prepare('INSERT INTO gym_mutant_holdout (key, task_json, created_at, epoch) VALUES (?, ?, ?, 0)').run(m.key, mutantJson(m.key, m.tier), FROZEN_0);
  MUT_0.forEach((m, i) => run(m.key, BASELINE_GENOME, i >= 3, '2026-10-08T00:00:00Z', { tier: m.tier }));
  // epoch 1 (manifest, 14-10): what holdout-manifest.ts writes (mined rows carry role 'deciding'; the manifest's evaluation
  // policy names them no_regression because the mutants decide)
  for (const c of MINED_1) db.prepare("INSERT INTO gym_holdout (commit_sha, created_at, epoch, role) VALUES (?, ?, 1, 'deciding')").run(c, FROZEN_1);
  for (const m of MUT_1) db.prepare("INSERT INTO gym_mutant_holdout (key, task_json, created_at, epoch, role) VALUES (?, ?, ?, 1, 'deciding')").run(m.key, mutantJson(m.key, m.tier), FROZEN_1);
  for (const k of WT_1) db.prepare("INSERT INTO gym_write_test_holdout (key, task_json, created_at, epoch, role) VALUES (?, ?, ?, 1, 'deciding')").run(k, JSON.stringify({ commit: k, kind: 'write_test' }), FROZEN_1);
  db.prepare(`INSERT INTO gym_holdout_freezes (epoch, manifest_sha256, frozen_at, origin_sha, version, holdout_size, counts_json, operator, manifest_json)
    VALUES (1, ?, ?, 'x', null, 40, '{}', 'operator', ?)`).run('3'.repeat(64), FROZEN_1, JSON.stringify({ evaluation_policy: { deciding: 'mutant', mined_role: 'no_regression' }, tasks: { mutant: { generated_at_freeze: true, proposed_tiers: [3, 4, 5, 6] } } }));
  // prod 26-10
  for (const [k, v] of Object.entries({ DREAM_EVOLUTION_ENABLED: 'true', DREAM_TRIAL_MUTANTS: 'true', DREAM_PROMOTION_RULE: 'both', TRIAL_HEADROOM_PRECHECK: 'true',
    DREAM_TRIAL_WRITE_TEST_HOLDOUT: 'true', GYM_HOLDOUT_EPOCH: '1', GYM_PROD_GATES: 'true', TRIAL_DIAGNOSTICS_ENABLED: 'true' })) vi.stubEnv(k, v);
});
afterEach(() => { vi.unstubAllEnvs(); db.close(); });

describe('the epoch-1 deciding set is the 40 manifest mutants', () => {
  it.each([['unset (code default 2,3)', undefined], ['3,4,5,6 (prod 26-10)', '3,4,5,6'], ['4,5 (a narrower set)', '4,5']])(
    'DREAM_TRIAL_MUTANT_TIERS %s: all 40 frozen deciding mutants, never an epoch-0 task', (_label, tiers) => {
      if (tiers) vi.stubEnv('DREAM_TRIAL_MUTANT_TIERS', tiers); else vi.stubEnv('DREAM_TRIAL_MUTANT_TIERS', '');
      expect(mutantHoldoutKeys(db)).toEqual(MUT_1.map((m) => m.key).sort());
      // the claim path reads the same set and never freezes more for a manifest epoch
      const make = vi.fn(() => null);
      expect(mutantHoldout(db, make).map((m) => m.commit).sort()).toEqual(MUT_1.map((m) => m.key).sort());
      expect(make).not.toHaveBeenCalled();
    });

  it('a 60 %-pass parent on the deciding mutants has headroom: the trial is not settled no_headroom (tiers unset, as prod 16-10..22-10)', () => {
    vi.stubEnv('DREAM_TRIAL_MUTANT_TIERS', '');
    trial('g-a187f81f'); parentOnEpoch1();
    const deciding = mutantHoldoutKeys(db);
    const parent = gatedEvidence(db, SPECIES, BASELINE_GENOME, deciding);
    expect(parent.byKey.size).toBe(40);
    expect([...parent.byKey.values()].filter((o) => o.status === 'failure')).toHaveLength(16);
    expect(settleNoHeadroom(db, SPECIES, frozenHoldoutCommits(db), deciding, NOW, writeTestHoldoutKeys(db))).toEqual([]);
    expect(genomeRow('g-a187f81f').status).toBe('trial');
    // the parent's deciding set is complete, so the mutant's attempts are served next (deciding mutants included)
    const next = nextTrialAttempt(db, SPECIES, [...frozenHoldoutCommits(db), ...deciding, ...writeTestHoldoutKeys(db)]);
    expect(next).toEqual({ genomeId: 'g-a187f81f', commit: MINED_1[0] });
  });

  it('a parent that fails only 3 of the 40 deciding mutants is still no_headroom, recorded with the frozen tier set and n = 40', () => {
    vi.stubEnv('DREAM_TRIAL_MUTANT_TIERS', '');
    trial('g-low');
    MINED_1.forEach((c) => run(c, BASELINE_GENOME, true));
    MUT_1.forEach((m, i) => run(m.key, BASELINE_GENOME, i >= 3, AFTER, { tier: m.tier }));
    WT_1.forEach((k) => run(k, BASELINE_GENOME, true, AFTER, { kind: 'write_test' }));
    expect(settleNoHeadroom(db, SPECIES, frozenHoldoutCommits(db), mutantHoldoutKeys(db), NOW, writeTestHoldoutKeys(db))).toEqual([{ id: 'g-low', f: 3, n: 40, needed: 5 }]);
    expect(trialRow('g-low')).toEqual({ tier_set: '3,4,5,6', deciding_n: 40, f_parent_failures: 3, state: 'no_headroom', epoch: 1 });
  });
});

describe('the mined holdout is a no-regression check only', () => {
  it('with mutant trials on and no deciding mutants, the precheck never falls back to the mined holdout', () => {
    trial('g-m');
    MINED_1.forEach((c, i) => run(c, BASELINE_GENOME, i >= 2)); // parent fails 2 of 40 mined: would be "no headroom" on mined
    expect(settleNoHeadroom(db, SPECIES, frozenHoldoutCommits(db), [], NOW)).toEqual([]);
    expect(genomeRow('g-m').status).toBe('trial');
  });

  it('parent failures on the mined holdout never count as deciding headroom', () => {
    vi.stubEnv('DREAM_TRIAL_MUTANT_TIERS', '3,4,5,6');
    trial('g-h');
    MINED_1.forEach((c, i) => run(c, BASELINE_GENOME, i >= 20)); // 20 mined failures
    MUT_1.forEach((m, i) => run(m.key, BASELINE_GENOME, i >= 3, AFTER, { tier: m.tier })); // 3 deciding failures
    WT_1.forEach((k) => run(k, BASELINE_GENOME, true, AFTER, { kind: 'write_test' }));
    expect(settleNoHeadroom(db, SPECIES, frozenHoldoutCommits(db), mutantHoldoutKeys(db), NOW, writeTestHoldoutKeys(db))).toEqual([{ id: 'g-h', f: 3, n: 40, needed: 5 }]);
  });

  const mutantRuns = (id: string, minedFn: (i: number) => boolean, mutWins: number) => {
    MINED_1.forEach((c, i) => run(c, id, minedFn(i)));
    let won = 0;
    MUT_1.forEach((m) => { const parentFailed = PARENT_FAILS_1.has(m.key); const win = parentFailed && won < mutWins; if (win) won++; run(m.key, id, !parentFailed || win, AFTER, { tier: tierOf(m.key) }); });
    WT_1.forEach((k) => run(k, id, true, AFTER, { kind: 'write_test' }));
  };
  it.each([
    ['mined wins alone never promote (mutants tied)', (i: number) => i >= 0, 0, 'retired'],
    ['8 of 16 deciding failures fixed, mined net loss 2 → retired', (i: number) => i >= 13, 8, 'retired'],
    ['8 of 16 deciding failures fixed, mined net loss 1 → active', (i: number) => i >= 12, 8, 'active'],
  ] as const)('%s', (_label, minedFn, mutWins, want) => {
    vi.stubEnv('DREAM_TRIAL_MUTANT_TIERS', '');
    trial('g-p'); parentOnEpoch1();
    mutantRuns('g-p', minedFn, mutWins);
    const [s] = evaluateTrials(db, SPECIES, frozenHoldoutCommits(db), NOW, mutantHoldoutKeys(db), writeTestHoldoutKeys(db));
    expect(s.status).toBe(want);
    expect(trialRow('g-p')).toMatchObject({ tier_set: '3,4,5,6', deciding_n: 40, f_parent_failures: 16, epoch: 1 });
  });
});

describe('epoch 0 is never used when GYM_HOLDOUT_EPOCH=1, and is left untouched', () => {
  it('no reader returns an epoch-0 task; epoch-0 attempts are not evidence; nothing in epoch 0 changes', () => {
    vi.stubEnv('DREAM_TRIAL_MUTANT_TIERS', '');
    const before = epoch0Rows();
    trial('g-a187f81f'); trial('g-d14c1156'); parentOnEpoch1();
    const keys = [...frozenHoldoutCommits(db), ...mutantHoldoutKeys(db), ...writeTestHoldoutKeys(db)];
    expect(keys).toHaveLength(85);
    for (const k of [...MINED_0, ...MUT_0.map((m) => m.key)]) expect(keys).not.toContain(k);
    expect(gatedEvidence(db, SPECIES, BASELINE_GENOME, MUT_0.map((m) => m.key)).byKey.size).toBe(0); // frozen by another epoch: INELIGIBLE
    settleNoHeadroom(db, SPECIES, frozenHoldoutCommits(db), mutantHoldoutKeys(db), NOW, writeTestHoldoutKeys(db));
    evaluateTrials(db, SPECIES, frozenHoldoutCommits(db), NOW, mutantHoldoutKeys(db), writeTestHoldoutKeys(db));
    expect(epoch0Rows()).toEqual(before);
    expect((db.prepare('SELECT COUNT(*) AS n FROM gym_holdout_freezes').get() as { n: number }).n).toBe(1); // no new epoch
  });
});

describe('promotion thresholds are unchanged', () => {
  it('alpha, the all-wins minimum, McNemar, the reuse limit and one promotion a day', () => {
    expect(minWinsNeeded(0.05, 'mcnemar')).toBe(5); expect(minWinsNeeded(0.05, 'both')).toBe(5); expect(minWinsNeeded(0.01, 'mcnemar')).toBe(7);
    expect(minWinsNeeded()).toBe(5); // DREAM_PROMOTION_ALPHA unset → 0.05
    expect(mcnemarOneSided(5, 0)).toBeLessThan(0.05); expect(mcnemarOneSided(4, 0)).toBeGreaterThanOrEqual(0.05);
    expect(HOLDOUT_REUSE_LIMIT).toBe(10); expect(holdoutReuseLimit({})).toBe(10);
    // power at the new deciding set: parent fails 16 of 40 (60 % pass)
    expect(trialPower(16, 24, 0.8, 0.05)).toBeCloseTo(0.988, 3);
    expect(trialPower(3, 17, 0.8, 0.05)).toBe(0); // the old 3-of-20 deciding set was blind
  });

  it('a second trial that would win the same day stays inconclusive (one promotion a day)', () => {
    vi.stubEnv('DREAM_TRIAL_MUTANT_TIERS', '');
    db.prepare("INSERT INTO maker_genomes (id, parent_id, gene, lines_json, origin, status, created_at, updated_at) VALUES ('g-today', 'baseline', 'strategy_lines', '[\"y\"]', 'dream', 'active', ?, ?)")
      .run('2026-10-26T01:00:00Z', '2026-10-26T01:00:00Z');
    trial('g-2'); parentOnEpoch1();
    MINED_1.forEach((c, i) => run(c, 'g-2', i >= 11));
    MUT_1.forEach((m) => run(m.key, 'g-2', true, AFTER, { tier: m.tier }));
    WT_1.forEach((k) => run(k, 'g-2', true, AFTER, { kind: 'write_test' }));
    const [s] = evaluateTrials(db, SPECIES, frozenHoldoutCommits(db), NOW, mutantHoldoutKeys(db), writeTestHoldoutKeys(db));
    expect(s.status).not.toBe('active');
  });
});
