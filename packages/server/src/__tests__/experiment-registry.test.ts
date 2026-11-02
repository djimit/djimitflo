import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { EXPERIMENT_WIP_LIMIT, MEMORY_HOLDOUT_CLOSED, TG_001_CLOSED, experimentDefs, experimentsReport, recordTreatmentEnvBoundaries, wipCheck, type ExperimentDef } from '../services/experiment-registry';
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
  expect(r.experiments.map((e) => e.id)).toEqual(['ACE-001', 'STE-001', 'MAKER-DEPS-001', 'X1', 'F2', 'TG-001', 'PL-001', 'D5-NO', 'JEV-114', 'memory-holdout']);
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
  for (const e of r.experiments.filter((x) => !['X1', 'D5-NO', 'PL-001'].includes(x.id))) {
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
  const def = (over: Partial<ExperimentDef>): ExperimentDef => ({ id: 'T', flag: 'T_MODE', protocol: 'p.md', started_at: '2026-10-01T00:00:00.000Z', target_n: 10, stop_by: null, stop_note: '', stop_source: 's', population: 'oracle_goals',
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

it('TG-001 is closed INCONCLUSIVE at 20 tasks by the operator (amendment 2026-10-26); the stall watch no longer reports it after stop_by', () => {
  expect(TG_001_CLOSED).toEqual({ verdict: 'INCONCLUSIVE', decided_on: '2026-10-26', source: 'docs/research/ace/TG-001_PROTOCOL.md#amendment-2026-10-26-closed-inconclusive-at-20-tasks' });
  // the close cites a protocol amendment that exists and records the same decision
  const [file, anchor] = TG_001_CLOSED.source.split('#');
  const doc = readFileSync(join(__dirname, '../../../..', file), 'utf8');
  const heading = doc.split('\n').find((l) => l.startsWith('## ') && l.slice(3).toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-') === anchor);
  expect(heading).toBe('## Amendment 2026-10-26: closed INCONCLUSIVE at 20 tasks');
  const tg = experimentDefs().find((d) => d.id === 'TG-001')!;
  expect(tg.closed).toBe(TG_001_CLOSED);
  // status() carries the closing verdict whether or not the evidence can be read or windowed
  expect(tg.status(db, {}, NOW, tg.started_at).verdict).toBe('INCONCLUSIVE');
  expect(tg.status(db, {}, NOW, '2026-10-20T00:00:00.000Z')).toEqual({ n_per_arm: null, verdict: 'INCONCLUSIVE' });
  // past stop_by (2026-11-18): the registry and the stall watch's experiment_overdue no longer name TG-001
  const late = Date.parse('2026-11-19T00:00:00Z');
  const row = experimentsReport(db, {}, late).experiments.find((e) => e.id === 'TG-001')!;
  expect(row).toMatchObject({ verdict: 'INCONCLUSIVE', overdue: false, overdue_reason: null, closed: TG_001_CLOSED });
  expect(experimentsReport(db, {}, late).overdue).not.toContain('TG-001');
  const stalls = detectStallsWithHealth(db, late, {}).stalls.map((s) => s.subsystem);
  expect(stalls).not.toContain('experiment:TG-001');
  // the same definition without the close is reported past stop_by: the close is what stops it, not the stop date passing
  const open: ExperimentDef = { ...tg, closed: undefined, status: () => ({ n_per_arm: null, verdict: null }) };
  expect(experimentsReport(db, {}, late, [open]).overdue).toEqual(['TG-001']);
  // other experiments are unchanged: only TG-001 and memory-holdout carry a close, and an open one past its stop date is still overdue
  expect(experimentDefs().filter((d) => d.closed).map((d) => d.id)).toEqual(['TG-001', 'memory-holdout']);
  expect(stalls).toContain('experiment:X1');
});

it('EXP-3 memory-holdout is closed FALSIFIED at its single registered readout (2026-10-27); experiment_overdue no longer raises it', () => {
  expect(MEMORY_HOLDOUT_CLOSED).toEqual({ verdict: 'FALSIFIED (rules not above withheld)', decided_on: '2026-10-27',
    source: 'docs/research/intelligence-metrics/EXP-3_RESULT.md#decision-under-the-registered-rules' });
  const mh = experimentDefs().find((d) => d.id === 'memory-holdout')!;
  expect(mh.closed).toBe(MEMORY_HOLDOUT_CLOSED);
  expect(mh.status(db, {}, NOW, mh.started_at).verdict).toBe('FALSIFIED (rules not above withheld)');
  // past stop_by (2026-10-27): reported closed with the verdict, not overdue, no stall
  const late = Date.parse('2026-10-28T12:00:00Z');
  const r = experimentsReport(db, {}, late);
  expect(r.experiments.find((e) => e.id === 'memory-holdout')).toMatchObject({ verdict: 'FALSIFIED (rules not above withheld)', overdue: false, overdue_reason: null,
    closed: MEMORY_HOLDOUT_CLOSED });
  expect(r.overdue).not.toContain('memory-holdout');
  // a read-out experiment no longer counts as active on the oracle-goal population
  expect(r.wip.active).not.toContain('memory-holdout');
  expect(detectStallsWithHealth(db, late, {}).stalls.map((s) => s.subsystem)).not.toContain('experiment:memory-holdout');
  // the same definition without the close is overdue: the close is what stops it
  const open: ExperimentDef = { ...mh, closed: undefined, status: () => ({ n_per_arm: null, verdict: null }) };
  expect(experimentsReport(db, {}, late, [open]).overdue).toEqual(['memory-holdout']);
});

it('EXP-3 close cites the result document and a heading that exists in it', () => {
  const [file, anchor] = MEMORY_HOLDOUT_CLOSED.source.split('#');
  const doc = readFileSync(join(__dirname, '../../../..', file), 'utf8');
  const heading = doc.split('\n').find((l) => l.startsWith('## ') && l.slice(3).toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-') === anchor);
  expect(heading).toBe('## Decision under the registered rules');
});

it('evolution-evidence carries the registry as the experiments section', () => {
  const e = buildEvolutionEvidence(db, {}, NOW);
  expect(e.experiments.experiments).toHaveLength(experimentDefs().length);
});

// G1.5: experiment WIP limit on the oracle-goal population (report-only + CI guard)
it('names each experiment\'s population; the oracle-goal population is the six experiments that randomise oracle goals', () => {
  const oracle = experimentDefs().filter((d) => d.population === 'oracle_goals').map((d) => d.id).sort();
  expect(oracle).toEqual(['ACE-001', 'F2', 'MAKER-DEPS-001', 'STE-001', 'X1', 'memory-holdout']);
  expect(EXPERIMENT_WIP_LIMIT).toBe(4);
});

it('CI guard: the registered oracle-population experiments fit the WIP limit; a 5th without approved_over_limit fails it', () => {
  const defs = experimentDefs();
  const g = wipCheck(defs);
  expect(g.ok, `over the WIP limit without approval: ${g.counted.join(', ')}`).toBe(true);
  expect(g.counted).toHaveLength(EXPERIMENT_WIP_LIMIT);
  expect(g.approved_over_limit.map((a) => a.id).sort()).toEqual(['F2', 'MAKER-DEPS-001']);
  const fifth = { ...defs[0], id: 'NEW-001', population: 'oracle_goals' as const, approved_over_limit: undefined };
  expect(wipCheck([...defs, fifth]).ok).toBe(false);
  // an explicit approval with a reason passes; an empty or token reason does not
  expect(wipCheck([...defs, { ...fifth, approved_over_limit: 'operator 2026-10-20: replaces X1 readout week, one week overlap' }]).ok).toBe(true);
  expect(wipCheck([...defs, { ...fifth, approved_over_limit: 'ok' }]).ok).toBe(false);
  // another population never counts
  expect(wipCheck([...defs, { ...fifth, population: 'gym_tasks' as const }]).ok).toBe(true);
});

it('reports active vs the limit and over_wip_limit; a read-out experiment is no longer active', () => {
  const r = experimentsReport(db, {}, NOW);
  // memory-holdout read out (closed FALSIFIED 2026-10-27): five active, three counted against the limit
  expect(r.wip).toMatchObject({ limit: 4, active_count: 5, over_wip_limit: true, guard_ok: true });
  expect(r.wip.counted).toEqual(['ACE-001', 'STE-001', 'X1']);
  const def = (id: string, verdict: string | null): ExperimentDef => ({ id, flag: 'T', protocol: 'p.md', started_at: '2026-10-01T00:00:00.000Z', target_n: 10, stop_by: null,
    stop_note: '', stop_source: 's', population: 'oracle_goals', status: () => ({ n_per_arm: { a: 1 }, verdict }) });
  const five = ['A', 'B', 'C', 'D', 'E'].map((id) => def(id, null));
  expect(experimentsReport(db, {}, NOW, five).wip).toMatchObject({ active_count: 5, over_wip_limit: true, guard_ok: false });
  expect(experimentsReport(db, {}, NOW, [...five.slice(0, 4), def('E', 'falsified')]).wip).toMatchObject({ active_count: 4, over_wip_limit: false, guard_ok: true });
});

it("power left: n so far vs target, days to stop_by, projected n at stop_by from the last-14-day accrual; unknown is null", () => {
  // 30 days in; arm a accrues 1/day throughout (n = days since `since`), arm b only 7 in the last 14 days
  const start = '2026-09-18T12:00:00.000Z';
  const since14 = new Date(NOW - 14 * 86_400_000).toISOString();
  const def: ExperimentDef = { id: 'P', flag: 'P', protocol: 'p.md', started_at: start, target_n: 40, stop_by: '2026-10-28T12:00:00.000Z', stop_note: '', stop_source: 's', population: 'oracle_goals',
    status: (_db, _env, now, since) => since === start ? { n_per_arm: { a: 30, b: 20 }, verdict: null }
      : { n_per_arm: { a: Math.round((now - Date.parse(since)) / 86_400_000), b: 7 }, verdict: null } };
  const p = experimentsReport(db, {}, NOW, [def]).experiments[0].power;
  expect(since14 > start).toBe(true);
  expect(p).toEqual({ n_so_far: 20, target_per_arm: 40, days_to_stop: 10, accrual_window_days: 14, accrual_per_day: { a: 1, b: 0.5 },
    projected_min_arm_n: 25, projected_reaches_target: false });
  // a status that cannot window: accrual and projection unknown, not 0
  const fixed = experimentsReport(db, {}, NOW, [{ ...def, status: (_d, _e, _n, since) => (since === start ? { n_per_arm: { a: 30 }, verdict: null } : { n_per_arm: null, verdict: null }) }]).experiments[0].power;
  expect(fixed).toMatchObject({ n_so_far: 30, accrual_per_day: null, projected_min_arm_n: null, projected_reaches_target: null });
  // no stop date: no days to stop, no projection
  expect(experimentsReport(db, {}, NOW, [{ ...def, stop_by: null }]).experiments[0].power).toMatchObject({ days_to_stop: null, projected_min_arm_n: null });
  // the registered experiments all carry a power row; on an empty database the projection is a number where accrual is known
  const real = experimentsReport(db, {}, NOW).experiments;
  for (const e of real) expect(e.power.target_per_arm, e.id).toBe(e.target_n);
  expect(real.find((e) => e.id === 'TG-001')?.power.accrual_per_day).toBeNull();
});

it('PL-001: registered with the protocol stop rule — a decide-start date before the first attempt, first attempt + 14 d after it', () => {
  const pl = experimentsReport(db, {}, NOW).experiments.find((e) => e.id === 'PL-001')!;
  expect(pl).toMatchObject({ flag: 'PL_001_MODE', target_n: 60, population: 'gym_tasks', started_at: '2026-10-26T00:00:00.000Z', stop_by: '2026-11-25T00:00:00.000Z', n_per_arm: null, verdict: null, overdue: false });
  const [file, anchor] = pl.stop_source.split('#');
  const doc = readFileSync(join(__dirname, '../../../..', file), 'utf8');
  const heading = doc.split('\n').find((l) => l.startsWith('## ') && l.slice(3).toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-') === anchor);
  expect(heading).toBe('## Amendment 2026-10-26: runner');
  expect(doc).toContain('2026-11-25');
  expect(doc).toContain('verdict rules unchanged');
  // with a first attempt the stop date is the frozen rule: first attempt + 14 days
  db.prepare("INSERT INTO pl_attempts (id, experiment_id, task_key, arm, seq, status, retries, first_claimed_at, updated_at) VALUES ('a', 'pl-001', 'k', 'A', 0, 'claimed', 0, '2026-11-01T10:00:00.000Z', 'x')").run();
  const started = experimentsReport(db, {}, NOW).experiments.find((e) => e.id === 'PL-001')!;
  expect(started).toMatchObject({ started_at: '2026-11-01T10:00:00.000Z', stop_by: '2026-11-15T10:00:00.000Z' });
  expect(experimentDefs().find((d) => d.id === 'PL-001')!.stop_by).toBe('2026-11-25T00:00:00.000Z'); // the registered date is unchanged
});

// E-assumptions A18: experiments share the oracle-goal population; EXP-3's action (LOOP_MEMORY_RULES_ENABLED=false, 10-27)
// changed the maker context of four others and each protocol had to add the period boundary by hand
it('A18: every running experiment declares the env names that alter its treatment, its own flag first', () => {
  const running = ['ACE-001', 'STE-001', 'MAKER-DEPS-001', 'X1', 'F2', 'PL-001'];
  for (const d of experimentDefs().filter((x) => running.includes(x.id))) {
    expect(d.treatment_env?.[0], d.id).toBe(d.flag);
    expect(d.treatment_env!.every((n) => /^[A-Z][A-Z0-9_]+$/.test(n)), d.id).toBe(true);
  }
  const memory = experimentDefs().filter((d) => d.treatment_env?.includes('LOOP_MEMORY_RULES_ENABLED')).map((d) => d.id);
  expect(memory).toEqual(['ACE-001', 'STE-001', 'MAKER-DEPS-001', 'X1', 'F2']);
});

// E-assumptions A18/C8 (re-20261030): at 10-30 09:42 LOOP_BANDIT_MAX_SHARE went 0.8 → default 0.1, an acting flag that
// changes the maker-species mix of the shared oracle-goal population, and 0 period boundaries were written: no experiment
// declared it. Every env name maker selection reads must be a treatment variable of every running oracle-population experiment.
const MAKER_SELECTION_SOURCES = ['runtime-bandit.ts', 'remote-maker-queue.ts', 'meta-orchestration-service.ts'];
const envNames = (src: string) => [...src.matchAll(/(?:process\.)?env\.([A-Z][A-Z0-9_]+)|env\[['"]([A-Z][A-Z0-9_]+)['"]\]/g)].map((m) => m[1] ?? m[2]);
function makerSelectionEnv(): string[] {
  const dir = join(__dirname, '../services');
  const daemon = readFileSync(join(dir, 'loop-daemon.ts'), 'utf8');
  // loop-daemon's maker selection: from the operator's explicit maker runtime through the bandit choice (5b), up to D2
  const start = daemon.indexOf('const makerRuntime = '); const end = daemon.indexOf('// D2: attribute the maker to its strategy genome');
  expect(start, 'loop-daemon maker selection start marker').toBeGreaterThan(0); expect(end, 'loop-daemon maker selection end marker').toBeGreaterThan(start);
  expect(daemon.slice(start, end)).toMatch(/chooseSpecies\(.*banditSpecies\(\)/); // the bandit (runtime-bandit.ts) chooses
  expect(daemon.slice(start, end)).toContain('assertRuntimeAvailable('); // remote is available only under REMOTE_MAKER_ENABLED
  return [...new Set([...envNames(daemon.slice(start, end)), ...MAKER_SELECTION_SOURCES.flatMap((f) => envNames(readFileSync(join(dir, f), 'utf8')))])].sort();
}
it('C8: every env name read by loop-daemon maker selection is a treatment variable of every running oracle-population experiment', () => {
  const names = makerSelectionEnv();
  for (const n of ['LOOP_BANDIT_ENABLED', 'LOOP_BANDIT_SPECIES', 'LOOP_BANDIT_MAX_SHARE', 'REMOTE_MAKER_ENABLED', 'META_TUNING_MIN_CONFIDENCE']) expect(names).toContain(n);
  const oracle = experimentDefs().filter((d) => d.population === 'oracle_goals' && !d.closed);
  expect(oracle.map((d) => d.id)).toEqual(['ACE-001', 'STE-001', 'MAKER-DEPS-001', 'X1', 'F2']);
  for (const d of oracle) {
    const undeclared = names.filter((n) => !d.treatment_env?.includes(n));
    expect(undeclared, `${d.id}: maker-selection env not declared as treatment_env`).toEqual([]);
    expect(d.treatment_env?.[0], d.id).toBe(d.flag);
  }
});

it('C8: changing LOOP_BANDIT_MAX_SHARE between boots writes a period boundary for ACE-001, STE-001, MAKER-DEPS-001, X1 and F2', () => {
  const t = (d: string) => Date.parse(`2026-10-${d}T09:42:39Z`);
  expect(recordTreatmentEnvBoundaries(db, { LOOP_BANDIT_MAX_SHARE: '0.8' }, t('29'))).toEqual([]);
  const rows = recordTreatmentEnvBoundaries(db, {}, t('30')); // unset → code default 0.1
  expect(rows.map((r) => [r.experiment_id, r.env_name, r.previous, r.current])).toEqual(['ACE-001', 'STE-001', 'MAKER-DEPS-001', 'X1', 'F2'].map((id) => [id, 'LOOP_BANDIT_MAX_SHARE', '0.8', null]));
  expect(experimentsReport(db, {}, t('30') + 1000).experiments.find((e) => e.id === 'PL-001')?.period_boundaries).toEqual([]); // gym population: not altered
});

it('A18: toggling LOOP_MEMORY_RULES_ENABLED between boots records a period boundary for ACE-001 (and every experiment it alters)', () => {
  const t = (d: string) => Date.parse(`2026-10-${d}T06:00:00Z`);
  expect(recordTreatmentEnvBoundaries(db, { LOOP_MEMORY_RULES_ENABLED: 'true', ACE_001_MODE: 'on' }, t('20'))).toEqual([]); // first boot: nothing to compare
  expect(recordTreatmentEnvBoundaries(db, { LOOP_MEMORY_RULES_ENABLED: 'true', ACE_001_MODE: 'on' }, t('21'))).toEqual([]); // unchanged
  const rows = recordTreatmentEnvBoundaries(db, { LOOP_MEMORY_RULES_ENABLED: 'false', ACE_001_MODE: 'on' }, t('27'));
  expect(rows.map((r) => r.experiment_id)).toEqual(['ACE-001', 'STE-001', 'MAKER-DEPS-001', 'X1', 'F2']);
  expect(rows[0]).toEqual({ experiment_id: 'ACE-001', env_name: 'LOOP_MEMORY_RULES_ENABLED', previous: 'true', current: 'false', at: '2026-10-27T06:00:00.000Z' });
  const report = experimentsReport(db, {}, t('28'));
  expect(report.experiments.find((e) => e.id === 'ACE-001')?.period_boundaries).toEqual([{ at: '2026-10-27T06:00:00.000Z', env: 'LOOP_MEMORY_RULES_ENABLED', from: 'true', to: 'false' }]);
  expect(report.experiments.find((e) => e.id === 'PL-001')?.period_boundaries).toEqual([]);
  // the evolution-evidence experiments section carries the same boundaries
  expect(buildEvolutionEvidence(db, {}, t('28')).experiments.experiments.find((e) => e.id === 'F2')?.period_boundaries).toHaveLength(1);
  // the next boot with the same env adds nothing; unsetting a flag is a change too
  expect(recordTreatmentEnvBoundaries(db, { LOOP_MEMORY_RULES_ENABLED: 'false', ACE_001_MODE: 'on' }, t('28'))).toEqual([]);
  expect(recordTreatmentEnvBoundaries(db, { LOOP_MEMORY_RULES_ENABLED: 'false' }, t('29'))).toEqual([
    { experiment_id: 'ACE-001', env_name: 'ACE_001_MODE', previous: 'on', current: null, at: '2026-10-29T06:00:00.000Z' }]);
});
