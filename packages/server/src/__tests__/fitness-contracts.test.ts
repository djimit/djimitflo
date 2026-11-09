import { readdirSync } from 'fs';
import { join } from 'path';
import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { buildEvolutionEvidence, EVOLUTION_FLAGS } from '../services/evolution-evidence';
import { experimentDefs } from '../services/experiment-registry';
import { learningLedger } from '../services/learning-ledger';
import { judgmentMode } from '../services/judgment-service';
import {
  contractViolations, FITNESS_CONTRACTS, FITNESS_EXEMPT_FLAGS, FITNESS_STATUSES, fitnessContractsReport, judgmentFlag, uncoveredActingFlags,
  type FitnessContract,
} from '../services/fitness-contracts';

let db: Database.Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

const acting = EVOLUTION_FLAGS.filter((f) => f.acting).map((f) => f.name);

/** every JudgmentDef exported from services/judgments/*.ts (the static definitions) */
async function judgmentDefIds(): Promise<string[]> {
  const dir = join(__dirname, '..', 'services', 'judgments');
  const ids: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
    const mod = await import(join(dir, file)) as Record<string, unknown>;
    for (const v of Object.values(mod)) {
      if (v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string' && 'questions' in v && typeof (v as { decide?: unknown }).decide === 'function') ids.push((v as { id: string }).id);
    }
  }
  return ids.sort();
}

it('every acting EVOLUTION_FLAGS entry maps to a fitness contract or an explicit exemption with a reason', () => {
  expect(uncoveredActingFlags(EVOLUTION_FLAGS)).toEqual([]);
  for (const [flag, reason] of Object.entries(FITNESS_EXEMPT_FLAGS)) expect(reason.trim().length, `${flag}: exemption needs a reason`).toBeGreaterThanOrEqual(20);
});

it('a new acting flag without a contract fails the coverage check (negative)', () => {
  const flags = [...EVOLUTION_FLAGS, { name: 'FAKE_NEW_ACTING_FLAG', acting: true }, { name: 'FAKE_NEW_SHADOW_FLAG', acting: false }];
  expect(uncoveredActingFlags(flags)).toEqual(['FAKE_NEW_ACTING_FLAG']);
  // an exemption without a reason does not cover it either
  expect(uncoveredActingFlags(flags, FITNESS_CONTRACTS, { ...FITNESS_EXEMPT_FLAGS, FAKE_NEW_ACTING_FLAG: ' ' })).toEqual(['FAKE_NEW_ACTING_FLAG']);
});

it('contracts and exemptions only name registered flags, and no flag is both mapped and exempt', () => {
  const registered = new Set(EVOLUTION_FLAGS.map((f) => f.name));
  const mapped = FITNESS_CONTRACTS.flatMap((c) => c.flags);
  expect(mapped.filter((f) => !registered.has(f))).toEqual([]);
  expect(Object.keys(FITNESS_EXEMPT_FLAGS).filter((f) => !registered.has(f))).toEqual([]);
  expect(mapped.filter((f) => f in FITNESS_EXEMPT_FLAGS)).toEqual([]);
  // exemptions are for acting flags only (a non-acting flag needs no contract)
  expect(Object.keys(FITNESS_EXEMPT_FLAGS).filter((f) => !acting.includes(f))).toEqual([]);
});

it('every judgment definition has a contract, and every TYPESAFE_<id>_MODE flag points at one', async () => {
  const defs = await judgmentDefIds();
  expect(defs.length).toBeGreaterThanOrEqual(8);
  const judged = new Set(FITNESS_CONTRACTS.map((c) => c.judgment).filter(Boolean));
  expect(defs.filter((id) => !judged.has(id))).toEqual([]);
  // the dynamic definitions (decision_context, kb_passage_relevance) are reached through their mode flag
  const flagIds = EVOLUTION_FLAGS.map((f) => /^TYPESAFE_(.+)_MODE$/.exec(f.name)?.[1]?.toLowerCase()).filter((x): x is string => !!x);
  expect(flagIds.filter((id) => !judged.has(id))).toEqual([]);
  // a judgment contract carries its own mode flag, the name judgmentMode() reads
  for (const c of FITNESS_CONTRACTS.filter((x) => x.judgment)) {
    expect(c.flags, c.component).toContain(judgmentFlag(c.judgment!));
    expect(judgmentMode(c.judgment!, { [judgmentFlag(c.judgment!)]: 'shadow' })).toBe('shadow');
  }
});

it('the registry is internally valid: unique components, closed_loop rules, status agrees with the outcome', () => {
  expect(contractViolations(FITNESS_CONTRACTS)).toEqual([]);
  const keys = FITNESS_CONTRACTS.map((c) => c.component);
  expect(new Set(keys).size).toBe(keys.length);
  for (const c of FITNESS_CONTRACTS) expect(FITNESS_STATUSES, c.component).toContain(c.status);
});

const base: FitnessContract = {
  component: 'fake', class: 'lane', name: 'Fake', unit: 'one run', flags: [],
  outcome: { metric: 'verified', source: 'self_improvements.status', independence: 'independent' },
  cost: { tokens: null, kwh: null, operator_minutes: null },
  comparison: { kind: 'randomised', ref: 'X1' }, decision_rule: 'promote above p < 0.05', inheritance: null, status: 'closed_loop', note: '',
};

