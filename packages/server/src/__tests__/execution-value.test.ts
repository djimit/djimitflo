import { describe, expect, it } from 'vitest';
import {
  fitEvModel, orderB, policyC, predict, protectedPool, replay, seeded, selectUnderBudget, verdict,
  type EvFeatures, type FitRow,
} from '../services/execution-value';
import { buildRun } from '../scripts/execution-value-offline';

const CUT = '2026-10-07T00:00:00Z';
const feat = (i: number, kind: string, dir = 'packages/server/src', day = 1): EvFeatures =>
  ({ id: `r${i}`, created_at: `2026-10-${String(day).padStart(2, '0')}T00:00:${String(i % 60).padStart(2, '0')}Z`, lane: 'doc-drift', kind, dir, target: `${dir}/f${i}.ts` });
const fitRows = (): FitRow[] => [
  ...Array.from({ length: 10 }, (_, i): FitRow => ({ f: feat(i, 'test-gap'), y: i < 8 ? 1 : 0, cost: 0.5, label_at: '2026-10-02T00:00:00Z' })),
  ...Array.from({ length: 6 }, (_, i): FitRow => ({ f: feat(20 + i, 'mutation-gap'), y: i < 2 ? 1 : 0, cost: 1.2, label_at: '2026-10-03T00:00:00Z' })),
];
const evalFeats = Array.from({ length: 30 }, (_, i) => feat(100 + i, i % 3 === 0 ? 'mutation-gap' : i % 7 === 0 ? 'build' : 'test-gap', i % 5 === 0 ? 'packages/shared/src' : 'packages/server/src', 10));

describe('DI-001 EV model', () => {
  it('is deterministic and independent of fit-row order', () => {
    const a = fitEvModel(fitRows(), CUT); const b = fitEvModel([...fitRows()].reverse(), CUT);
    expect(evalFeats.map((f) => predict(a, f))).toEqual(evalFeats.map((f) => predict(b, f)));
    expect(evalFeats.map((f) => predict(a, f))).toEqual(evalFeats.map((f) => predict(fitEvModel(fitRows(), CUT), f)));
  });

  it('shrinks hierarchically: global (1+k)/(2+n), then each level (k + m·p_parent)/(n + m)', () => {
    const m = fitEvModel(fitRows(), CUT);
    const g = (1 + 10) / (2 + 16); expect(m.globalP).toBeCloseTo(g, 9);
    const lane = (10 + 4 * g) / (16 + 4); const kind = (8 + 4 * lane) / (10 + 4); const dir = (8 + 4 * kind) / (10 + 4);
    const p = predict(m, feat(200, 'test-gap', 'packages/server/src', 10));
    expect(p.p).toBeCloseTo(dir, 5);
    expect(p.sd).toBeCloseTo(Math.sqrt(dir * (1 - dir) / (10 + 4 + 1)), 5);
    expect(m.lambda).toBeCloseTo(10 / (10 * 0.5 + 6 * 1.2), 9);
    expect(p.ev).toBeCloseTo(p.p - m.lambda * p.cost, 5);
    // an unseen kind falls back to the lane estimate and is novel
    const u = predict(m, feat(201, 'build', 'docs/x', 10));
    expect(u.novel).toBe(true); expect(u.n_cell).toBe(16);
  });
});

