import type { ReactNode } from 'react';
import type { EvolutionEvidence } from '../lib/api';

/**
 * L6-04: the registered experiments (services/experiment-registry.ts) in one read-only table, each with a disclosure that shows
 * its own evidence section and its learning-ledger rows. Rules: null / insufficient / interim stay visible as such (never 0),
 * only a recorded verdict closes an experiment (reaching the target is not a result), and each evidence section states the
 * window it counts over — the registry row counts from started_at, most sections only over the evidence window.
 */
type Data = Partial<EvolutionEvidence>;
type Exp = NonNullable<EvolutionEvidence['experiments']>['experiments'][number];
type LedgerRow = NonNullable<EvolutionEvidence['learning_ledger']>['mechanisms'][number];
type Ci = [number, number] | null | undefined;

const DAY = 86_400_000;
const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : 'none registered');
const fx = (v: number | null | undefined, d = 3) => (v === null || v === undefined ? null : v.toFixed(d));
const est = (v: number | null | undefined) => (fx(v) === null ? 'estimate not computed' : `estimate ${fx(v)}`);
const ciText = (c: Ci) => (c ? `CI [${fx(c[0])}, ${fx(c[1])}]` : 'no CI computed');
const pText = (p: number | null | undefined) => (p === null || p === undefined ? 'p not computed' : `p ${p.toPrecision(3)}`);
const rate = (v: number | null | undefined) => (v === null || v === undefined ? 'unknown' : `${Math.round(v * 100)} %`);
/** arm keys sorted as text: '00'…'11' would otherwise put the integer-like '10', '11' first */
const sorted = <T,>(o: Record<string, T>) => Object.entries(o).sort(([a], [b]) => a.localeCompare(b));
const arms = (n: Record<string, number> | null) => (n ? sorted(n).map(([a, k]) => `${a} ${k}`).join(' · ') : 'n unknown');

/** which evidence section belongs to which experiment, and how that section is windowed (evolution-evidence.ts) */
const SECTION: Record<string, { key: keyof EvolutionEvidence; window: 'window' | 'analysis_since' | 'whole' }> = {
  'ACE-001': { key: 'ace_001', window: 'analysis_since' }, 'STE-001': { key: 'ste_001', window: 'window' },
  'MAKER-DEPS-001': { key: 'maker_deps_001', window: 'window' }, X1: { key: 'effort_x1', window: 'window' }, F2: { key: 'checker_family', window: 'window' },
  'memory-holdout': { key: 'memory_holdout', window: 'window' }, 'TG-001': { key: 'tg_001', window: 'whole' }, 'PL-001': { key: 'pl_001', window: 'whole' }, 'D5-NO': { key: 'd5_no', window: 'whole' },
  'JEV-114': { key: 'jev_challenger', window: 'whole' },
};

/** the protocol version the experiment's own section reports; null = none reported */
function version(e: Exp, d: Data): string | null {
  switch (e.id) {
    case 'MAKER-DEPS-001': return d.maker_deps_001?.version ?? null;
    case 'F2': return d.checker_family?.version ?? null;
    case 'TG-001': return d.tg_001?.generation ?? d.tg_001?.experiment_id ?? null;
    case 'PL-001': return d.pl_001?.manifest ? `manifest ${d.pl_001.manifest.sha256.slice(0, 12)}` : d.pl_001 ? `prereg ${d.pl_001.prereg_sha256.slice(0, 12)}` : null;
    case 'D5-NO': return d.d5_no?.prereg_sha256 ? `prereg ${d.d5_no.prereg_sha256.slice(0, 12)}` : null;
    case 'STE-001': return d.ste_001?.ste_template_hash ? `template ${d.ste_001.ste_template_hash.slice(0, 12)}` : null;
    default: return null;
  }
}

/** the section's own state (collecting / analysable / complete …), never a verdict */
function sectionState(e: Exp, d: Data): string | null {
  switch (e.id) {
    case 'ACE-001': return d.ace_001?.status ?? null;
    case 'STE-001': return d.ste_001?.status ?? null;
    case 'MAKER-DEPS-001': return d.maker_deps_001?.status ?? null;
    case 'F2': return d.checker_family?.stop.verdict ?? null;
    case 'TG-001': return d.tg_001?.status ?? null;
    case 'PL-001': return d.pl_001?.status ?? null;
    case 'D5-NO': return d.d5_no?.status ?? null;
    case 'JEV-114': return d.jev_challenger?.status ?? null;
    default: return null;
  }
}

