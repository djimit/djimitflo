import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { RemoteGymService } from '../services/remote-gym-service';
import { guardLines } from '../services/dream-evolution';
import { holdoutEpoch, nextTrialAttempt, strategyGenomeFor } from '../services/genome-registry';
import { buildEvolutionEvidence } from '../services/evolution-evidence';
import type { FailureTask } from '../services/gym-failure-tasks';
import { mutantTask } from '../services/gym-mutants';
import {
  PROCEDURE_CONTRACT, PROCEDURE_ID, PROCEDURE_LINES, PROCEDURE_VERSION, ensureProcedures, globToRegExp, linesSha256, procedure,
  procedureSelectionEvidence, recordProcedureSelection, selectProcedure, taskFeatures, type ApplicabilityContract,
} from '../services/procedure-selector';

// randomUUID is made sequential so two claims on two databases can be compared byte for byte (run ids included)
let seq = 0;
vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  return { ...actual, randomUUID: () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}` };
});

// a canary needs a seeded mutant; the deploy checkout is absent here, so the generator is stubbed (null unless a test says otherwise)
vi.mock('../services/gym-mutants', async (importOriginal) => ({ ...(await importOriginal<typeof import('../services/gym-mutants')>()), mutantTask: vi.fn(() => null) }));

/** The PL-001 protocol's frozen fingerprint and the treatment digest it pins. */
const PL001_PREREG_SHA256 = 'fa136ae5946574f749bce23a190acc7632e5a6135f4d4577e311e9ea0dfb616c';
const PL001_LINES_SHA256 = '6dddbba133cdca3774927f6c634e256a2b1d53d65b127dd3b2637511be95f068';

const SRC = 'packages/server/src/services/x.ts';
const TASK = (commit: string, source = SRC) => ({ commit, source, tests: ['packages/server/src/__tests__/x.test.ts'], sourceLines: 5 });
const GATED = ['prod_gates'];
const fresh = () => { const d = new Database(':memory:'); d.pragma('foreign_keys = OFF'); d.exec(schema); runMigrations(d); return d; };
const judgments = (d: Database.Database) => d.prepare("SELECT * FROM judgments WHERE judgment = 'procedure_selection' ORDER BY created_at, id").all() as Array<Record<string, string>>;
let db: Database.Database;
beforeEach(() => {
  seq = 0; db = fresh();
  vi.stubEnv('EVOLUTION_GYM_REMOTE_ENABLED', 'true'); vi.stubEnv('LOOP_DAEMON_REPOSITORY_PATH', '/repo-that-does-not-exist'); vi.stubEnv('GYM_PROD_GATES', 'true');
});
afterEach(() => { vi.unstubAllEnvs(); db.close(); });

it('the PL-001 protocol fingerprint matches its body, and it pins the seeded lines', () => {
  const doc = readFileSync(join(__dirname, '../../../../docs/research/procedure-loop/PL-001_PROTOCOL.md'), 'utf8');
  const [body, tail] = doc.split('\n---\nPREREG_SHA256: ');
  expect(createHash('sha256').update(body).digest('hex')).toBe(tail.slice(0, 64));
  expect(tail.slice(0, 64)).toBe(PL001_PREREG_SHA256);
  expect(linesSha256(PROCEDURE_LINES)).toBe(PL001_LINES_SHA256);
  for (const line of PROCEDURE_LINES) expect(body).toContain(`\`${line}\``);
  expect(body).toContain(PL001_LINES_SHA256);
});

it('the seeded procedure lines pass the dream-evolution genome line guard unchanged', () => {
  expect(PROCEDURE_LINES).toHaveLength(5);
  expect(guardLines([...PROCEDURE_LINES])).toEqual([...PROCEDURE_LINES]);
  for (const line of PROCEDURE_LINES) expect(guardLines([line])).toEqual([line]);
});