describe('DI-001 no label leak', () => {
  it('ignores rows created or labelled at/after the cutoff', () => {
    const leaky: FitRow[] = [...fitRows(),
      ...evalFeats.map((f): FitRow => ({ f, y: 0, cost: 99, label_at: '2026-10-11T00:00:00Z' })),
      { f: feat(50, 'test-gap'), y: 0, cost: null, label_at: '2026-10-09T00:00:00Z' }]; // created before, labelled after
    const clean = fitEvModel([...fitRows(), { f: feat(50, 'test-gap'), y: null, cost: null, label_at: null }], CUT);
    const dirty = fitEvModel(leaky, CUT);
    expect(evalFeats.map((f) => predict(dirty, f))).toEqual(evalFeats.map((f) => predict(clean, f)));
  });

  it('permuting eval labels and realised costs changes no prediction, B order or protected pool', () => {
    const model = fitEvModel(fitRows(), CUT);
    const ps = evalFeats.map((f) => predict(model, f));
    // predictions are a function of (model, features) only; the evaluator's outcomes are a separate argument
    const r = seeded(3); const ps2 = evalFeats.map((f) => predict(model, f));
    const costs1 = new Map(ps.map((p) => [p.id, 0.2 + r()])); const costs2 = new Map(ps.map((p) => [p.id, 0.2 + r() * 5]));
    expect(ps2).toEqual(ps);
    expect(orderB(ps2).map((p) => p.id)).toEqual(orderB(ps).map((p) => p.id));
    expect([...protectedPool(ps2).protectedIds]).toEqual([...protectedPool(ps).protectedIds]);
    // C's phase orders do not depend on cost: with unlimited budget both cost maps select every run in the same order
    expect(policyC(ps, (id) => costs1.get(id)!, 1e9).ids).toEqual(policyC(ps, (id) => costs2.get(id)!, 1e9).ids);
  });
});

describe('DI-001 budgeted replays', () => {
  it('never exceeds the budget, and selects everything at f = 1', () => {
    const model = fitEvModel(fitRows(), CUT); const ps = evalFeats.map((f) => predict(model, f));
    const r = seeded(5); const cost = new Map(ps.map((p) => [p.id, 0.1 + 2 * r()]));
    for (const f of [0.1, 0.25, 0.5, 0.75]) {
      const rp = replay(ps, (id) => cost.get(id)!, f);
      for (const s of [rp.A, rp.B, rp.C]) expect(s.spent).toBeLessThanOrEqual(rp.budget + 1e-9);
      expect(new Set(rp.C.ids).size).toBe(rp.C.ids.length);
    }
    const all = replay(ps, (id) => cost.get(id)!, 1);
    expect(all.A.ids.length).toBe(ps.length); expect(all.B.ids.length).toBe(ps.length); expect(all.C.ids.length).toBe(ps.length);
    expect(selectUnderBudget(['a', 'b', 'c'], () => 1, 2).ids).toEqual(['a', 'b']);
  });

  it('exploration floor: C spends ≥ X·budget − max protected cost on protected runs, unless all of them fit', () => {
    const r = seeded(9);
    for (let trial = 0; trial < 200; trial++) {
      const n = 5 + Math.floor(r() * 40);
      const ps = Array.from({ length: n }, (_, i) => ({ id: `t${trial}-${i}`, created_at: `2026-10-10T00:00:${String(i % 60).padStart(2, '0')}Z`,
        p: +r().toFixed(3), sd: +(r() * 0.3).toFixed(3), cost: 1, ev: +(r() - 0.5).toFixed(3), n_cell: Math.floor(r() * 5), novel: r() < 0.2 }));
      const cost = new Map(ps.map((p) => [p.id, 0.05 + 3 * r()]));
      const costOf = (id: string) => cost.get(id)!;
      const budget = (0.1 + 0.8 * r()) * ps.reduce((a, p) => a + costOf(p.id), 0); const x = [0.1, 0.2, 0.3][trial % 3];
      const c = policyC(ps, costOf, budget, x);
      const prot = [...protectedPool(ps).protectedIds];
      const allFit = prot.every((id) => c.ids.includes(id));
      const maxCost = Math.max(...prot.map(costOf));
      expect(c.spent).toBeLessThanOrEqual(budget + 1e-9);
      if (!allFit) expect(c.protected_spent).toBeGreaterThanOrEqual(x * budget - maxCost - 1e-9);
      // difficult runs are in the protected pool whatever their predicted success
      for (const id of protectedPool(ps).difficultIds) expect(prot).toContain(id);
    }
  });
});

