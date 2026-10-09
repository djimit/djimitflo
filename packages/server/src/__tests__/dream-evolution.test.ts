import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { BASELINE_GENOME, genome } from '../services/genome-registry';
import { dreamInputs, dreamOnce, evaluateTrials, failureClusters, guardLines, mcnemarOneSided } from '../services/dream-evolution';

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db); vi.stubEnv('DREAM_EVOLUTION_ENABLED', 'true'); });
afterEach(() => { vi.unstubAllEnvs(); db.close(); });

const NOW = Date.parse('2026-10-01T02:00:00Z');
const gymRun = (id: string, commit: string, genomeId: string | undefined, status: string, reason: string, created = '2026-10-01T01:00:00Z') => db.prepare(`INSERT INTO loop_runs
  (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
  VALUES (?, 'evolution-gym', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, ?, ?)`).run(id, JSON.stringify({ gym: { commit, source: 'packages/server/src/services/x.ts', species: 'atomic@llama-router', genome: genomeId }, gym_result: { status, reason } }), created, created);

it('D3: trial runs and holdout tasks never reach the mutation step (prod 03-10: mutants were written from holdout failures)', () => {
  db.prepare("INSERT INTO gym_holdout (commit_sha, created_at) VALUES ('h1', ?)").run('2026-10-01T00:00:00Z');
  db.prepare("INSERT INTO gym_mutant_holdout (key, task_json, created_at) VALUES ('mut:m1', '{}', ?)").run('2026-10-01T00:00:00Z');
  gymRun('t1', 'c9', BASELINE_GENOME, 'failure', 'trial red');        // a trial attempt
  gymRun('h', 'h1', undefined, 'failure', 'holdout red');             // a mined holdout task outside a trial
  gymRun('m', 'mut:m1', undefined, 'failure', 'mutant holdout red');  // a mutant holdout task
  gymRun('ok', 'c2', undefined, 'failure', 'normal replay red');
  expect(dreamInputs(db, NOW).failures).toEqual(['gym: packages/server/src/services/x.ts — normal replay red']);
});

it('WT-HOLDOUT: a write_test holdout task never reaches the mutation step either (flat list and evidence clusters)', () => {
  db.prepare("INSERT INTO gym_write_test_holdout (key, task_json, created_at, epoch) VALUES ('fail:w1', '{}', ?, 0)").run('2026-10-01T00:00:00Z');
  gymRun('w', 'fail:w1', undefined, 'failure', 'write_test holdout red');
  gymRun('ok', 'c2', undefined, 'failure', 'normal replay red');
  expect(dreamInputs(db, NOW).failures).toEqual(['gym: packages/server/src/services/x.ts — normal replay red']);
  expect(failureClusters(db, NOW).flatMap((c) => c.excerpts.map((e) => e.reason))).toEqual(['normal replay red']);
});

it('Y3b: the guard keeps strategy lines and drops anything that steers gates, checks, scope, secrets, deploy or the tests', () => {
  expect(guardLines(['Read the failing assertion before changing code.', 'Keep the fix inside the named source file.'])).toHaveLength(2);
  for (const bad of ['Skip the lint step when slow.', 'Edit the test so it passes.', 'Ask for approval to widen scope.', 'Use the deploy token.', 'Disable the checker.',
    'Commit the smallest confirmed improvement.', 'Stash unrelated edits first.', 'Reset the file when stuck.'])
    expect(guardLines(['Fine line.', bad])).toBeNull();
  expect(guardLines([])).toBeNull();
  expect(guardLines(['x'.repeat(201)])).toBeNull();
  expect(guardLines(Array.from({ length: 6 }, (_, i) => `line ${i}`))).toBeNull();
});

it('Y3b: one dream a day turns the day\'s failures into ≤ 3 guarded one-gene trial mutants of the active genome', async () => {
  gymRun('f1', 'c1', undefined, 'failure', 'tests still red');
  const call = vi.fn(async () => 'Here you go:\n{"mutants":[' +
    '{"gene":"strategy_lines","lines":["Run the named test first and read its assertion."],"rationale":"red tests"},' +
    '{"gene":"anti_pattern","lines":["changing files other than the named source"],"rationale":"scope"},' +
    '{"gene":"strategy_lines","lines":["Edit the test to match the code."],"rationale":"cheat"},' +
    '{"gene":"genes_are_free","lines":["x"]}]}');
  const result = await dreamOnce(db, NOW, call);
  expect(result.created).toHaveLength(2);
  expect(call.mock.calls[0][0]).toContain('gym: packages/server/src/services/x.ts — tests still red');
  const anti = result.created.map((id) => genome(db, id)!).find((g) => g.gene === 'anti_pattern')!;
  expect(anti).toMatchObject({ parent_id: BASELINE_GENOME, status: 'trial', lines: ['Avoid: changing files other than the named source'] });
  expect((await dreamOnce(db, NOW, call)).skipped).toBe('already dreamt today');
  vi.stubEnv('DREAM_EVOLUTION_ENABLED', 'false');
  expect((await dreamOnce(db, NOW + 86_400_000, call)).skipped).toBe('disabled');
});

