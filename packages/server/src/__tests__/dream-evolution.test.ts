import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { BASELINE_GENOME, genome } from '../services/genome-registry';
import { dreamOnce, evaluateTrials, guardLines } from '../services/dream-evolution';

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db); vi.stubEnv('DREAM_EVOLUTION_ENABLED', 'true'); });
afterEach(() => { vi.unstubAllEnvs(); db.close(); });

const NOW = Date.parse('2026-10-01T02:00:00Z');
const gymRun = (id: string, commit: string, genomeId: string, status: string, reason: string, created = '2026-10-01T01:00:00Z') => db.prepare(`INSERT INTO loop_runs
  (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
  VALUES (?, 'evolution-gym', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, ?, ?)`).run(id, JSON.stringify({ gym: { commit, source: 'packages/server/src/services/x.ts', species: 'atomic@llama-router', genome: genomeId }, gym_result: { status, reason } }), created, created);

it('Y3b: the guard keeps strategy lines and drops anything that steers gates, checks, scope, secrets, deploy or the tests', () => {
  expect(guardLines(['Read the failing assertion before changing code.', 'Keep the fix inside the named source file.'])).toHaveLength(2);
  for (const bad of ['Skip the lint step when slow.', 'Edit the test so it passes.', 'Ask for approval to widen scope.', 'Use the deploy token.', 'Disable the checker.'])
    expect(guardLines(['Fine line.', bad])).toBeNull();
  expect(guardLines([])).toBeNull();
  expect(guardLines(['x'.repeat(201)])).toBeNull();
  expect(guardLines(Array.from({ length: 6 }, (_, i) => `line ${i}`))).toBeNull();
});

it('Y3b: one dream a day turns the day\'s failures into ≤ 3 guarded one-gene trial mutants of the active genome', async () => {
  gymRun('f1', 'c1', BASELINE_GENOME, 'failure', 'tests still red');
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

it('Y3c: a trial is promoted only with ≥ 2 more paired holdout wins and no more out-of-scope changes; otherwise retired', async () => {
  gymRun('f1', 'c1', BASELINE_GENOME, 'failure', 'tests still red');
  const [good, bad] = (await dreamOnce(db, NOW, async () => '{"mutants":[{"gene":"strategy_lines","lines":["A"]},{"gene":"strategy_lines","lines":["B"]}]}')).created;
  const holdout = ['h1', 'h2', 'h3', 'h4'];
  holdout.forEach((c, i) => gymRun(`p${i}`, c, BASELINE_GENOME, i === 0 ? 'success' : 'failure', i === 0 ? 'tests green, source only' : 'tests still red'));
  holdout.forEach((c, i) => gymRun(`g${i}`, c, good, i < 3 ? 'success' : 'failure', i < 3 ? 'tests green, source only' : 'tests still red'));
  holdout.slice(0, 3).forEach((c, i) => gymRun(`b${i}`, c, bad, 'success', 'tests green, source only'));
  expect(evaluateTrials(db, 'atomic@llama-router', holdout, NOW)).toEqual([{ id: good, status: 'active', wins: 3, parentWins: 1 }]); // bad not complete yet
  gymRun('b3', 'h4', bad, 'failure', 'out of scope: packages/server/src/services/y.ts');
  expect(evaluateTrials(db, 'atomic@llama-router', holdout, NOW)).toEqual([{ id: bad, status: 'retired', wins: 3, parentWins: 1 }]); // ≤ 1 promotion a day
  expect(genome(db, good)!.status).toBe('active');
});
