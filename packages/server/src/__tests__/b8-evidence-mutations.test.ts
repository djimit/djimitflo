import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { BASELINE_GENOME } from '../services/genome-registry';
import { clusterPrompt, dreamOnce, failureClusters } from '../services/dream-evolution';
import { SECRET_PATTERNS } from '../services/secret-patterns';

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF'); vi.stubEnv('DREAM_EVOLUTION_ENABLED', 'true'); });
afterEach(() => { vi.unstubAllEnvs(); db.close(); });

const NOW = Date.parse('2026-10-06T20:00:00Z');
const T = '2026-10-06T19:00:00Z';
const gymRun = (id: string, commit: string, reason: string, source = 'packages/server/src/services/x.ts', extra: Record<string, unknown> = {}) => db.prepare(`INSERT INTO loop_runs
  (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
  VALUES (?, 'evolution-gym', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, ?, ?)`).run(id, JSON.stringify({ gym: { commit, source, species: 'atomic@llama-router', ...extra }, gym_result: { status: 'failure', reason } }), T, T);
const run = (id: string, lane: string) => db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
  VALUES (?, ?, 'closed', 'failed', '[]', '{}', '[]', '[]', '{}', ?, ?)`).run(id, lane, T, T);
const lease = (id: string, runId: string, role: string, status: string, metadata: Record<string, unknown>) => db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at)
  VALUES (?, ?, ?, 'opencode', ?, ?, ?, ?)`).run(id, runId, role, status, JSON.stringify(metadata), T, T);

function seed() {
  gymRun('g1', 'c1', 'tests still red after 3 attempts');
  gymRun('g2', 'c2', 'tests still red: expected 2, got 3');
  gymRun('g3', 'c3', 'out of scope: README.md, CONTRIBUTING.md');
  run('r1', 'doc-drift-and-small-fix-loop');
  lease('m1', 'r1', 'maker', 'failed', { failure_reason: 'diff over 200 lines', changed_files: ['packages/server/src/services/loop.ts'] });
  lease('k1', 'r1', 'checker', 'completed', { maker_lease_id: 'm1', verdict: 'rejected', notes: 'touches unrelated files; token ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa leaked in note' });
}

it('B8-MUT: clustering groups seeded failures deterministically by source × reason class × lane × files × checker verdict', () => {
  seed();
  const a = failureClusters(db, NOW); const b = failureClusters(db, NOW);
  expect(a).toEqual(b);
  expect(a[0]).toMatchObject({ source: 'gym', reasonClass: 'tests_red', lane: 'gym', filePattern: 'packages/server/src/services/*.ts', checkerVerdict: null, size: 2 });
  expect(a.slice(1).map((c) => [c.source, c.reasonClass, c.lane, c.filePattern, c.checkerVerdict, c.size]).sort()).toEqual([
    ['gym', 'out_of_scope', 'gym', './*.md', null, 1],
    ['maker', 'diff_size', 'doc-drift-and-small-fix-loop', 'packages/server/src/services/*.ts', 'rejected', 1],
  ]);
  expect(a.every((c) => /^fc-[0-9a-f]{8}$/.test(c.id))).toBe(true);
});

it('B8-MUT: the prompt carries raw excerpts and cluster ids — never holdout keys, trial runs or secret patterns', async () => {
  vi.stubEnv('DREAM_EVIDENCE_MUTATIONS', 'true');
  seed();
  db.prepare("INSERT INTO gym_holdout (commit_sha, created_at) VALUES ('h1', ?)").run(T);
  db.prepare("INSERT INTO gym_mutant_holdout (key, task_json, created_at) VALUES ('mut:m1', '{}', ?)").run(T);
  gymRun('h', 'h1', 'HOLDOUT-SECRET-REASON');
  gymRun('m', 'mut:m1', 'MUTANT-HOLDOUT-REASON');
  gymRun('t', 'c9', 'TRIAL-RUN-REASON', undefined, { genome: BASELINE_GENOME });
  const call = vi.fn(async () => '{"mutants":[]}');
  await dreamOnce(db, NOW, call);
  const prompt = call.mock.calls[0][0] as string;
  const ids = failureClusters(db, NOW).map((c) => c.id);
  for (const id of ids) expect(prompt).toContain(`[${id}]`);
  expect(prompt).toContain('tests still red: expected 2, got 3');
  expect(prompt).toContain('[checker: touches unrelated files');
  expect(prompt).not.toMatch(/HOLDOUT-SECRET-REASON|MUTANT-HOLDOUT-REASON|TRIAL-RUN-REASON|\bh1\b|mut:m1/);
  for (const { pattern } of SECRET_PATTERNS) expect(new RegExp(pattern.source, pattern.flags.replace('g', '')).test(prompt)).toBe(false);
  expect(clusterPrompt(failureClusters(db, NOW)).join('\n').length).toBeLessThanOrEqual(4_000 + 400);
});

it('B8-MUT: a mutant without a valid cluster citation is rejected (no_evidence); at most one mutant per cluster; cited ids are stored', async () => {
  vi.stubEnv('DREAM_EVIDENCE_MUTATIONS', 'true');
  seed();
  const [red, scope] = failureClusters(db, NOW).map((c) => c.id);
  const result = await dreamOnce(db, NOW, async () => JSON.stringify({ mutants: [
    { gene: 'strategy_lines', lines: ['Run the named test first and read its assertion.'], addresses: [red] },
    { gene: 'strategy_lines', lines: ['Second idea for the same cluster.'], addresses: [red] },
    { gene: 'anti_pattern', lines: ['editing documentation instead of the named source'], addresses: [scope] },
    { gene: 'strategy_lines', lines: ['Uncited idea.'] },
    { gene: 'strategy_lines', lines: ['Made-up cluster.'], addresses: ['fc-deadbeef'] },
  ] }));
  expect(result.created).toHaveLength(2);
  expect((result as { rejected: Array<{ reason: string }> }).rejected.map((r) => r.reason)).toEqual(['cluster_taken', 'no_evidence', 'no_evidence']);
  const stored = db.prepare("SELECT evidence_clusters FROM maker_genomes WHERE origin = 'dream' ORDER BY created_at, rowid").all() as Array<{ evidence_clusters: string }>;
  expect(stored.map((r) => JSON.parse(r.evidence_clusters)).flat().sort()).toEqual([red, scope].sort());
});

it('B8-MUT: with the flag off the dream is unchanged — flat failure list, no cluster ids, no citation needed, no evidence column written', async () => {
  seed();
  const call = vi.fn(async () => '{"mutants":[{"gene":"strategy_lines","lines":["Run the named test first."]}]}');
  const result = await dreamOnce(db, NOW, call);
  expect(result).toEqual({ created: [expect.stringMatching(/^g-/)] });
  const prompt = call.mock.calls[0][0] as string;
  expect(prompt).toContain('Today it failed on:');
  expect(prompt).not.toMatch(/\[fc-/);
  expect(db.prepare("SELECT evidence_clusters FROM maker_genomes WHERE origin = 'dream'").get()).toEqual({ evidence_clusters: null });
});
