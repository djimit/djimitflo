/**
 * DI-001 offline challenger (docs/research/di-001/EXECUTION_VALUE_PREREG.md). Reads a snapshot produced by
 * execution-value-extract.cjs (read-only prod SELECTs) and prints the pre-registered analysis as JSON.
 *   npx tsx packages/server/src/scripts/execution-value-offline.ts <snapshot.json> [out.json]
 * Offline only: no database, no network, no flag. Refuses to run against a prereg whose sha256 differs.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { attributeOutcome, type AttributionLease } from '../services/outcome-attribution';
import { propensities } from '../services/bandit-propensity';
import {
  bootstrapM1, fitEvModel, metrics, predict, protectedPool, randomOrderM1, replay, verdict,
  type EvFeatures, type EvOutcome, type EvPrediction, type FitRow,
} from '../services/execution-value';

export const EXECUTION_VALUE_PREREG_SHA256 = '731b67bbe00e4035855f1fbf608eb819a5bcdbc44d360d6742e2ecc9fc8bbf1e';

interface SnapLease { id: string; role: string; status: string; runtime: string; model: string | null; tokens: number | null; metadata: AttributionLease['metadata'] & { deterministic_checks?: Array<{ exit_status: number | null }> } }
interface PrOutcome { state?: string; merged_at?: string | null; survived?: boolean; settled_at?: string; checked_at?: string; not_scored?: string }
interface SnapRun {
  id: string; lane: string; status: string; created_at: string; completed_at: string | null; updated_at: string; task_id: string;
  proposal: { type: string | null; first_ref: string | null; target: string | null; priority: number | null };
  finding_file: string | null; failed_gates: string[]; pr_outcome: PrOutcome | null; leases: SnapLease[];
  annotations: Array<{ decision: string; created_at: string }>; dispatch_failed_roles: string[];
  arms: { effort_arm: string | null; checker_family_arm: string | null; memory_holdout: boolean | null; ace_arm: string | null; ste_arm: string | null };
  bandit: { chosen: string | null; max_share: number | null; posterior: Array<{ species: string; runs: number; ok: number }> } | null;
}
interface Snapshot { snapshot_at: string; runs: SnapRun[]; unexecuted_proposals: Array<{ id: string; type: string; priority: number; created_at: string; first_ref: string | null; status: string }>; excluded: Record<string, number> }

type Label = 'y_merge' | 'y_oracle';
interface Built { f: EvFeatures; y: Record<Label, 0 | 1 | null>; label_at: Record<Label, string | null>; cost: number | null; latency_h: number | null; regressed: boolean; merged: boolean; attribution: string; arms: string[]; species: string | null; bandit: SnapRun['bandit'] }

export const kindOf = (ref: string | null, type: string | null) => (ref && ref.includes(':') ? ref.slice(0, ref.indexOf(':')) : ref || type || 'unknown');
export const dirOf = (target: string) => target.split('/').slice(0, 3).join('/');

/** Prereg §3 labels from one stored run. exit_status null = a skipped check (loop-service.ts: script not present) — deviation D1. */
export function buildRun(r: SnapRun): Built {
  const maker = r.leases.filter((l) => l.role === 'maker').pop() ?? null;
  const att = attributeOutcome({ failed_gates: r.failed_gates, maker, reviewers: r.leases.filter((l) => l.role === 'checker' || l.role === 'security_checker'),
    annotations: r.annotations, pr_outcome: r.pr_outcome, dispatch_failed_roles: r.dispatch_failed_roles });
  const done = r.completed_at ?? r.updated_at;
  const pr = r.pr_outcome;
  let ym: 0 | 1 | null = null; let ymAt: string | null = null;
  if (pr?.state === 'merged') { ym = pr.survived === false ? 0 : 1; ymAt = pr.survived === false ? (pr.settled_at ?? null) : (pr.merged_at ?? pr.checked_at ?? null); }
  else if (pr?.state === 'closed_unmerged' && pr.not_scored !== 'stale_loop') { ym = 0; ymAt = pr.settled_at ?? pr.checked_at ?? null; }
  else if (att.outcome === 'maker_failure') { ym = 0; ymAt = done; }
  let yo: 0 | 1 | null = null;
  if (maker && att.outcome !== 'environment_failure') {
    const changed = Array.isArray(maker.metadata.changed_files) && maker.metadata.changed_files.length > 0;
    const checks = (maker.metadata.deterministic_checks ?? []).map((c) => c.exit_status).filter((e): e is number => e !== null && e !== undefined);
    if (maker.status === 'completed' && changed && checks.length && checks.every((e) => e === 0)) yo = 1;
    else if (changed && (checks.some((e) => e !== 0 && e !== 127) || maker.status !== 'completed')) yo = 0;
  }
  const known = r.leases.map((l) => l.tokens).filter((t): t is number => t !== null && t > 0);
  const target = r.proposal.target ?? r.finding_file ?? 'unknown';
  const arms = [r.arms.effort_arm && `x1:${r.arms.effort_arm}`, r.arms.checker_family_arm && `f2:${r.arms.checker_family_arm}`,
    r.arms.memory_holdout && 'memory_holdout', r.arms.ace_arm && `ace:${r.arms.ace_arm}`, r.arms.ste_arm && `ste:${r.arms.ste_arm}`].filter((a): a is string => !!a);
  return {
    f: { id: r.id, created_at: r.created_at, lane: r.lane, kind: kindOf(r.proposal.first_ref, r.proposal.type), dir: dirOf(target), target },
    y: { y_merge: ym, y_oracle: yo }, label_at: { y_merge: ymAt, y_oracle: yo === null ? null : done },
    cost: known.length ? known.reduce((a, b) => a + b, 0) / 1e6 : null,
    latency_h: done ? +((Date.parse(done) - Date.parse(r.created_at)) / 3_600_000).toFixed(3) : null,
    regressed: pr?.state === 'merged' && pr.survived === false, merged: pr?.state === 'merged', attribution: att.outcome, arms,
    species: maker ? (maker.model ? `${maker.runtime}@${maker.model}` : maker.runtime) : null, bandit: r.bandit,
  };
}