it('the contract applies to a repair task on a service file and rejects what it should, naming the clause', () => {
  const sel = (task: object, caps = GATED, contract: ApplicabilityContract = PROCEDURE_CONTRACT) => selectProcedure(contract, taskFeatures(task as never, caps));
  expect(sel(TASK('c1'))).toMatchObject({ decision: 'applies', failed_clause: null, reason: 'all clauses matched' });
  // a test file against a source-only contract (no exclusion needed: the file pattern alone rejects it)
  const sourceOnly: ApplicabilityContract = { task_kinds: ['repair'], lanes: ['gym-repair'], file_patterns: ['packages/server/src/services/**/*.ts'], required_capabilities: [], exclusions: [] };
  expect(sel(TASK('c2', 'packages/server/src/__tests__/x.test.ts'), [], sourceOnly)).toMatchObject({ decision: 'does_not_apply', failed_clause: 'file_patterns' });
  // an exclusion wins over a matching file pattern
  const broad: ApplicabilityContract = { ...sourceOnly, file_patterns: ['packages/server/src/**/*.ts'], exclusions: ['**/*.generated.ts'] };
  const generated = sel(TASK('c3', 'packages/server/src/services/config-defaults.generated.ts'), [], broad);
  expect(generated).toMatchObject({ decision: 'does_not_apply', failed_clause: 'exclusions', reason: 'exclusions: excluded by **/*.generated.ts' });
  expect(generated.clauses.find((c) => c.clause === 'file_patterns')?.ok).toBe(true);
  // an unknown task kind never applies, even when the contract would list it
  const odd = sel({ ...TASK('c4'), kind: 'refactor' }, GATED, { ...PROCEDURE_CONTRACT, task_kinds: ['repair', 'refactor' as never] });
  expect(odd).toMatchObject({ decision: 'does_not_apply', failed_clause: 'task_kind', reason: 'task_kind: unknown kind refactor' });
  // the seeded contract: a write_test task, a JS file, a nested test file, a worker without prod_gates
  const wt = { ...TASK('fail:r1', 'packages/server/src/__tests__/w1.test.ts'), kind: 'write_test', lane: 'exports' };
  expect(sel(wt)).toMatchObject({ decision: 'does_not_apply', failed_clause: 'task_kind' });
  expect(sel(TASK('c5', 'packages/server/src/services/x.js'))).toMatchObject({ decision: 'does_not_apply', failed_clause: 'file_patterns' });
  expect(sel(TASK('c6', 'packages/server/src/services/__tests__/x.ts'))).toMatchObject({ decision: 'does_not_apply', failed_clause: 'exclusions' });
  expect(sel(TASK('c7'), [])).toMatchObject({ decision: 'does_not_apply', failed_clause: 'required_capabilities', reason: 'required_capabilities: missing prod_gates' });
  expect(sel(TASK('c8', 'packages/server/src/services/asg/router.ts'))).toMatchObject({ decision: 'applies' }); // ** spans directories
});

it('the procedure is a candidate genome: never a trial, never the active strategy genome, never a dream exposure', () => {
  ensureProcedures(db); ensureProcedures(db);
  const row = db.prepare('SELECT gene, origin, status FROM maker_genomes WHERE id = ?').get(PROCEDURE_ID);
  expect(row).toEqual({ gene: 'procedure', origin: 'procedure', status: 'candidate' });
  const p = procedure(db, PROCEDURE_ID)!;
  expect(p).toMatchObject({ id: PROCEDURE_ID, version: PROCEDURE_VERSION, lines: [...PROCEDURE_LINES], contract: PROCEDURE_CONTRACT, lines_sha256: PL001_LINES_SHA256 });
  expect(nextTrialAttempt(db, 'atomic@llama-router', ['c1'])).toBeNull();
  expect(strategyGenomeFor(db, 'atomic', 'llama-router')?.id).not.toBe(PROCEDURE_ID);
  vi.stubEnv('GYM_HOLDOUT_EPOCH', '2');
  db.prepare("INSERT INTO gym_mutant_holdout (key, task_json, created_at, epoch) VALUES ('m1', '{}', datetime('now'), 1)").run();
  expect(holdoutEpoch(db, 'gym_mutant_holdout')).toBe(2); // no trial running: the procedure row does not hold the epoch
});

