import type { Database } from 'better-sqlite3';
import type { ExperimentEffect, ExperimentRow } from './experiment-registry';
import type { OpeResult } from './bandit-propensity';
import { BASELINE_GENOME } from './genome-registry';

/**
 * G3.5 learning ledger (Phase G, operator 2026-10-19), read-only: per learning mechanism its data source, the effect estimate and
 * 95 % CI that an existing evidence function already computes (via the experiment registry, counted from the experiment's
 * start), a status, and the headline 'loops closed k/N' (closed = ADOPTED with a CI that excludes 0). No new statistic is
 * computed here: where no evidence function estimates an effect, the mechanism is NOT_MEASURED and estimate/ci stay null.
 *
 * Status: an experiment without a verdict is RUNNING; verdict supported → ADOPTED, falsified / reversed → REJECTED, any other
 * verdict (inconclusive, insufficient) → INSUFFICIENT. Genomes have no experiment: an active non-baseline genome → ADOPTED (its
 * trials record McNemar p per trial, no pooled effect), a genome in trial → RUNNING, otherwise INSUFFICIENT.
 */
export type LearningStatus = 'ADOPTED' | 'REJECTED' | 'RUNNING' | 'INSUFFICIENT' | 'NOT_MEASURED';
export interface LedgerRow {
  mechanism: string; name: string; data_source: string; experiment: string | null;
  metric: string | null; estimate: number | null; ci: [number, number] | null; p: number | null;
  status: LearningStatus; closed: boolean; note: string;
}

const MECHANISMS: Array<{ mechanism: string; name: string; data_source: string; experiment?: string }> = [
  { mechanism: 'species_selection', name: 'Species selection (bandit)', data_source: "loop_events 'bandit_selected' (LOOP_BANDIT_ENABLED); evolution-evidence ope" },
  { mechanism: 'effort_siblings', name: 'Evolve siblings (effort)', data_source: 'goals.metadata.effort_arm × proposal status (effortX1Evidence)', experiment: 'X1' },
  { mechanism: 'genomes', name: 'Maker genomes (dream evolution)', data_source: 'maker_genomes + genome_trial_results' },
  { mechanism: 'memory_rules', name: 'Memory rules', data_source: "loop_events 'assignment_context' memory_holdout × proposal status (memoryHoldoutEvidence)", experiment: 'memory-holdout' },
  { mechanism: 'kb_retrieval', name: 'KB retrieval', data_source: "skill_outcomes 'ace-001-arm' R factor (ace001Evidence)", experiment: 'ACE-001' },
  { mechanism: 'example_selection', name: 'Similar-example selection', data_source: "skill_outcomes 'ace-001-arm' S factor (ace001Evidence)", experiment: 'ACE-001' },
  { mechanism: 'skill_selection', name: 'Skill selection', data_source: 'skill_outcomes per skill; skill_cards (SKILL_DISTILLATION_MODE, shadow, never injected)' },
  { mechanism: 'maker_template', name: 'Maker template (STE)', data_source: "skill_outcomes 'ste-001-arm' (ste001Evidence)", experiment: 'STE-001' },
  { mechanism: 'deps_prep', name: 'Maker dependency preparation', data_source: "loop_events 'maker_deps_arm' × proposal status (makerDeps001Evidence)", experiment: 'MAKER-DEPS-001' },
  { mechanism: 'requeue', name: 'Requeue', data_source: "self_improvements evidence ref 'requeue-of:' + 'requeue' judgments (improvement-requeue.ts)" },
  { mechanism: 'checker_family', name: 'Checker family', data_source: 'checker leases checker_family_arm × outcome labels (checkerFamilyEvidence)', experiment: 'F2' },
];

const excludesZero = (ci: [number, number] | null) => ci !== null && (ci[0] > 0 || ci[1] < 0);
const fromVerdict = (v: string | null): LearningStatus => (v === null ? 'RUNNING' : v === 'supported' ? 'ADOPTED' : v === 'falsified' || v === 'reversed' ? 'REJECTED' : 'INSUFFICIENT');

export function learningLedger(db: Database, experiments: ExperimentRow[], ope: OpeResult | null) {
  const rows: LedgerRow[] = MECHANISMS.map((m) => {
    const base = { ...m, experiment: m.experiment ?? null, metric: null, estimate: null, ci: null, p: null };
    if (m.experiment) {
      const e = experiments.find((x) => x.id === m.experiment);
      if (!e) return { ...base, status: 'NOT_MEASURED' as const, closed: false, note: `experiment ${m.experiment} is not in the registry` };
      const eff: ExperimentEffect | undefined = e.effects?.[m.mechanism];
      const status = fromVerdict(e.verdict);
      const ci = eff?.ci ?? null;
      return { ...base, metric: eff?.metric ?? null, estimate: eff?.estimate ?? null, ci, p: eff?.p ?? null, status, closed: status === 'ADOPTED' && excludesZero(ci),
        note: e.error ? `evidence unreadable: ${e.error}` : `${m.experiment}: n per arm ${JSON.stringify(e.n_per_arm)} of target ${e.target_n}, stop_by ${e.stop_by?.slice(0, 10) ?? 'none'}${e.verdict ? `, verdict ${e.verdict}` : ''}` };
    }
    if (m.mechanism === 'genomes') {
      type G = { active: number; trial: number; decided: number };
      let g = null as G | null;
      try {
        g = db.prepare(`SELECT COALESCE(SUM(status = 'active' AND id <> ?), 0) AS active, COALESCE(SUM(status = 'trial'), 0) AS trial,
          (SELECT COUNT(*) FROM genome_trial_results WHERE state NOT IN ('e_only', 'graded_only')) AS decided FROM maker_genomes`).get(BASELINE_GENOME) as G;
      } catch { /* tables absent: unknown */ }
      if (!g) return { ...base, status: 'INSUFFICIENT' as const, closed: false, note: 'maker_genomes / genome_trial_results unreadable' };
      const status: LearningStatus = g.active > 0 ? 'ADOPTED' : g.trial > 0 ? 'RUNNING' : 'INSUFFICIENT';
      return { ...base, metric: 'per-trial McNemar p only (no pooled effect computed)', status, closed: false,
        note: `${g.active} promoted non-baseline genome(s), ${g.trial} in trial, ${g.decided} trial diagnostics recorded` };
    }
    if (m.mechanism === 'species_selection') {
      return { ...base, status: 'NOT_MEASURED' as const, closed: false,
        note: `no estimate of the bandit vs no bandit. Related: off-policy value of the fitness-view policy − the logged bandit = ${ope ? `${ope.difference ?? 'null'} (95 % CI ${ope.ci ? `[${ope.ci.join(', ')}]` : 'null'}, ESS ${ope.ess}, ${ope.status})` : 'unknown'} — a different policy, not this mechanism's effect` };
    }
    return { ...base, status: 'NOT_MEASURED' as const, closed: false, note: 'no evidence function estimates this mechanism\'s effect on outcomes' };
  });
  const closed = rows.filter((r) => r.closed).length;
  return { loops_closed: { k: closed, n: rows.length, headline: `loops closed ${closed}/${rows.length}` },
    by_status: Object.fromEntries((['ADOPTED', 'REJECTED', 'RUNNING', 'INSUFFICIENT', 'NOT_MEASURED'] as const).map((s) => [s, rows.filter((r) => r.status === s).length])) as Record<LearningStatus, number>,
    mechanisms: rows,
    note: 'Read-only. Effects come from the experiments\' own evidence functions counted from started_at (interim reads are descriptive); null = not computed there, never 0. closed = ADOPTED with a 95 % CI excluding 0.' };
}
