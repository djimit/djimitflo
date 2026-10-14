import { afterEach, beforeEach, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { readdirSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { ensureJudgmentProvenance, runMigrations } from '../database/migrate';
import { insertJudgmentRow, runJudgment, runJudgments, type JudgmentDef } from '../services/judgment-service';
import { buildProvenance, canonicalize, hasMandatoryProvenance, inputDigest, promptVersion, readProvenance, type JudgmentProvenance } from '../services/judgment-provenance';
import type { TypeSafeClient } from '../services/typesafe-client';

// DI-001 B: versioned decision provenance on every new judgment row
let db: Database.Database; const env = { ...process.env };
const def = (id = 'judge_p', hi = 0.5): JudgmentDef => ({
  id, policyVersion: '1', questions: { x: { type: 'noul', instructions: `q ${id}` } },
  decide: (a) => ({ decision: (a.x?.noul ?? 0) > hi ? 'yes' : 'no', reason: 'r' }),
});
const fake = (noul = 0.9, model = 'jev-1.13.0', fail = false) => ({
  systemOne: async (_s: unknown, qs: Record<string, unknown>) => {
    if (fail) throw new Error('TYPESAFE_FAILED: http_503');
    return { model, answers: Object.fromEntries(Object.keys(qs).map((k) => [k, { type: 'noul', noul, confidence: 0.8 }])), usage: { input_tokens: 10, output_tokens: 1 } };
  },
}) as unknown as TypeSafeClient;
const rows = () => db.prepare('SELECT id, judgment, subject_id, decision, provenance_json FROM judgments ORDER BY rowid').all() as Array<{ id: string; judgment: string; subject_id: string; decision: string; provenance_json: string | null }>;
const prov = (r: { provenance_json: string | null }) => readProvenance(r) as JudgmentProvenance;
beforeEach(() => {
  db = new Database(':memory:'); db.exec(schema); runMigrations(db);
  Object.assign(process.env, { TYPESAFE_API_KEY: 'test', TYPESAFE_JUDGE_P_MODE: 'enforce', TYPESAFE_JUDGE_Q_MODE: 'shadow' });
});
afterEach(() => { db.close(); process.env = { ...env }; });

it('canon/v1: sorted keys, no whitespace, JSON value rules; digest is stable across key order and changes with the input', () => {
  expect(canonicalize({ b: 1, a: { d: [1, undefined, 'é'], c: null }, u: undefined, n: Number.NaN })).toBe('{"a":{"c":null,"d":[1,null,"é"]},"b":1,"n":null}');
  expect(inputDigest({ a: 1, b: { y: 2, x: [3] } })).toBe(inputDigest({ b: { x: [3], y: 2 }, a: 1 }));
  expect(inputDigest({ a: 1 })).not.toBe(inputDigest({ a: 2 }));
  expect(inputDigest({ a: 'x' })).not.toBe(inputDigest({ a: ['x'] }));
  // golden vector: canon/v1 must never drift silently (UTF-8 bytes of the canonical string)
  const golden = `canon/v1:sha256:${createHash('sha256').update(Buffer.from('{"a":"é","b":[1,2]}', 'utf8')).digest('hex')}`;
  expect(inputDigest({ b: [1, 2], a: 'é' })).toBe(golden);
  expect(golden).toBe('canon/v1:sha256:9cfb1f938a87f2b8f3b8cc429c7a09116d54f048322742d4c23d4767b85f85da');
});

it('the digest never covers a secret: it is taken over the redacted state (same scrub as typesafe-client)', () => {
  expect(inputDigest({ note: 'key sk-abcdefghijklmnopqrstuvwx here' })).toBe(inputDigest({ note: 'key [redacted] here' }));
  expect(inputDigest({ note: 'token: hunter2' })).toBe(inputDigest({ note: '[redacted]' }));
});

it('every judgment definition declares a policy version and a distinct prompt version; editing a question or a threshold changes it', async () => {
  const dir = join(__dirname, '../services/judgments');
  const defs: JudgmentDef[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
    const mod = await import(join(dir, f)) as Record<string, unknown>;
    for (const v of Object.values(mod)) if (v && typeof v === 'object' && 'questions' in v && 'decide' in v) defs.push(v as JudgmentDef);
  }
  expect(defs.length).toBeGreaterThanOrEqual(8);
  for (const d of defs) expect(d.policyVersion, d.id).toMatch(/^\S+$/);
  expect(new Set(defs.map((d) => promptVersion(d))).size).toBe(defs.length);
  expect(promptVersion(def('judge_p', 0.5))).toBe(promptVersion(def('judge_p', 0.5)));
  const edited = def(); edited.questions = { x: { type: 'noul', instructions: 'q changed' } };
  expect(promptVersion(edited)).not.toBe(promptVersion(def()));
  const threshold: JudgmentDef = { ...def(), decide: (a) => ({ decision: (a.x?.noul ?? 0) > 0.7 ? 'yes' : 'no', reason: 'r' }) };
  expect(promptVersion(threshold)).not.toBe(promptVersion(def()));
});

it('runJudgment records full provenance on the row and on the returned record', async () => {
  const state = { proposal: { title: 't', description: 'd' } };
  const rec = await runJudgment(db, def(), { type: 'self_improvement', id: 's1' }, state, fake());
  const [row] = rows();
  const p = prov(row);
  expect(p).toMatchObject({
    v: 1, status: 'recorded', writer: 'judgment-service.runJudgment', policy_id: 'judge_p', policy_version: '1', prompt_id: 'judge_p/questions',
    prompt_version: promptVersion(def()), input_digest: inputDigest(state), model_id: 'jev-1.13.0', model_version: '1.13.0',
    evaluator_version: 'decideObserved/v1', execution_mode: 'enforce', evidence_reference: expect.stringMatching(/^self_improvement:s1#state=[0-9a-f]{16}$/),
    uncertainty: { abstained: false, reason: null, min_confidence: 0.8 },
  });
  expect(p.decision_timestamp).toMatch(/^\d{4}-\d\d-\d\dT/);
  expect(rec?.provenance).toEqual(p);
  expect(hasMandatoryProvenance(row)).toBe(true);
  expect(hasMandatoryProvenance(rec)).toBe(true);
});

it('abstention and errors are recorded as uncertainty metadata; an error row is never mandatory-complete evidence of a decision', async () => {
  await runJudgment(db, def(), { type: 's', id: 'u' }, {}, ({ systemOne: async () => ({ model: 'jev-1.13.0', answers: {} }) }) as unknown as TypeSafeClient);
  await runJudgment(db, def(), { type: 's', id: 'e' }, {}, fake(0.9, 'jev-1.13.0', true));
  const [u, e] = rows();
  expect(u.decision).toBe('uncertain');
  expect(prov(u).uncertainty).toEqual({ abstained: true, reason: 'insufficient_evidence', min_confidence: null });
  expect(e.decision).toBe('error');
  expect(prov(e)).toMatchObject({ status: 'recorded', model_id: null, missing: { model_id: 'no_model_response' }, uncertainty: { abstained: true, reason: 'error' } });
});

it('a writer that cannot supply a field writes null with a reason (distinguishable from valid provenance)', async () => {
  const noPolicy: JudgmentDef = { ...def(), policyVersion: undefined };
  await runJudgment(db, noPolicy, { type: 's', id: '1' }, {}, fake(0.9, 'local-model'));
  const p = prov(rows()[0]);
  expect(p).toMatchObject({ status: 'partial', policy_version: null, model_version: null, missing: { policy_version: 'policy_version_undeclared_on_def', model_version: 'model_name_has_no_version' } });
  expect(hasMandatoryProvenance(rows()[0])).toBe(false);
});

it('migration up on an existing DB: historical rows (before the column) read as unrecorded and are never backfilled', () => {
  const old = new Database(':memory:'); old.exec(schema);
  old.exec(`CREATE TABLE judgments (id TEXT PRIMARY KEY, judgment TEXT NOT NULL, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, state_hash TEXT NOT NULL,
    mode TEXT NOT NULL, decision TEXT NOT NULL, reason TEXT, answers_json TEXT, error TEXT, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER NOT NULL DEFAULT 0, model TEXT, created_at TEXT NOT NULL)`);
  old.prepare("INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, created_at) VALUES ('h1', 'proposal_prescreen', 's', 'x', 'h', 'enforce', 'no', '2026-09-01T00:00:00Z')").run();
  runMigrations(old);
  runMigrations(old); // idempotent: a re-run adds nothing
  const row = old.prepare("SELECT provenance_json FROM judgments WHERE id = 'h1'").get() as { provenance_json: string | null };
  expect(row.provenance_json).toBeNull();
  expect(readProvenance(row)).toEqual({ status: 'unrecorded' });
  expect(hasMandatoryProvenance(row)).toBe(false);
  expect((old.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_judgments_provenance_floor'").get() as { n: number }).n).toBe(1);
  expect((old.prepare('PRAGMA table_info(judgments)').all() as Array<{ name: string }>).filter((c) => c.name === 'provenance_json')).toHaveLength(1);
  old.close();
});

it('an uninstrumented direct INSERT gets a partial floor from the trigger; explicit provenance is never overwritten', () => {
  db.prepare("INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, model, created_at) VALUES ('d1', 'prescreen_park', 'self_improvement', 's1', 'h', 'enforce', 'no', 'rule-v1', '2026-10-14T00:00:00Z')").run();
  const explicit = buildProvenance({ writer: 'w', def: def(), mode: 'shadow', state: {}, subject: { type: 's', id: 'x' }, stateHash: 'h', at: 'now', model: 'jev-1.13.0', decision: 'yes' });
  insertJudgmentRow(db, { id: 'd2', judgment: 'judge_p', subject_type: 's', subject_id: 'x', state_hash: 'h', mode: 'shadow', decision: 'yes', created_at: 'now', provenance_json: JSON.stringify(explicit) });
  const [d1, d2] = rows();
  expect(prov(d1)).toEqual({
    v: 1, status: 'partial', writer: 'uninstrumented', policy_id: 'prescreen_park', policy_version: null, prompt_id: null, prompt_version: null, input_digest: null,
    model_id: 'rule-v1', model_version: null, evaluator_version: null, execution_mode: 'enforce', decision_timestamp: '2026-10-14T00:00:00Z',
    evidence_reference: 'self_improvement:s1', uncertainty: null,
    missing: { policy_version: 'writer_not_instrumented', prompt_version: 'writer_not_instrumented', input_digest: 'writer_not_instrumented', evaluator_version: 'writer_not_instrumented' },
  });
  expect(hasMandatoryProvenance(d1)).toBe(false);
  expect(prov(d2)).toEqual(explicit);
});

it('concurrent writes on the same subject: two rows, each with its own complete provenance and the same input digest (retry-dedupable)', async () => {
  const state = { a: 1, b: 2 };
  const [r1, r2] = await Promise.all([
    runJudgment(db, def(), { type: 's', id: 'same' }, state, fake()),
    runJudgment(db, def(), { type: 's', id: 'same' }, { b: 2, a: 1 }, fake()),
  ]);
  expect(r1?.id).not.toBe(r2?.id);
  const all = rows();
  expect(all).toHaveLength(2);
  expect(all.every((r) => hasMandatoryProvenance(r))).toBe(true);
  expect(new Set(all.map((r) => prov(r).input_digest)).size).toBe(1);
  // a retry of the same judgment is another row with the same digest + prompt version: identifiable, never a mutated earlier row
  await runJudgment(db, def(), { type: 's', id: 'same' }, state, fake());
  const after = rows();
  expect(after.slice(0, 2)).toEqual(all);
  expect(prov(after[2]).input_digest).toBe(prov(all[0]).input_digest);
  // re-running the whole migration is idempotent and leaves recorded provenance untouched
  runMigrations(db);
  expect(rows()).toEqual(after);
});

it('runJudgments (batched) records provenance per judgment', async () => {
  await runJudgments(db, [def('judge_p'), def('judge_q', 0.95)], { type: 's', id: 'b' }, { t: 1 }, fake());
  const all = rows();
  expect(all.map((r) => [r.judgment, prov(r).writer, prov(r).execution_mode, hasMandatoryProvenance(r)])).toEqual([
    ['judge_p', 'judgment-service.runJudgments', 'enforce', true], ['judge_q', 'judgment-service.runJudgments', 'shadow', true],
  ]);
  expect(prov(all[0]).prompt_version).not.toBe(prov(all[1]).prompt_version);
});

it('partial failure: provenance computation throws → the judgment is still written with an error marker, nothing crashes', async () => {
  const broken = def();
  Object.defineProperty(broken, 'policyVersion', { get() { throw new Error('boom'); } });
  const rec = await runJudgment(db, broken, { type: 's', id: 'p' }, {}, fake());
  expect(rec?.decision).toBe('yes');
  const [row] = rows();
  expect(row.decision).toBe('yes');
  expect(prov(row)).toMatchObject({ status: 'error', error: 'boom', missing: { all: 'provenance_compute_failed' }, execution_mode: 'enforce' });
  expect(hasMandatoryProvenance(row)).toBe(false);
  expect(hasMandatoryProvenance(rec)).toBe(false);
  // a cyclic state (unserialisable for canon/v1) is also an error marker, not a crash
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  expect(buildProvenance({ writer: 'w', def: def(), mode: 'shadow', state: cyclic, subject: { type: 's', id: 'c' }, stateHash: 'h', at: 'now' }).status).toBe('error');
});

it('old readers and writers keep working with the new column; the documented down path works', async () => {
  db.prepare("INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at) VALUES ('o1', 'x', 's', '1', 'h', 'shadow', 'yes', 'r', 'now')").run();
  expect(db.prepare("SELECT id, judgment, decision, reason FROM judgments WHERE id = 'o1'").get()).toEqual({ id: 'o1', judgment: 'x', decision: 'yes', reason: 'r' });
  // a new writer against a database that has not been migrated (no column) still writes the judgment
  const old = new Database(':memory:');
  old.exec(`CREATE TABLE judgments (id TEXT PRIMARY KEY, judgment TEXT NOT NULL, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, state_hash TEXT NOT NULL,
    mode TEXT NOT NULL, decision TEXT NOT NULL, reason TEXT, answers_json TEXT, error TEXT, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER NOT NULL DEFAULT 0, model TEXT, created_at TEXT NOT NULL)`);
  const rec = await runJudgment(old, def(), { type: 's', id: 'n' }, {}, fake());
  expect(rec?.decision).toBe('yes');
  expect(old.prepare('SELECT judgment, decision FROM judgments').all()).toEqual([{ judgment: 'judge_p', decision: 'yes' }]);
  old.close();
  // down: drop trigger + column; every explicit-column reader/writer still works
  db.exec('DROP TRIGGER IF EXISTS trg_judgments_provenance_floor; ALTER TABLE judgments DROP COLUMN provenance_json;');
  db.prepare("INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, created_at) VALUES ('o2', 'x', 's', '2', 'h', 'shadow', 'no', 'now')").run();
  expect((db.prepare('SELECT COUNT(*) n FROM judgments').get() as { n: number }).n).toBe(2);
});

it('micro-benchmark: write latency and storage overhead of provenance (reported, loosely bounded)', async () => {
  const N = 2_000;
  const state = { proposal: { title: 'Add a regression test for the merge train', description: 'packages/server/src/services/x.ts '.repeat(20), rationale: 'r'.repeat(400) } };
  const cols = (i: number) => ({ id: `b${i}`, judgment: 'judge_p', subject_type: 's', subject_id: `s${i}`, state_hash: 'h', mode: 'shadow', decision: 'yes', reason: 'r', answers_json: '{"x":{"type":"noul","noul":0.9}}', model: 'jev-1.13.0', created_at: new Date().toISOString() });
  const bench = (label: string, withProv: boolean) => {
    db.exec('DELETE FROM judgments');
    if (!withProv) db.exec('DROP TRIGGER IF EXISTS trg_judgments_provenance_floor');
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) {
      const c: Record<string, unknown> = cols(i);
      if (withProv) c.provenance_json = JSON.stringify(buildProvenance({ writer: 'bench', def: def(), mode: 'shadow', state, subject: { type: 's', id: `s${i}` }, stateHash: 'h', at: c.created_at as string, model: 'jev-1.13.0', decision: 'yes', answers: { x: { type: 'noul', noul: 0.9 } } }));
      insertJudgmentRow(db, c);
    }
    const us = Number(process.hrtime.bigint() - t0) / 1_000 / N;
    const bytes = (db.prepare('SELECT AVG(LENGTH(COALESCE(provenance_json, \'\'))) b FROM judgments').get() as { b: number }).b;
    return { label, us_per_write: Math.round(us * 10) / 10, provenance_bytes_per_row: Math.round(bytes) };
  };
  const base = bench('without', false);
  ensureJudgmentProvenance(db);
  const withP = bench('with', true);
  db.exec('DELETE FROM judgments');
  db.prepare("INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, created_at) VALUES ('t', 'x', 's', '1', 'h', 'shadow', 'no', 'now')").run();
  const floorBytes = (db.prepare('SELECT LENGTH(provenance_json) b FROM judgments').get() as { b: number }).b;
  process.stderr.write(`[provenance-bench] ${JSON.stringify({ N, base, withP, overhead_us_per_write: Math.round((withP.us_per_write - base.us_per_write) * 10) / 10, trigger_floor_bytes: floorBytes })}\n`);
  expect(withP.provenance_bytes_per_row).toBeLessThan(1_000);
  expect(withP.us_per_write - base.us_per_write).toBeLessThan(2_000); // far below a jev call (~400 ms); loose to stay stable on CI
});