it('off (default): no judgment and no seeded row; shadow: the claim payload and the run row are byte-identical, a judgment is recorded', () => {
  const claimOn = (d: Database.Database) => { seq = 0; return new RemoteGymService(d, () => [TASK('c1'), TASK('c2')]).claim('workstation', ['atomic@llama-router'], new Date('2026-10-25T12:00:00.000Z'), { capabilities: GATED }); };
  const runRow = (d: Database.Database) => d.prepare('SELECT id, loop_name, mode, status, metadata, created_at FROM loop_runs').all();
  const off = claimOn(db);
  expect(judgments(db)).toEqual([]);
  expect(db.prepare('SELECT COUNT(*) AS n FROM maker_genomes WHERE id = ?').get(PROCEDURE_ID)).toEqual({ n: 0 });
  vi.stubEnv('PROCEDURE_SELECTOR_MODE', 'shadow');
  const other = fresh();
  try {
    const shadow = claimOn(other);
    expect(JSON.stringify(shadow)).toBe(JSON.stringify(off)); // nothing delivered: no lines, no procedure field
    expect(JSON.stringify(runRow(other))).toBe(JSON.stringify(runRow(db)));
    const [j] = judgments(other);
    expect(j).toMatchObject({ subject_type: 'loop_run', subject_id: (off as { runId: string }).runId, mode: 'shadow', decision: 'applies', model: 'policy' });
    expect(JSON.parse(j.answers_json)).toMatchObject({ procedure_id: PROCEDURE_ID, procedure_version: 1, lines_sha256: PL001_LINES_SHA256, task_key: 'c1', delivered: false, failed_clause: null });
  } finally { other.close(); }
});

it('shadow: one judgment per ordinary claim with a stable digest; holdout, trial and canary claims are not judged', () => {
  vi.stubEnv('PROCEDURE_SELECTOR_MODE', 'shadow');
  const svc = new RemoteGymService(db, () => [TASK('h1'), TASK('c1'), TASK('c2', 'packages/server/src/__tests__/y.test.ts')]);
  db.prepare("INSERT INTO gym_holdout (commit_sha, created_at, epoch) VALUES ('h1', datetime('now'), 0)").run();
  const done = () => db.prepare("UPDATE loop_runs SET status = 'completed'").run();
  const held = svc.claim('workstation', ['atomic@llama-router'], new Date(), { capabilities: GATED }) as { runId: string; task: { commit: string } };
  expect(held.task.commit).toBe('h1'); // an ordinary replay of a mined holdout commit
  done();
  const a = svc.claim('workstation', ['atomic@llama-router'], new Date(), { capabilities: GATED }) as { runId: string }; done();
  const b = svc.claim('workstation', ['atomic@llama-router'], new Date(), { capabilities: GATED }) as { runId: string }; done();
  const rows = judgments(db);
  expect(rows.map((r) => r.subject_id)).toEqual([a.runId, b.runId]);
  expect(rows.map((r) => r.decision)).toEqual(['applies', 'does_not_apply']);
  expect(rows[1].reason).toBe('exclusions: excluded by **/__tests__/**');
  expect(new Set(rows.map((r) => JSON.parse(r.answers_json).lines_sha256))).toEqual(new Set([PL001_LINES_SHA256]));
  // a canary claim
  vi.stubEnv('GYM_CANARY_RATE', '1');
  vi.mocked(mutantTask).mockReturnValueOnce({ ...TASK('mut:c9'), base: 'b'.repeat(40), mutant: 'x', tier: 3 });
  const canary = svc.claim('workstation', ['atomic@llama-router'], new Date(), { capabilities: [...GATED, 'canary'] }) as { runId: string; task: { commit: string; canary?: unknown } };
  expect(canary.task).toMatchObject({ commit: 'mut:c9', canary: { test_path: expect.any(String) } });
  expect(judgments(db)).toHaveLength(2); // still only a and b
});