function state(e: Exp, d: Data): string {
  if (e.error) return 'evidence unreadable';
  if (e.verdict !== null) return `closed — verdict ${e.verdict}`;
  // TG-001: an INCONCLUSIVE 20-task result extends once under the stopping rule, so the registry keeps the verdict null
  const interim = e.id === 'TG-001' && d.tg_001?.result?.verdict ? `; interim result ${d.tg_001.result.verdict} — not a closing verdict` : '';
  return `${e.overdue ? 'overdue' : 'running'}${interim}`;
}

function wip(e: Exp, d: Data): string {
  if (e.population !== 'oracle_goals') return `not on the oracle-goal population (${e.population})`;
  if (e.approved_over_limit) return `grandfathered: ${e.approved_over_limit}`;
  return `counts toward WIP limit ${d.experiments?.wip.limit ?? '—'}`;
}

function windowText(e: Exp, d: Data): string {
  const s = SECTION[e.id];
  if (!s) return 'no evidence section for this experiment';
  if (s.window === 'whole') return 'section is not windowed (whole experiment)';
  if (!d.at || !d.window_days) return 'section window unknown';
  const from = new Date(Date.parse(d.at) - d.window_days * DAY).toISOString();
  if (s.window === 'analysis_since' && d.ace_001?.analysis_since && d.ace_001.analysis_since >= from) {
    return `section counts from analysis_since ${day(d.ace_001.analysis_since)} (Amendment 1); ${d.ace_001.delivery_invalid ?? 'unknown'} earlier outcomes excluded`;
  }
  return from <= e.started_at ? `section window (${d.window_days} d) covers the whole experiment`
    : `section counts the last ${d.window_days} d only (from ${day(from)}); the registry row counts from ${day(e.started_at)}`;
}

const Line = ({ children }: { children: ReactNode }) => <li>{children}</li>;

