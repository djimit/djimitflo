import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { experimentDefs, experimentsReport, type ExperimentDef } from '../services/experiment-registry';
import { detectStallsWithHealth } from '../services/stall-watch';
import { buildEvolutionEvidence } from '../services/evolution-evidence';
import { readFileSync } from 'fs';
import { join } from 'path';
import { D5NO_CUTOFF, D5NO_DEADLINE_DAYS } from '../services/d5-no';

let db: Database.Database;
const NOW = Date.parse('2026-10-18T12:00:00Z');
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF'); });
afterEach(() => db.close());

it('lists every running experiment with its registered target and stop date; none without one is hidden', () => {
  const r = experimentsReport(db, {}, NOW);
  expect(r.experiments.map((e) => e.id)).toEqual(['ACE-001', 'STE-001', 'MAKER-DEPS-001', 'X1', 'F2', 'TG-001', 'D5-NO', 'JEV-114', 'memory-holdout']);
  expect(r.experiments.every((e) => !e.error)).toBe(true);
  expect(r.overdue).toEqual([]);
  // X1 (4 weeks) and D5-NO (cutoff + 90 d) were registered with a stop date; the other seven got one by the 2026-10-19 amendments
  expect(r.experiments.find((e) => e.id === 'X1')?.stop_by).toBe('2026-11-06T00:00:00.000Z');
  expect(r.experiments.find((e) => e.id === 'D5-NO')?.stop_by).toBe(new Date(Date.parse(D5NO_CUTOFF) + D5NO_DEADLINE_DAYS * 86_400_000).toISOString());
  expect(r.experiments.find((e) => e.id === 'D5-NO')?.started_at).toBe(D5NO_CUTOFF);
  expect(r.no_stop_date).toEqual([]);
  // every experiment has a stop date, a target n and the document that registers both
  for (const e of r.experiments) {
    expect(e.stop_by, e.id).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(e.target_n, e.id).toBeGreaterThan(0);
    expect(e.stop_source, e.id).toMatch(/^docs\/research\/.+\.md/);
    // the stall-watch cap: no stop date more than 90 days after the start
    expect(Date.parse(e.stop_by as string) - Date.parse(e.started_at), e.id).toBeLessThanOrEqual(90 * 86_400_000);
  }
  // the amended stops cite the amendment, and the amendment text exists in that document
  for (const e of r.experiments.filter((x) => !['X1', 'D5-NO'].includes(x.id))) {
    const [file, anchor] = e.stop_source.split('#');
    const doc = readFileSync(join(__dirname, '../../../..', file), 'utf8');
    expect(doc, e.id).toContain('2026-10-19');
    expect(doc, e.id).toContain('verdict rules unchanged');
    expect(doc, e.id).toContain(e.stop_by!.slice(0, 10));
    expect(anchor, e.id).toBeTruthy();
  }
  expect(r.experiments.find((e) => e.id === 'JEV-114')?.target_n).toBe(100);
  expect(r.experiments.find((e) => e.id === 'memory-holdout')?.target_n).toBe(30);
  // n per arm is counted, never invented: an empty database gives 0 per arm, not null, where arms exist
  expect(r.experiments.find((e) => e.id === 'ACE-001')?.n_per_arm).toEqual({ '00': 0, '01': 0, '10': 0, '11': 0 });
});

it('is overdue past stop_by or at target in every arm without a verdict; a verdict closes it', () => {
  const def = (over: Partial<ExperimentDef>): ExperimentDef => ({ id: 'T', flag: 'T_MODE', protocol: 'p.md', started_at: '2026-10-01T00:00:00.000Z', target_n: 10, stop_by: null, stop_note: '',
    status: () => ({ n_per_arm: { a: 3, b: 4 }, verdict: null }), ...over });
  const ids = (defs: ExperimentDef[]) => experimentsReport(db, {}, NOW, defs).overdue;
  expect(ids([def({})])).toEqual([]);
  expect(ids([def({ stop_by: '2026-10-17T00:00:00.000Z' })])).toEqual(['T']);
  expect(ids([def({ stop_by: '2026-10-19T00:00:00.000Z' })])).toEqual([]);
  expect(ids([def({ status: () => ({ n_per_arm: { a: 10, b: 12 }, verdict: null }) })])).toEqual(['T']);
  expect(ids([def({ status: () => ({ n_per_arm: { a: 10, b: 9 }, verdict: null }) })])).toEqual([]);
  expect(ids([def({ stop_by: '2026-10-17T00:00:00.000Z', status: () => ({ n_per_arm: { a: 10, b: 12 }, verdict: 'falsified' }) })])).toEqual([]);
  // a status that cannot be read is reported with its error, never as n = 0
  const broken = experimentsReport(db, {}, NOW, [def({ status: () => { throw new Error('no table'); } })]).experiments[0];
  expect(broken).toMatchObject({ n_per_arm: null, min_arm_n: null, error: 'no table', overdue: false });
});

it("stall watch 'experiment_overdue' fires after a registered stop date and names experiments with none", () => {
  const before = detectStallsWithHealth(db, NOW, {});
  expect(before.stalls.filter((s) => s.subsystem.startsWith('experiment:'))).toEqual([]);
  const det = before.detectors.find((d) => d.name === 'experiment_overdue');
  expect(det?.status).toBe('ok');
  // every experiment has a stop date now: the detector names none as missing one
  expect(det?.detail ?? '').not.toContain('no stop date');
  const after = detectStallsWithHealth(db, Date.parse('2026-11-07T00:00:00Z'), {});
  expect(after.stalls.find((s) => s.subsystem === 'experiment:X1')?.detail).toContain('past stop_by 2026-11-06');
});

it('evolution-evidence carries the registry as the experiments section', () => {
  const e = buildEvolutionEvidence(db, {}, NOW);
  expect(e.experiments.experiments).toHaveLength(experimentDefs().length);
});