it('shadow: a genome trial claim (baseline or trial arm) is not judged', () => {
  vi.stubEnv('PROCEDURE_SELECTOR_MODE', 'shadow'); vi.stubEnv('DREAM_EVOLUTION_ENABLED', 'true');
  const tasks = Array.from({ length: 40 }, (_, i) => TASK(`c${String(i).padStart(2, '0')}`));
  const svc = new RemoteGymService(db, () => tasks);
  db.prepare(`INSERT INTO maker_genomes (id, parent_id, gene, lines_json, origin, status, created_at, updated_at)
    VALUES ('g1', 'baseline', 'strategy_lines', '["Read the failing test first."]', 'dream', 'trial', datetime('now'), datetime('now'))`).run();
  const base = svc.claim('workstation', ['atomic@llama-router'], new Date(), { capabilities: GATED }) as { runId: string; genome: { id: string } };
  expect(base.genome.id).toBe('baseline');
  svc.record(base.runId, 'workstation', { status: 'failure', reason: 'tests still red' });
  const trial = svc.claim('workstation', ['atomic@llama-router'], new Date(), { capabilities: GATED }) as { runId: string; genome: { id: string } };
  expect(trial.genome.id).toBe('g1');
  expect(judgments(db)).toEqual([]);
});

it('shadow: a TG-001 claim is not judged; an ordinary write_test claim is (does_not_apply)', () => {
  vi.stubEnv('PROCEDURE_SELECTOR_MODE', 'shadow'); vi.stubEnv('TG_001_MODE', 'on'); vi.stubEnv('GYM_FAILURE_TASKS_ENABLED', 'true');
  const NOW = '2026-10-11T12:00:00.000Z';
  const tasks: FailureTask[] = Array.from({ length: 12 }, (_, k) => {
    const i = k + 1; const runId = `run-${i}`;
    const finding = { id: 'f1', type: 'test_gap', severity: 'low', file: `packages/server/src/services/w${i}.ts`, message: `w${i}.ts exports parse() without a unit test.`,
      evidence: `test-gap scan: 0 tests import w${i}.ts`, suggested_fix: `Write packages/server/src/__tests__/w${i}.test.ts covering parse().`, metadata: { objective_mode: true } };
    db.prepare('INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(runId, 'test-gap-loop', 'closed', 'completed', JSON.stringify([finding]), '{}', NOW, NOW);
    db.prepare('INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, finding_id, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(`lease-${i}`, runId, 'maker', 'remote', 'failed', 'f1', '{}', NOW, NOW);
    return { commit: `fail:${runId}`, kind: 'write_test', base: 'a'.repeat(40), source: `packages/server/src/__tests__/w${i}.test.ts`, tests: [`packages/server/src/__tests__/w${i}.test.ts`],
      target: `packages/server/src/services/w${i}.ts`, sourceLines: 10, run_id: runId, lane: k < 3 ? 'test-gap' : 'exports', mutants: [{ key: `mut:a:w${i}:1:1`, content: 'x' }], oracle: 'o' };
  });
  const svc = new RemoteGymService(db, () => []);
  svc.failureTasks = () => tasks;
  const caps = { capabilities: ['write_test', 'prod_gates', 'prompt_override'] };
  // a worker without prompt_override gets an ordinary write_test task: judged, and the seeded contract rejects it
  const plain = svc.claim('workstation', ['atomic@llama-router'], new Date(Date.now() - 120_000), { capabilities: ['write_test', 'prod_gates'] }) as { runId: string; task: { kind?: string } };
  expect(plain.task.kind).toBe('write_test');
  db.prepare("UPDATE loop_runs SET status = 'completed' WHERE loop_name = 'evolution-gym'").run();
  const freezing = svc.claim('workstation', ['atomic@llama-router'], new Date(Date.now() - 60_000), caps) as { tg?: unknown };
  expect(freezing.tg).toBeUndefined();
  db.prepare("UPDATE loop_runs SET status = 'completed' WHERE loop_name = 'evolution-gym'").run();
  const tg = svc.claim('workstation', ['atomic@llama-router'], new Date(), caps) as { runId: string; tg?: { arm: string } };
  expect(tg.tg?.arm).toMatch(/^[ABCD]$/);
  const rows = judgments(db);
  expect(rows.map((r) => r.subject_id)).toEqual([plain.runId]);
  expect(rows[0]).toMatchObject({ decision: 'does_not_apply', reason: 'task_kind: kind write_test' });
});

it('evidence procedure_selection: null without a decision (never 0), counts and failed clauses once recorded', () => {
  const empty = buildEvolutionEvidence(db, {}, Date.now()) as unknown as { procedure_selection: ReturnType<typeof procedureSelectionEvidence> };
  expect(empty.procedure_selection).toEqual({ mode: 'off', delivered: false, procedure: null, window_24h: { applies: null, does_not_apply: null }, window_7d: { applies: null, does_not_apply: null }, top_failed_clauses_7d: null });
  const blank = new Database(':memory:');
  try { expect(procedureSelectionEvidence(blank, {}).window_7d).toEqual({ applies: null, does_not_apply: null }); } finally { blank.close(); }
  vi.stubEnv('PROCEDURE_SELECTOR_MODE', 'shadow');
  const svc = new RemoteGymService(db, () => [TASK('c1'), TASK('c2', 'packages/server/src/services/x.js'), TASK('c3', 'packages/server/src/services/y.js')]);
  for (let i = 0; i < 3; i++) { svc.claim('workstation', ['atomic@llama-router'], new Date(), { capabilities: GATED }); db.prepare("UPDATE loop_runs SET status = 'completed'").run(); }
  const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
  db.prepare("UPDATE judgments SET created_at = ? WHERE judgment = 'procedure_selection' AND json_extract(answers_json, '$.task_key') = 'c3'").run(old);
  const e = procedureSelectionEvidence(db, process.env);
  expect(e).toMatchObject({ mode: 'shadow', procedure: { id: PROCEDURE_ID, version: 1, lines_sha256: PL001_LINES_SHA256 },
    window_24h: { applies: 1, does_not_apply: 1 }, window_7d: { applies: 1, does_not_apply: 2 }, top_failed_clauses_7d: [{ clause: 'file_patterns', n: 2 }] });
});

it('ensureProcedures stores the procedure sources (not an empty array)', () => {
  ensureProcedures(db);
  const ev = JSON.parse((db.prepare('SELECT evidence_sources_json FROM maker_genomes WHERE id = ?').get(PROCEDURE_ID) as { evidence_sources_json: string }).evidence_sources_json);
  expect(ev.procedure.sources).toHaveLength(1);
  expect(ev.procedure.sources[0]).toMatchObject({ source: 'ecc', licence: 'MIT', use: 'idea only, own wording' });
});

it('globToRegExp: ** spans directories, * stays in a segment, ? is one char, literals are escaped', () => {
  // **/ as a prefix is an optional directory path: matches a bare file
  expect(globToRegExp('**/x.ts').test('x.ts')).toBe(true);
  expect(globToRegExp('**/x.ts').test('a/b/x.ts')).toBe(true);
  // ** needs a / boundary before the filename, not just concatenation
  expect(globToRegExp('**/x.ts').test('abcx.ts')).toBe(false);
  // single * does NOT cross a /
  expect(globToRegExp('*.ts').test('x.ts')).toBe(true);
  expect(globToRegExp('*.ts').test('a/b.ts')).toBe(false);
  // a non-* char must not be treated as **
  expect(globToRegExp('a*').test('xyz')).toBe(false);
  // ? matches exactly one character
  expect(globToRegExp('x?.ts').test('xy.ts')).toBe(true);
  expect(globToRegExp('x?.ts').test('x.ts')).toBe(false);
  expect(globToRegExp('x?.ts').test('xyz.ts')).toBe(false);
  // literal dot is escaped, not a wildcard
  expect(globToRegExp('x.ts').test('x.ts')).toBe(true);
  expect(globToRegExp('x.ts').test('xats')).toBe(false);
  // ** without a following / becomes .* (crosses /)
  expect(globToRegExp('a**b').test('axxb')).toBe(true);
  expect(globToRegExp('a**b').test('ax/yb')).toBe(true);
});

const insertProc = (id: string, linesJson: string, evidence: string | null) =>
  db.prepare(`INSERT INTO maker_genomes (id, parent_id, gene, lines_json, origin, status, note, created_at, updated_at, evidence_sources_json)
    VALUES (?, NULL, 'procedure', ?, 'procedure', 'candidate', '', datetime('now'), datetime('now'), ?)`).run(id, linesJson, evidence);
const GOOD_EV = JSON.stringify({ procedure: { version: 1, applicability: { task_kinds: ['repair'], lanes: ['gym-repair'], file_patterns: ['*.ts'], required_capabilities: [], exclusions: [] } } });

it('procedure: null for missing row, invalid JSON, empty lines, missing applicability, non-integer version, non-array lines', () => {
  expect(procedure(db, 'no-such-procedure')).toBeNull();
  // invalid JSON in lines_json → catch returns null (not undefined)
  insertProc('bad-json', 'not valid json {', null);
  expect(procedure(db, 'bad-json')).toBeNull();
  // empty lines → null
  insertProc('empty-lines', '[]', GOOD_EV);
  expect(procedure(db, 'empty-lines')).toBeNull();
  // missing applicability → null
  insertProc('no-applic', '["line"]', JSON.stringify({ procedure: { version: 1 } }));
  expect(procedure(db, 'no-applic')).toBeNull();
  // non-integer version → null
  insertProc('bad-ver', '["line"]', JSON.stringify({ procedure: { version: 1.5, applicability: { task_kinds: ['repair'] } } }));
  expect(procedure(db, 'bad-ver')).toBeNull();
  // null evidence_sources_json → null
  insertProc('null-ev', '["line"]', null);
  expect(procedure(db, 'null-ev')).toBeNull();
  // non-array lines_json → null (strings returns [])
  insertProc('non-array', '42', GOOD_EV);
  expect(procedure(db, 'non-array')).toBeNull();
});

it('procedure: non-string elements in lines_json are filtered out', () => {
  insertProc('mixed', '["a", 1, true, "b"]', GOOD_EV);
  const p = procedure(db, 'mixed')!;
  expect(p).not.toBeNull();
  expect(p.lines).toEqual(['a', 'b']);
});

it('taskFeatures: lane from task, defaulted for repair, null for non-repair; capabilities sorted and deduped', () => {
  expect(taskFeatures({ ...TASK('c'), kind: 'repair', lane: 'exports' }, []).lane).toBe('exports');
  expect(taskFeatures({ ...TASK('c'), kind: 'write_test' }, []).lane).toBeNull();
  expect(taskFeatures(TASK('c'), ['b', 'a', 'a']).capabilities).toEqual(['a', 'b']);
  expect(taskFeatures({ ...TASK('c'), source: undefined } as never, []).file).toBe('');
});

it('selectProcedure: detail truncates long unknown kinds and long file paths; lane detail for null and non-matching lanes', () => {
  const f = (kind: string, lane: string | null, file: string, caps = GATED) => selectProcedure(PROCEDURE_CONTRACT, { kind, lane, file, capabilities: caps });
  // long unknown kind → truncated to 40 chars in detail
  expect(f('x'.repeat(50), 'gym-repair', SRC).clauses.find((c) => c.clause === 'task_kind')?.detail).toBe(`unknown kind ${'x'.repeat(40)}`);
  // lane null → detail 'lane none', clause fails
  const laneNull = f('repair', null, SRC);
  expect(laneNull.failed_clause).toBe('lane');
  expect(laneNull.clauses.find((c) => c.clause === 'lane')?.detail).toBe('lane none');
  // lane not in contract → clause fails
  expect(f('repair', 'exports', SRC).failed_clause).toBe('lane');
  // long file path → truncated to 120 chars in detail
  const longFile = 'packages/other/src/' + 'x'.repeat(150) + '.ts';
  const fileFail = f('repair', 'gym-repair', longFile);
  expect(fileFail.failed_clause).toBe('file_patterns');
  expect(fileFail.clauses.find((c) => c.clause === 'file_patterns')?.detail).toBe(`no pattern matched ${longFile.slice(0, 120)}`);
});

it('recordProcedureSelection: writes a 16-char state_hash, deterministic true, delivered false', () => {
  ensureProcedures(db);
  recordProcedureSelection(db, 'run-rec', TASK('c-rec'), GATED, 'atomic@llama-router');
  const [j] = judgments(db);
  expect(j).toBeDefined();
  expect(j.state_hash).toHaveLength(16);
  const answers = JSON.parse(j.answers_json);
  expect(answers.delivered).toBe(false);
  expect(answers.deterministic).toBe(true);
});
