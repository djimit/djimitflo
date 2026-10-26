import type { Arm, PilotRow } from './run';
import { clusterBootstrap, costPerSuccess, mcnemarExact, newcombePaired, pairedRatioBootstrap, wilson, type CostRow } from './stats';

/**
 * Pre-registered analysis (PREREG.md §4–5) over pilot rows. Repetition 1 only for the paired tests. A mechanism pilot is
 * INCONCLUSIVE for H1–H3 and H5 by construction (scripted agents); H4 counts invariant violations, which a pilot can show.
 */
const fin = (x: number): number | 'Infinity' => (Number.isFinite(x) ? +x.toFixed(4) : 'Infinity');
const ci = (c: [number, number] | null) => (c ? [fin(c[0]), fin(c[1])] : null);

function armSummary(rows: PilotRow[]) {
  const cost: CostRow[] = rows.map((r) => ({ cluster: r.family, cost: r.cost_units, success: r.verified }));
  const k = rows.filter((r) => r.verified).length;
  const boot = clusterBootstrap(cost, costPerSuccess);
  return {
    n: rows.length, verified: k, success_rate: rows.length ? +(k / rows.length).toFixed(4) : null, success_ci: ci(wilson(k, rows.length)),
    total_cost: rows.reduce((s, r) => s + r.cost_units, 0), cost_per_verified: fin(boot.estimate), cost_per_verified_ci: ci(boot.ci), bootstrap_infinite_draws: boot.infinite_draws,
    routes: count(rows.map((r) => r.route ?? 'n/a')), routes_executed: count(rows.map((r) => r.route_executed ?? 'n/a')),
    macro_adoption: rows.length ? +(rows.filter((r) => r.macro_calls > 0).length / rows.length).toFixed(4) : null,
    recovery_triggered: rows.filter((r) => r.recovery_triggered).length, recovered_and_verified: rows.filter((r) => r.recovery_triggered && r.verified).length,
    incidents: rows.filter((r) => r.incident).length, mean_transitions: rows.length ? +(rows.reduce((s, r) => s + r.transitions, 0) / rows.length).toFixed(2) : null,
    invariant_violations: rows.reduce((s, r) => s + r.invariant_violations.length, 0),
  };
}
const count = (xs: string[]) => xs.reduce<Record<string, number>>((m, x) => { m[x] = (m[x] ?? 0) + 1; return m; }, {});

function paired(rows: PilotRow[], x: Arm, y: Arm) {
  const key = (r: PilotRow) => r.task_id;
  const xs = new Map(rows.filter((r) => r.arm === x).map((r) => [key(r), r])); const ys = new Map(rows.filter((r) => r.arm === y).map((r) => [key(r), r]));
  let a = 0, b = 0, c = 0, d = 0;
  for (const [t, rx] of xs) { const ry = ys.get(t); if (!ry) continue; if (rx.verified && ry.verified) a++; else if (rx.verified) b++; else if (ry.verified) c++; else d++; }
  const nc = newcombePaired(a, b, c, d);
  const ratio = pairedRatioBootstrap([...xs.values()].map((r) => ({ cluster: r.family, cost: r.cost_units, success: r.verified })), [...ys.values()].map((r) => ({ cluster: r.family, cost: r.cost_units, success: r.verified })));
  return { arms: `${x}-${y}`, cells: { both: a, [`${x}_only`]: b, [`${y}_only`]: c, neither: d }, mcnemar_exact: mcnemarExact(b, c), success_diff: nc ? fin(nc.diff) : null, success_diff_ci_newcombe: nc ? ci(nc.ci) : null,
    cost_per_verified_ratio: fin(ratio.estimate), cost_ratio_ci_cluster_bootstrap: ci(ratio.ci) };
}

export function analyse(rows: PilotRow[]) {
  const rep1 = rows.filter((r) => r.repetition === 1);
  const natural = rep1.filter((r) => r.condition === 'natural');
  const arms = [...new Set(natural.map((r) => r.arm))].sort() as Arm[];
  const byArm = Object.fromEntries(arms.map((a) => [a, armSummary(natural.filter((r) => r.arm === a))]));
  const comparisons = [['E', 'A'], ['D', 'B'], ['C', 'B'], ['E', 'D']].filter(([x, y]) => arms.includes(x as Arm) && arms.includes(y as Arm)).map(([x, y]) => paired(natural, x as Arm, y as Arm));
  const conditions = [...new Set(rep1.map((r) => r.condition))].filter((c) => c !== 'natural');
  const faults = Object.fromEntries(conditions.map((c) => {
    const rs = rep1.filter((r) => r.condition === c);
    return [c, Object.fromEntries([...new Set(rs.map((r) => r.arm))].sort().map((a) => [a, armSummary(rs.filter((r) => r.arm === a))]))];
  }));
  const violations = rows.flatMap((r) => r.invariant_violations.map((v) => ({ run_id: r.run_id, arm: r.arm, condition: r.condition, violation: v })));
  // H5: macro-only (C) success on train vs test families, natural condition, tasks where the macro was the route
  const h5 = (split: string) => { const rs = natural.filter((r) => r.arm === 'C' && r.split === split && r.macro_calls > 0); return { n: rs.length, verified: rs.filter((r) => r.verified).length, families: [...new Set(rs.map((r) => r.family))] }; };
  // per-family routes of E (decision-time) — the routing record
  const routes = Object.fromEntries([...new Set(natural.map((r) => r.family))].sort().map((f) => [f, natural.find((r) => r.family === f && r.arm === 'E')?.reason_codes ?? []]));
  return {
    kind: 'mechanism_pilot', primary_endpoint: 'cost per fully verified solved task (scripted cost units; zero successes = Infinity)',
    natural: { by_arm: byArm, comparisons }, injected_faults: faults, routes_by_family_E: routes,
    h4_invariant_violations: { total: violations.length, by_arm: count(violations.map((v) => v.arm)), list: violations },
    h5_macro_generalisation: { train: h5('train'), test: h5('test'), note: 'separate evidence; scripted plans; routing/retries/recoveries never count as evolution' },
  };
}
