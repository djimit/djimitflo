import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import {
  PROCEDURE_CONTRACT, PROCEDURE_ID, PROCEDURE_LINES, PROCEDURE_VERSION,
  globToRegExp, procedureSelectorMode, recordProcedureSelection, selectProcedure, taskFeatures,
} from '../services/procedure-selector';
import type { GymTask } from '../services/gym-task-miner';

const SRC = 'packages/server/src/services/x.ts';
const task = (commit: string, source = SRC): GymTask => ({ commit, source, tests: [`${source}.test.ts`], sourceLines: 5 });
const GATED = ['prod_gates'];
const fresh = () => { const d = new Database(':memory:'); d.pragma('foreign_keys = OFF'); d.exec(schema); runMigrations(d); return d; };
const judgments = (d: Database.Database) => d.prepare("SELECT * FROM judgments WHERE judgment = 'procedure_selection' ORDER BY created_at, id").all() as Array<Record<string, string>>;

let db: Database.Database;
beforeEach(() => { db = fresh(); });
afterEach(() => db.close());

// procedureSelectorMode reads only the env; off is the default, only 'shadow' is recognized.
describe('procedureSelectorMode', () => {
  it("defaults to 'off' when PROCEDURE_SELECTOR_MODE is unset", () => {
    expect(procedureSelectorMode({})).toBe('off');
  });

  it("returns 'off' for any value other than 'shadow'", () => {
    expect(procedureSelectorMode({ PROCEDURE_SELECTOR_MODE: 'on' })).toBe('off');
    expect(procedureSelectorMode({ PROCEDURE_SELECTOR_MODE: 'shadowy' })).toBe('off');
    expect(procedureSelectorMode({ PROCEDURE_SELECTOR_MODE: '' })).toBe('off');
  });

  it("returns 'shadow' only for the exact value 'shadow'", () => {
    expect(procedureSelectorMode({ PROCEDURE_SELECTOR_MODE: 'shadow' })).toBe('shadow');
  });
});

// globToRegExp translates a small glob language into an anchored RegExp.
describe('globToRegExp', () => {
  it('matches a literal path exactly', () => {
    expect(globToRegExp('packages/server/src/x.ts').test('packages/server/src/x.ts')).toBe(true);
    expect(globToRegExp('packages/server/src/x.ts').test('packages/server/src/y.ts')).toBe(false);
  });

  it("a single '*' matches any chars except '/' within one segment", () => {
    const re = globToRegExp('*.ts');
    expect(re.test('x.ts')).toBe(true);
    expect(re.test('a/b.ts')).toBe(false);
  });

  it("'**' matches any number of segments", () => {
    const re = globToRegExp('packages/**/x.ts');
    expect(re.test('packages/x.ts')).toBe(true);
    expect(re.test('packages/server/src/services/x.ts')).toBe(true);
  });

  it("'**/' at the start matches any number of leading segments", () => {
    const re = globToRegExp('**/__tests__/**');
    expect(re.test('__tests__/a')).toBe(true);
    expect(re.test('packages/server/src/__tests__/a/b')).toBe(true);
    expect(re.test('packages/server/src/a.ts')).toBe(false);
  });

  it("'?' matches exactly one non-'/' character", () => {
    const re = globToRegExp('x?.ts');
    expect(re.test('xa.ts')).toBe(true);
    expect(re.test('xab.ts')).toBe(false);
    expect(re.test('x/a.ts')).toBe(false);
  });

  it('escapes regex metacharacters in the literal text', () => {
    const re = globToRegExp('a.b+c');
    expect(re.test('a.b+c')).toBe(true);
    expect(re.test('aXbXc')).toBe(false);
  });
});

// recordProcedureSelection is the shadow bookkeeping entry point: it never throws,
// seeds the procedure, and writes one judgment per call.
describe('recordProcedureSelection', () => {
  it('seeds the procedure row and records an applies judgment for a matching repair task', () => {
    recordProcedureSelection(db, 'run-1', task('c1'), GATED, 'atomic@llama-router', '2026-10-25T12:00:00.000Z');
    expect(db.prepare('SELECT COUNT(*) AS n FROM maker_genomes WHERE id = ?').get(PROCEDURE_ID)).toEqual({ n: 1 });
    const [j] = judgments(db);
    expect(j).toMatchObject({ subject_type: 'loop_run', subject_id: 'run-1', mode: 'shadow', decision: 'applies', model: 'policy', created_at: '2026-10-25T12:00:00.000Z' });
    const answers = JSON.parse(j.answers_json);
    expect(answers).toMatchObject({ procedure_id: PROCEDURE_ID, procedure_version: PROCEDURE_VERSION, delivered: false, deterministic: true, failed_clause: null, task_key: 'c1', species: 'atomic@llama-router' });
    expect(answers.lines_sha256).toBe(createHash('sha256').update(PROCEDURE_LINES.join('\n')).digest('hex'));
    expect(answers.features).toEqual(taskFeatures(task('c1'), GATED));
    expect(answers.clauses).toEqual(selectProcedure(PROCEDURE_CONTRACT, taskFeatures(task('c1'), GATED)).clauses);
  });

  it('records does_not_apply with the failing clause for a task the contract rejects', () => {
    recordProcedureSelection(db, 'run-2', task('c2', 'packages/server/src/services/__tests__/x.ts'), GATED, 'atomic@llama-router');
    const [j] = judgments(db);
    expect(j).toMatchObject({ decision: 'does_not_apply' });
    expect(JSON.parse(j.answers_json)).toMatchObject({ failed_clause: 'exclusions' });
    expect(j.reason).toBe('exclusions: excluded by **/__tests__/**');
  });

  it('never throws when the judgments table is absent (shadow bookkeeping is fail-soft)', () => {
    const blank = new Database(':memory:');
    try {
      expect(() => recordProcedureSelection(blank, 'run-3', task('c3'), GATED, 'atomic@llama-router')).not.toThrow();
      expect(blank.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='judgments'").get()).toEqual({ n: 0 });
    } finally { blank.close(); }
  });

  it('writes one judgment per call (no idempotency: repeated calls accumulate)', () => {
    recordProcedureSelection(db, 'run-4', task('c4'), GATED, 'atomic@llama-router');
    recordProcedureSelection(db, 'run-4', task('c4'), GATED, 'atomic@llama-router');
    expect(judgments(db)).toHaveLength(2);
  });
});