/** the experiment's own evidence section, only fields that section reports */
function SectionEvidence({ e, d }: { e: Exp; d: Data }) {
  const lines: ReactNode[] = [];
  const st = sectionState(e, d);
  if (st === 'analysable' && e.verdict === null) lines.push('evidence status analysable — target reached, no analysis verdict recorded');
  else if (st) lines.push(`evidence status ${st}`);
  if (e.id === 'ACE-001' && d.ace_001) {
    const a = d.ace_001;
    if (a.delivery) lines.push(`retrieval delivery ${rate(a.delivery.retrieval_rate)}, examples delivery ${rate(a.delivery.examples_rate)}; fallbacks ${JSON.stringify(a.delivery.fallback_reasons)}`);
    for (const [k, v] of sorted(a.arms)) lines.push(`arm ${k}: n = ${v.n}, verified rate ${rate(v.verified_rate)} ${v.ci ? ciText(v.ci) : ''}`.trim());
    lines.push(`main effects (interim, descriptive): retrieval ${est(a.main_effects.retrieval.diff)}, examples ${est(a.main_effects.examples.diff)}`);
  }
  if (e.id === 'STE-001' && d.ste_001) {
    for (const [k, v] of Object.entries(d.ste_001.arms)) lines.push(`arm ${k}: n = ${v.n}, verified rate ${rate(v.verified_rate)}, out of scope ${v.out_of_scope}`);
    lines.push(`difference (interim, descriptive): ${est(d.ste_001.diff)}`);
  }
  if (e.id === 'MAKER-DEPS-001' && d.maker_deps_001) {
    const m = d.maker_deps_001;
    for (const [k, v] of Object.entries(m.arms)) lines.push(`arm ${k}: ${v.goals} goals, ${v.terminal} terminal (${v.censored} censored), ${v.verified} verified / ${v.regressed} regressed, verified rate ${rate(v.verified_rate)}; ${v.preparation_failed} preparation failures`);
    lines.push(`ITT B − A (descriptive): ${est(m.diff)}, ${ciText(m.diff_ci_descriptive)}`);
  }
  if (e.id === 'X1' && d.effort_x1) {
    const x = d.effort_x1;
    for (const [k, v] of [['on', x.on], ['off', x.off]] as const) lines.push(`arm ${k}: ${v.goals} goals, ${v.verified} verified / ${v.regressed} regressed, ${v.infra} with an infra-failed outcome; verified rate over settled ${rate(v.verified_rate)}`);
    lines.push(`Fisher exact ${pText(x.fisher_p)}; no effect size computed`);
  }
  if (e.id === 'memory-holdout' && d.memory_holdout) {
    const m = d.memory_holdout;
    for (const [k, v] of [['rules', m.rules], ['holdout', m.holdout]] as const) lines.push(`arm ${k}: n = ${v.n}, ${v.verified} verified / ${v.regressed} regressed, verified rate ${rate(v.verified_rate)}`);
    lines.push(`Fisher exact ${pText(m.fisher_p)}; no effect size computed`);
  }
  if (e.id === 'F2' && d.checker_family) {
    const c = d.checker_family;
    lines.push(`primary (${c.primary.endpoint}, ${c.primary.read}): Δkappa ${est(c.primary.delta_kappa)}, ${ciText(c.primary.delta_kappa_ci)}, ${pText(c.primary.fisher_p)}, n same ${c.primary.n.same} / cross ${c.primary.n.cross}`);
    lines.push(`secondary, circular — contains the checker's own rejection: Δkappa ${est(c.secondary_circular.delta_kappa)}, ${ciText(c.secondary_circular.delta_kappa_ci)}`);
    for (const [v, x] of Object.entries(c.versions ?? {})) if (x.closed) lines.push(`${v} (${x.label}) reported apart, never pooled`);
  }
  if (e.id === 'TG-001' && d.tg_001) {
    const t = d.tg_001;
    if (t.reason) lines.push(`reason: ${t.reason}`);
    lines.push(`${t.tasks} frozen tasks, ${t.skipped ?? 0} skipped`);
    for (const a of t.arms ?? []) lines.push(`arm ${a.arm} (${a.name}): n = ${a.n}, ${a.success} success, rate ${rate(a.rate)} ${a.ci95 ? ciText(a.ci95) : ''}; ${a.pending} pending, ${a.invalid} invalid, ${a.infra_censored ?? 0} infra-censored`);
    for (const p of t.paired ?? []) lines.push(`${p.arms}: n pairs ${p.n_pairs}, effect ${fx(p.effect) ?? 'not computed'}, ${ciText(p.ci95)}, McNemar ${pText(p.mcnemar_exact_p)}${p.excluded_tasks ? `, ${p.excluded_tasks} excluded` : ''}`);
    if (t.prior_exposure) lines.push(`prior exposure: ${t.prior_exposure.exposed} exposed, ${t.prior_exposure.unexposed} unexposed`);
    for (const g of t.prior_generations ?? []) lines.push(`${g.generation} ${g.status} — never pooled`);
  }
  if (e.id === 'PL-001' && d.pl_001) {
    const p = d.pl_001;
    lines.push(`pairs ${p.pairs ? `${p.pairs.done} of ${p.pairs.target}` : 'unknown (not frozen)'}; verdict ${p.verdict ?? 'none yet'}; procedure ${p.procedure.status ?? 'unknown'} — the PL-001 card below has the arms and runs`);
  }
  if (e.id === 'D5-NO' && d.d5_no?.confident_no) {
    const n = d.d5_no.confident_no;
    lines.push(`confident NO: ${n.analysis_n_reached} of analysis n ${d.d5_no.analysis_n ?? 'unknown'}, ${n.analysis_errors} errors, upper 95 % ${fx(n.analysis_upper_95) ?? 'not computed'}; ${n.pending} pending, ${n.censored} censored`);
    if (d.d5_no.excluded) lines.push(`excluded: ${d.d5_no.excluded.pre_cutoff_cluster} pre-cutoff cluster, ${d.d5_no.excluded.oracle_lane} oracle lane`);
  }
  if (e.id === 'JEV-114' && d.jev_challenger) {
    for (const j of d.jev_challenger.by_judgment) lines.push(`${j.judgment}: ${j.n_pairs} pairs, agreement ${j.agreement.status === 'ok' ? rate(j.agreement.rate) : 'insufficient'}`);
  }
  return <ul className="list-disc pl-5">{lines.map((l, i) => <Line key={i}>{l}</Line>)}</ul>;
}