it('Y3c/Z5: a trial is promoted only on a significant paired win (5 vs 0 discordant, p = 0.031) and ≤ 1 a day', async () => {
  gymRun('f1', 'c1', undefined, 'failure', 'tests still red');
  const [good, bad] = (await dreamOnce(db, NOW, async () => '{"mutants":[{"gene":"strategy_lines","lines":["A"]},{"gene":"strategy_lines","lines":["B"]}]}')).created;
  const holdout = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
  holdout.forEach((c, i) => gymRun(`p${i}`, c, BASELINE_GENOME, i === 0 ? 'success' : 'failure', i === 0 ? 'tests green, source only' : 'tests still red'));
  holdout.forEach((c, i) => gymRun(`g${i}`, c, good, 'success', 'tests green, source only'));
  holdout.slice(0, 5).forEach((c, i) => gymRun(`b${i}`, c, bad, 'success', 'tests green, source only'));
  expect(evaluateTrials(db, 'atomic@llama-router', holdout, NOW)).toEqual([{ id: good, status: 'active', wins: 6, parentWins: 1 }]); // bad not complete yet
  gymRun('b5', 'h6', bad, 'success', 'tests green, source only');
  expect(evaluateTrials(db, 'atomic@llama-router', holdout, NOW)).toEqual([{ id: bad, status: 'retired', wins: 6, parentWins: 1 }]); // ≤ 1 promotion a day
  expect(genome(db, good)!.status).toBe('active');
  expect((db.prepare('SELECT note FROM maker_genomes WHERE id = ?').get(good) as { note: string }).note).toContain('discordant 5 vs 0, McNemar p=0.031');
});

it('Z5: "+2 wins" on a 20-task holdout at an 80 % base rate (3 vs 1 discordant) is noise and retires', async () => {
  gymRun('f1', 'c1', undefined, 'failure', 'tests still red');
  const [mutant] = (await dreamOnce(db, NOW, async () => '{"mutants":[{"gene":"strategy_lines","lines":["A"]}]}')).created;
  const holdout = Array.from({ length: 20 }, (_, i) => `h${i}`);
  // parent 17/20 (red on h0..h2), mutant 19/20 (red on h3): +2 wins = 3 vs 1 discordant pairs
  holdout.forEach((c, i) => gymRun(`p${i}`, c, BASELINE_GENOME, i >= 3 ? 'success' : 'failure', 'r'));
  holdout.forEach((c, i) => gymRun(`m${i}`, c, mutant, i !== 3 ? 'success' : 'failure', 'r'));
  expect(evaluateTrials(db, 'atomic@llama-router', holdout, NOW)).toEqual([{ id: mutant, status: 'retired', wins: 19, parentWins: 17 }]);
  expect(mcnemarOneSided(3, 1)).toBeCloseTo(0.3125);
  expect(mcnemarOneSided(5, 0)).toBeCloseTo(0.03125);
  expect(mcnemarOneSided(0, 0)).toBe(1);
});

it('GENOME_FIRE_CHECK: VOID attempts (genome lines never reached the maker) are excluded from the paired comparison and counted', async () => {
  gymRun('f1', 'c1', undefined, 'failure', 'tests still red');
  const [trial] = (await dreamOnce(db, NOW, async () => '{"mutants":[{"gene":"strategy_lines","lines":["A"]}]}')).created;
  const holdout = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
  holdout.forEach((c, i) => gymRun(`p${i}`, c, BASELINE_GENOME, i === 0 ? 'success' : 'failure', i === 0 ? 'tests green, source only' : 'tests still red'));
  gymRun('g0', 'h1', trial, 'success', 'tests green, source only');
  // h2..h6: three 'successes' each whose prompt never carried the genome's lines — treatment = control
  const voided = db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES (?, 'evolution-gym', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, '2026-10-01T01:00:00Z', '2026-10-01T01:00:00Z')`);
  holdout.slice(1).forEach((c) => { for (let k = 0; k < 3; k++) voided.run(`v-${c}-${k}`, JSON.stringify({ gym: { commit: c, species: 'atomic@llama-router', genome: trial }, gym_result: { status: 'success', reason: 'tests green, source only', void: 'fire_check: no evidence that the genome lines reached the maker' } })); });
  // only h1 is paired (0 vs 0 discordant): no promotion on 15 attempts that never tested the genome
  expect(evaluateTrials(db, 'atomic@llama-router', holdout, NOW)).toEqual([{ id: trial, status: 'retired', wins: 1, parentWins: 1 }]);
  expect((db.prepare('SELECT note FROM maker_genomes WHERE id = ?').get(trial) as { note: string }).note).toContain('discordant 0 vs 0, McNemar p=1.000; out of scope 0 vs 0; void 15 (fire check)');
});
