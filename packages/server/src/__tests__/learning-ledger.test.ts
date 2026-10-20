import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { experimentsReport, type ExperimentRow } from '../services/experiment-registry';
import { learningLedger } from '../services/learning-ledger';
import { buildEvolutionEvidence } from '../services/evolution-evidence';

let db: Database.Database;
const NOW = Date.parse('2026-10-18T12:00:00Z');
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF'); });
afterEach(() => db.close());

const MECHANISMS = ['species_selection', 'effort_siblings', 'genomes', 'memory_rules', 'kb_retrieval', 'example_selection', 'skill_selection', 'maker_template', 'deps_prep', 'requeue', 'checker_family'];

it('evolution-evidence carries the learning ledger: every mechanism, its source and status, loops closed k/N', () => {
  const l = buildEvolutionEvidence(db, {}, NOW).learning_ledger;
  expect(l.mechanisms.map((m) => m.mechanism)).toEqual(MECHANISMS);
  expect(l.loops_closed).toEqual({ k: 0, n: 11, headline: 'loops closed 0/11' });
  const status = Object.fromEntries(l.mechanisms.map((m) => [m.mechanism, m.status]));
  expect(status).toEqual({ species_selection: 'NOT_MEASURED', effort_siblings: 'RUNNING', genomes: 'INSUFFICIENT', memory_rules: 'RUNNING', kb_retrieval: 'RUNNING',
    example_selection: 'RUNNING', skill_selection: 'NOT_MEASURED', maker_template: 'RUNNING', deps_prep: 'RUNNING', requeue: 'NOT_MEASURED', checker_family: 'RUNNING' });
  for (const m of l.mechanisms) expect(m.data_source, m.mechanism).toBeTruthy();
  // no statistic is invented: NOT_MEASURED and the Fisher-only experiments carry no estimate and no CI (null, never 0)
  for (const id of ['species_selection', 'skill_selection', 'requeue', 'effort_siblings', 'memory_rules', 'genomes']) {
    const m = l.mechanisms.find((x) => x.mechanism === id)!;
    expect([m.estimate, m.ci], id).toEqual([null, null]);
  }
  // empty arms: the experiments' own diff is null, so the ledger's is too
  expect(l.mechanisms.find((x) => x.mechanism === 'kb_retrieval')?.estimate).toBeNull();
  expect(l.by_status).toEqual({ ADOPTED: 0, REJECTED: 0, RUNNING: 7, INSUFFICIENT: 1, NOT_MEASURED: 3 });
});

it('reuses the experiment effect: closed only when ADOPTED with a CI excluding 0', () => {
  const base = experimentsReport(db, {}, NOW).experiments;
  const withF2 = (verdict: string | null, ci: [number, number] | null): ExperimentRow[] => base.map((e) => (e.id === 'F2'
    ? { ...e, verdict, effects: { checker_family: { metric: 'Δkappa', estimate: 0.2, ci, p: 0.01 } } } : e));
  const f2 = (rows: ExperimentRow[]) => learningLedger(db, rows, null);
  const a = f2(withF2('supported', [0.05, 0.35]));
  expect(a.mechanisms.find((m) => m.mechanism === 'checker_family')).toMatchObject({ status: 'ADOPTED', estimate: 0.2, ci: [0.05, 0.35], closed: true });
  expect(a.loops_closed.headline).toBe('loops closed 1/11');
  expect(f2(withF2('supported', [-0.05, 0.35])).loops_closed.k).toBe(0);
  expect(f2(withF2('falsified', [-0.05, 0.35])).mechanisms.find((m) => m.mechanism === 'checker_family')?.status).toBe('REJECTED');
  expect(f2(withF2('inconclusive', null)).mechanisms.find((m) => m.mechanism === 'checker_family')?.status).toBe('INSUFFICIENT');
  // MAKER-DEPS-001's descriptive bootstrap CI and ACE-001's two factors reach their mechanisms
  const real = learningLedger(db, base, null).mechanisms;
  expect(real.find((m) => m.mechanism === 'deps_prep')?.metric).toContain('cluster-bootstrap');
  expect(real.find((m) => m.mechanism === 'example_selection')?.experiment).toBe('ACE-001');
});

it('genomes: an active non-baseline genome is ADOPTED but never closed (no pooled CI); a trial is RUNNING', () => {
  const ins = (id: string, status: string) => db.prepare("INSERT INTO maker_genomes (id, status, origin, created_at, updated_at) VALUES (?, ?, 'dream', '2026-10-01', '2026-10-01')").run(id, status);
  ins('g-trial', 'trial');
  expect(learningLedger(db, [], null).mechanisms.find((m) => m.mechanism === 'genomes')?.status).toBe('RUNNING');
  ins('g-win', 'active');
  expect(learningLedger(db, [], null).mechanisms.find((m) => m.mechanism === 'genomes')).toMatchObject({ status: 'ADOPTED', closed: false, ci: null });
});