const ledgerLine = (m: LedgerRow) => `${m.name} (${m.mechanism}): ${m.status} — ${est(m.estimate)}, ${ciText(m.ci)}${m.p === null ? '' : `, ${pText(m.p)}`}${m.metric ? ` · ${m.metric}` : ''}`;

export function ExperimentsSection({ data }: { data: EvolutionEvidence }) {
  const d = data as Data;
  const reg = d.experiments;
  const ledger = d.learning_ledger;
  if (!reg) return <p className="text-sm text-foreground-secondary">Experiment registry not reported by this server.</p>;
  const w = reg.wip;
  const head = ['Experiment', 'Protocol', 'Status', 'Since', 'n per arm / target', 'Stop by', 'Overdue', 'Decision', 'WIP'];
  return (
    <div className="space-y-2 text-sm">
      <p className="text-foreground-secondary">
        WIP: {w.active_count} active on oracle goals (limit {w.limit}): {w.counted.length} counted, {w.approved_over_limit.length} grandfathered exception(s) — guard {w.guard_ok ? 'ok' : 'not ok'}.
        {' '}n counts from each experiment&apos;s start; interim figures are descriptive. Only a recorded verdict closes an experiment.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead><tr className="text-left text-foreground-tertiary">{head.map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
          <tbody>
            {reg.experiments.map((e) => {
              const v = version(e, d);
              const rows = ledger?.mechanisms.filter((m) => m.experiment === e.id) ?? [];
              return [
                <tr key={e.id} data-experiment={e.id} className="border-t border-border align-top">
                  <td className="font-medium">{e.id}</td>
                  <td>{e.protocol}{v ? ` · version ${v}` : ' · version not reported'}</td>
                  <td>{state(e, d)}</td>
                  <td>{day(e.started_at)}</td>
                  <td>{arms(e.n_per_arm)} / target {e.target_n ?? 'none registered'}</td>
                  <td>{day(e.stop_by)}{e.power.days_to_stop !== null ? ` (${e.power.days_to_stop} d)` : ''}</td>
                  <td className={e.overdue ? 'text-status-error' : undefined}>{e.overdue ? `overdue: ${e.overdue_reason ?? 'no reason recorded'}` : 'no'}</td>
                  <td>{e.verdict ?? 'no verdict recorded'}</td>
                  <td>{wip(e, d)}</td>
                </tr>,
                <tr key={`${e.id}-detail`} data-experiment-detail={e.id}>
                  <td colSpan={head.length}>
                    <details>
                      <summary className="cursor-pointer text-foreground-secondary">{e.id} evidence</summary>
                      <div className="space-y-1 py-2">
                        <p>{windowText(e, d)}</p>
                        <p>Stop rule: {e.stop_note} ({e.stop_source}). Projected smallest arm at stop_by: {e.power.projected_min_arm_n ?? 'unknown'}.</p>
                        {e.error && <p className="text-status-error">evidence unreadable: {e.error}</p>}
                        {Object.entries(e.effects ?? {}).map(([k, f]) => <p key={k}>Effect {k}: {f.metric} — {est(f.estimate)}, {ciText(f.ci)}, {pText(f.p)}</p>)}
                        {SECTION[e.id] && d[SECTION[e.id].key] ? <SectionEvidence e={e} d={d} /> : <p>No evidence section for {e.id} in this snapshot.</p>}
                        {rows.length > 0 && <ul className="list-disc pl-5">{rows.map((m) => <li key={m.mechanism}>{ledgerLine(m)}</li>)}</ul>}
                      </div>
                    </details>
                  </td>
                </tr>,
              ];
            })}
          </tbody>
        </table>
      </div>
      {ledger && (
        <details>
          <summary className="cursor-pointer text-foreground-secondary">Learning ledger — {ledger.loops_closed.headline}</summary>
          <ul className="list-disc pl-5 py-2">{ledger.mechanisms.map((m) => <li key={m.mechanism}>{ledgerLine(m)}{m.experiment ? '' : ` · ${m.note}`}</li>)}</ul>
        </details>
      )}
    </div>
  );
}