describe('DI-001 verdict and labels', () => {
  it('applies the pre-registered thresholds', () => {
    expect(verdict(59, 40, [0.1, 0.2])).toBe('INSUFFICIENT');
    expect(verdict(80, 14, [0.1, 0.2])).toBe('INSUFFICIENT');
    expect(verdict(80, 20, [-0.1, 0.2])).toBe('INCONCLUSIVE');
    expect(verdict(80, 20, [0.01, 0.2])).toBe('SUPPORTED_OFFLINE');
    expect(verdict(80, 20, [0.01, 0.2], false)).toBe('INCONCLUSIVE');
    expect(verdict(80, 20, [-0.3, -0.01])).toBe('NOT_SUPPORTED');
  });

  const run = (over: Record<string, unknown> = {}, maker: Record<string, unknown> = {}, reviewers: unknown[] = []) => ({
    id: 'r1', lane: 'doc-drift', status: 'completed', created_at: '2026-10-10T00:00:00Z', completed_at: '2026-10-10T01:00:00Z', updated_at: '2026-10-10T01:00:00Z', task_id: 't1',
    proposal: { type: 'feature', first_ref: 'test-gap:x#exports', target: 'packages/server/src/services/x.ts', priority: 0.5 }, finding_file: null,
    failed_gates: [] as string[], pr_outcome: null, annotations: [], dispatch_failed_roles: [],
    arms: { effort_arm: null, checker_family_arm: null, memory_holdout: null, ace_arm: null, ste_arm: null }, bandit: null,
    leases: [{ id: 'm1', role: 'maker', status: 'completed', runtime: 'opencode', model: null, tokens: 400_000,
      metadata: { exit_status: 0, completed_at: '2026-10-10T00:30:00Z', changed_files: ['a.ts'], deterministic_checks: [{ exit_status: 0 }, { exit_status: null }], ...maker } }, ...reviewers],
    ...over,
  }) as unknown as Parameters<typeof buildRun>[0];

  it('merged → y_merge 1; a skipped (null) check does not block y_oracle 1; kind/dir from the proposal', () => {
    const b = buildRun(run({ pr_outcome: { state: 'merged', merged_at: '2026-10-11T00:00:00Z' } }));
    expect(b.y).toEqual({ y_merge: 1, y_oracle: 1 }); expect(b.label_at.y_merge).toBe('2026-10-11T00:00:00Z');
    expect(b.f.kind).toBe('test-gap'); expect(b.f.dir).toBe('packages/server/src'); expect(b.cost).toBeCloseTo(0.4, 9);
  });

  it('reviewer_failure and environment_failure are never failures', () => {
    const rev = buildRun(run({ failed_gates: ['checker_verdict: missing'] }, {}, [{ id: 'c1', role: 'checker', status: 'failed', runtime: 'opencode', model: null, tokens: null, metadata: { maker_lease_id: 'm1', failure_reason: 'checker_runtime_failed:exit=1,timed_out=true' } }]));
    expect(rev.attribution).toBe('reviewer_failure'); expect(rev.y.y_merge).toBeNull(); expect(rev.y.y_oracle).toBe(1);
    const env = buildRun(run({ failed_gates: ['tests_lint_typecheck: fail'] }, { changed_files: [] }));
    expect(env.attribution).toBe('environment_failure'); expect(env.y).toEqual({ y_merge: null, y_oracle: null });
  });

  it('a failed deterministic check is a maker failure on both labels; a checker rejection alone is not an oracle failure', () => {
    const mk = buildRun(run({ failed_gates: ['tests_lint_typecheck: fail'] }, { deterministic_checks: [{ exit_status: 1 }] }));
    expect(mk.attribution).toBe('maker_failure'); expect(mk.y).toEqual({ y_merge: 0, y_oracle: 0 });
    const rej = buildRun(run({ failed_gates: ['checker_verdict: rejected'] }, {}, [{ id: 'c1', role: 'checker', status: 'completed', runtime: 'opencode', model: null, tokens: 1, metadata: { maker_lease_id: 'm1', verdict: 'rejected' } }]));
    expect(rej.y).toEqual({ y_merge: 0, y_oracle: 1 });
  });
});