const r4 = (x: number) => +x.toFixed(4);

export function analyse(snap: Snapshot) {
  const built = snap.runs.map(buildRun).sort((a, b) => a.f.created_at.localeCompare(b.f.created_at) || a.f.id.localeCompare(b.f.id));
  const N = built.length;
  const cutoff = built[Math.floor(0.6 * N)].f.created_at;
  const fitPart = built.filter((b) => b.f.created_at < cutoff);
  const evalPart = built.filter((b) => b.f.created_at >= cutoff);
  const cellOf = (b: Built) => `${b.f.lane}|${b.f.kind}|${b.f.dir}`;
  const fitCells = new Set(fitPart.map(cellOf));
  const cellById = new Map(built.map((b) => [b.f.id, cellOf(b)]));

  const perLabel = (label: Label) => {
    const fitRows: FitRow[] = fitPart.map((b) => ({ f: b.f, y: b.y[label], cost: b.cost, label_at: b.label_at[label] }));
    const model = fitEvModel(fitRows, cutoff);
    const ps: EvPrediction[] = evalPart.map((b) => predict(model, b.f));
    const pMap = new Map(ps.map((p) => [p.id, p]));
    const fitTargets = new Set(model.fitTargets);
    const outcomes = new Map<string, EvOutcome>(evalPart.map((b) => [b.f.id, {
      id: b.f.id, y: b.y[label], cost: b.cost ?? pMap.get(b.f.id)!.cost, cost_imputed: b.cost === null, latency_h: b.latency_h,
      merged: b.merged, regressed: b.regressed, first_pair: !fitTargets.has(`${b.f.lane}|${b.f.target}`), arms: b.arms }]));
    const costOf = (id: string) => outcomes.get(id)!.cost;
    const { difficultIds } = protectedPool(ps);
    const run = (subset: EvPrediction[], f: number) => {
      const rp = replay(subset, costOf, f);
      const m = (ids: string[]) => metrics(ids, subset, outcomes, difficultIds, (id) => cellById.get(id)!, fitCells);
      return { f, budget_m: r4(rp.budget), total_m: r4(rp.total), A: m(rp.A.ids), B: m(rp.B.ids), C: { ...m(rp.C.ids), protected_spent_m: r4(rp.C.protected_spent) } };
    };
    const ys = evalPart.map((b) => b.y[label]);
    const labelled = ys.filter((y) => y !== null).length; const successes = ys.filter((y) => y === 1).length;
    const fs_ = [0.25, 0.5, 0.75].map((f) => run(ps, f));
    const ciMain = bootstrapM1(ps, outcomes, 0.5);
    const main = fs_[1];
    const knownOnly = ps.filter((p) => !outcomes.get(p.id)!.cost_imputed);
    return {
      fit: { n_runs: fitPart.length, n_labelled_before_cutoff: model.n_fit_labelled, n_cost_known: model.n_fit_cost, global_p: r4(model.globalP), global_cost_m: r4(model.globalCost), lambda_per_m: r4(model.lambda) },
      eval: { n_runs: evalPart.length, labelled, successes, failures: ys.filter((y) => y === 0).length, na: ys.filter((y) => y === null).length,
        cost_imputed: [...outcomes.values()].filter((o) => o.cost_imputed).length, protected_pool: protectedPool(ps).protectedIds.size, difficult_stratum: difficultIds.size,
        distinct_p_hat: new Set(ps.map((p) => p.p)).size,
        cells: evalPart.reduce<Record<string, { n: number; p_hat: number; cost_hat_m: number; y1: number; y0: number; na: number; realised_cost_m: number }>>((a, b) => {
          const p = pMap.get(b.f.id)!; const c = (a[cellOf(b)] ??= { n: 0, p_hat: p.p, cost_hat_m: r4(p.cost), y1: 0, y0: 0, na: 0, realised_cost_m: 0 });
          c.n++; c.realised_cost_m = r4(c.realised_cost_m + outcomes.get(b.f.id)!.cost);
          if (b.y[label] === 1) c.y1++; else if (b.y[label] === 0) c.y0++; else c.na++; return a; }, {}),
        halves: [evalPart.slice(0, Math.floor(evalPart.length / 2)), evalPart.slice(Math.floor(evalPart.length / 2))].map((h) => ({
          n: h.length, y1: h.filter((b) => b.y[label] === 1).length, y0: h.filter((b) => b.y[label] === 0).length, na: h.filter((b) => b.y[label] === null).length })) },
      baseline_A_full: run(ps, 1).A,
      replays: fs_,
      ci_f05: ciMain,
      exploratory_random_order_A_f05: { B: randomOrderM1(ps, outcomes, 0.5, main.B.m1_success_per_m ?? 0), C_share_beaten: randomOrderM1(ps, outcomes, 0.5, main.C.m1_success_per_m ?? 0).share_beaten },
      sensitivity_known_cost_only_f05: { n: knownOnly.length, ...(knownOnly.length ? { ...run(knownOnly, 0.5), ci: bootstrapM1(knownOnly, outcomes, 0.5) } : {}) },
      verdict_B: verdict(labelled, successes, ciMain.b_minus_a),
      verdict_C: verdict(labelled, successes, ciMain.c_minus_a, (main.C.m3_difficult_count_share ?? 0) >= (main.A.m3_difficult_count_share ?? 0)),
    };
  };

  // M7(c): proposals created in the eval window that never ran vs those that ran.
  const ranTasks = new Map(snap.runs.filter((r) => r.created_at >= cutoff).map((r) => [r.task_id, r]));
  const unrun = snap.unexecuted_proposals.filter((p) => p.created_at >= cutoff);
  const mix = (xs: Array<{ k: string }>) => xs.reduce<Record<string, number>>((a, x) => ((a[x.k] = (a[x.k] ?? 0) + 1), a), {});
  const pri = (xs: number[]) => ({ mean: xs.length ? r4(xs.reduce((a, b) => a + b, 0) / xs.length) : null, n: xs.length });
  const ranPri = [...ranTasks.values()].map((r) => Number(r.proposal.priority)).filter(Number.isFinite);
  const unrunPri = unrun.map((p) => Number(p.priority)).filter(Number.isFinite);
  const sd = (xs: number[]) => { const m = xs.reduce((a, b) => a + b, 0) / (xs.length || 1); return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length || 1)); };
  const pooled = Math.sqrt((sd(ranPri) ** 2 + sd(unrunPri) ** 2) / 2);
  const selectionBias = {
    eval_tasks_ran: ranTasks.size, eval_proposals_never_ran: unrun.length,
    never_ran_status: mix(unrun.map((p) => ({ k: p.status }))),
    kind_mix_ran: mix([...ranTasks.values()].map((r) => ({ k: kindOf(r.proposal.first_ref, r.proposal.type) }))),
    kind_mix_never_ran: mix(unrun.map((p) => ({ k: kindOf(p.first_ref, p.type) }))),
    priority_ran: pri(ranPri), priority_never_ran: pri(unrunPri),
    priority_smd_ran_vs_never: pooled > 0 && ranPri.length && unrunPri.length ? r4((pri(ranPri).mean! - pri(unrunPri).mean!) / pooled) : null,
  };

  // §7 diagnostic: species-level propensities from logged bandit posteriors (eval runs). Not used by B/C.
  const props: number[] = [];
  let banditRows = 0; let notReconstructable = 0;
  for (const b of evalPart) {
    if (!b.bandit) continue; banditRows++;
    const arms = b.bandit.posterior; const idx = arms.findIndex((a) => a.species === (b.bandit!.chosen ?? b.species));
    if (arms.length < 2 || idx < 0) { notReconstructable++; continue; }
    props.push(propensities(arms, b.bandit.max_share ?? 0.1, 4000)[idx]);
  }
  props.sort((a, b) => a - b);
  const w = props.map((p) => 0.5 / p); const sw = w.reduce((a, b) => a + b, 0);
  const bandit = { eval_bandit_events: banditRows, reconstructable: props.length, not_reconstructable: notReconstructable,
    propensity_min: props.length ? r4(props[0]) : null, propensity_median: props.length ? r4(props[Math.floor(props.length / 2)]) : null,
    share_below_0_05: props.length ? r4(props.filter((p) => p < 0.05).length / props.length) : null,
    ess_uniform_target: props.length ? +((sw * sw) / w.reduce((a, b) => a + b * b, 0)).toFixed(1) : 0 };

  const attribution = built.reduce<Record<string, number>>((a, b) => ((a[b.attribution] = (a[b.attribution] ?? 0) + 1), a), {});
  return {
    prereg_sha256: EXECUTION_VALUE_PREREG_SHA256, snapshot_at: snap.snapshot_at, excluded: snap.excluded,
    population: { n: N, first: built[0]?.f.created_at, last: built[N - 1]?.f.created_at, cutoff, attribution,
      lanes: [...new Set(built.map((b) => b.f.lane))], cost_known: built.filter((b) => b.cost !== null).length,
      total_cost_m: r4(built.reduce((a, b) => a + (b.cost ?? 0), 0)) },
    identifiability: {
      task_selection: 'BLOCKED_CAUSAL_IDENTIFICATION',
      reason: 'task choice was deterministic (priority DESC + approvals + lane caps); no logged propensity; B/C are a restricted replay over executed runs only (assumes no interference and order invariance)',
      species_bandit: bandit,
      effort_decision: 'shadow, acted on nothing: no counterfactual',
    },
    selection_bias: selectionBias,
    y_merge: perLabel('y_merge'),
    y_oracle: perLabel('y_oracle'),
    deviations: ['D1: deterministic check exit_status null is a skipped check (loop-service.ts "script not present") and is ignored; prereg §3 did not say how null counts'],
  };
}

const isMain = require.main === module;
if (isMain) {
  const here = __dirname;
  const prereg = path.resolve(here, '../../../../docs/research/di-001/EXECUTION_VALUE_PREREG.md');
  const sha = createHash('sha256').update(fs.readFileSync(prereg)).digest('hex');
  if (sha !== EXECUTION_VALUE_PREREG_SHA256) { console.error(`prereg sha256 mismatch: ${sha}`); process.exit(2); }
  const snap = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) as Snapshot;
  const out = JSON.stringify(analyse(snap), null, 2);
  if (process.argv[3]) fs.writeFileSync(process.argv[3], out);
  process.stdout.write(out + '\n');
}