it('closed_loop needs a comparison, a decision rule and a non-circular outcome (negative)', () => {
  expect(contractViolations([base])).toEqual([]);
  expect(contractViolations([{ ...base, comparison: { kind: 'none', ref: null } }])).toEqual(['fake: closed_loop needs a comparison (randomised / holdout / benchmark), not none']);
  expect(contractViolations([{ ...base, decision_rule: null }])).toEqual(['fake: closed_loop needs a decision_rule']);
  expect(contractViolations([{ ...base, decision_rule: '  ' }])).toEqual(['fake: closed_loop needs a decision_rule']);
  expect(contractViolations([{ ...base, outcome: { ...base.outcome, independence: 'circular' } }])).toContain('fake: closed_loop needs an outcome independent of the component (got circular)');
  // a comparison other than none names its experiment or benchmark
  expect(contractViolations([{ ...base, comparison: { kind: 'holdout', ref: null } }])).toEqual(['fake: comparison holdout names no experiment or benchmark']);
  // circular outcome ⇔ status circular; no outcome ⇔ unmeasured
  expect(contractViolations([{ ...base, status: 'measured_no_selection', outcome: { ...base.outcome, independence: 'circular' } }])).toEqual(['fake: a circular outcome has status circular (got measured_no_selection)']);
  expect(contractViolations([{ ...base, status: 'unmeasured', outcome: { ...base.outcome, independence: 'independent' } }])).toEqual(['fake: unmeasured has no outcome (independence none), got independent']);
  expect(contractViolations([{ ...base, status: 'measured_no_selection', outcome: { ...base.outcome, independence: 'none' } }])).toEqual(['fake: an outcome of none is unmeasured (got measured_no_selection)']);
  expect(contractViolations([base, base])).toEqual(['fake: duplicate component']);
});

it('experiment refs and learning-ledger mechanisms are the existing registries\' own ids', () => {
  const ids = new Set(experimentDefs().map((d) => d.id));
  for (const c of FITNESS_CONTRACTS) if (c.experiment) expect(ids.has(c.experiment), `${c.component}: ${c.experiment}`).toBe(true);
  // a contract that names an experiment compares against it
  for (const c of FITNESS_CONTRACTS) if (c.experiment) expect(c.comparison.ref?.startsWith(c.experiment), `${c.component}: comparison ref names ${c.experiment}`).toBe(true);
  db = new Database(':memory:');
  const mechanisms = new Set(learningLedger(db, [], null).mechanisms.map((m) => m.mechanism));
  for (const c of FITNESS_CONTRACTS) if (c.mechanism) expect(mechanisms.has(c.mechanism), `${c.component}: ${c.mechanism}`).toBe(true);
});

it('covers every component class the operator listed', () => {
  const keys = new Set(FITNESS_CONTRACTS.map((c) => c.component));
  for (const k of ['maker_species', 'checker', 'security_checker', 'skill_route', 'outcome_attribution', 'memory_rules', 'kb_retrieval', 'expert_units', 'discoveries', 'specialist_panel',
    'committee_swarm', 'forecasters', 'gym_genomes', 'lane_test_gap', 'lane_mutation_gap', 'lane_exports', 'lane_dashboard', 'lane_finding_fix', 'lane_dead_code',
    'lane_dependency', 'auto_merge', 'value_gate']) expect(keys.has(k), k).toBe(true);
});

it('fitness_contracts in evolution evidence: counts by status, coverage and the list, read-only', () => {
  db = new Database(':memory:');
  const e = buildEvolutionEvidence(db, {}, Date.parse('2026-11-07T00:00:00Z'));
  const r = e.fitness_contracts;
  expect(r.total).toBe(FITNESS_CONTRACTS.length);
  expect(Object.keys(r.by_status).sort()).toEqual([...FITNESS_STATUSES].sort());
  expect(Object.values(r.by_status).reduce((a, n) => a + n, 0)).toBe(r.total);
  expect(r.coverage).toEqual({ acting_flags: acting.length, mapped: expect.any(Number), exempt: Object.keys(FITNESS_EXEMPT_FLAGS).length, unmapped: [] });
  expect(r.coverage.mapped + r.coverage.exempt).toBe(acting.length);
  expect(r.violations).toEqual([]);
  expect(r.contracts.map((c) => c.component)).toEqual(FITNESS_CONTRACTS.map((c) => c.component));
  // the ledger status rides along for contracts that name a mechanism (no new statistic)
  const mem = r.contracts.find((c) => c.component === 'memory_rules');
  expect(mem?.ledger_status).toBe('REJECTED');
});

it('report: an unmapped acting flag is listed, never silently counted', () => {
  const r = fitnessContractsReport([{ name: 'FAKE_NEW_ACTING_FLAG', acting: true }]);
  expect(r.coverage).toEqual({ acting_flags: 1, mapped: 0, exempt: 0, unmapped: ['FAKE_NEW_ACTING_FLAG'] });
});
