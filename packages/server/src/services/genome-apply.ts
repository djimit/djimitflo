import fs from 'fs';
import { createHash, randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { aceLane, type AceLane } from './ace-001';
import { LoopEventService } from './loop-event-service';
import { wilson } from './evolution-estimators';
import { BASELINE_GENOME, genomeDelivery, makerSpeciesKey, strategyGenomeFor, type Genome } from './genome-registry';
import { notFallbackOutcomeSql } from './ollama-outage-fallback';
import { nonMakerRunSql } from './outcome-attribution';
import { UNFAIR_ZERO_SQL } from './runtime-bandit';
import { realRunIdSql } from './synthetic-runs';

/**
 * GENOME_APPLY_MODE=on (fitness-contract audit, PR #1188): gym genomes were the only selection loop with a sound promotion
 * rule (paired trial on a frozen holdout, gated parent evidence, promoteGenome), but no promoted genome ever reached a
 * production maker — shadow only logged what it would inject. `on` injects, narrowly:
 *   - only an 'active' genome that promoteGenome made active through evaluateTrials: its genome_trial_results row carries the
 *     gate policy and the gated evidence the decision rested on (Gate A / P0). Never a candidate, trial or the baseline.
 *   - only maker leases of the species it was trialled on (gym.species of its gym runs, and strategyGenomeFor's species) and
 *     only on oracle test lanes (test-gap, exports, mutation: aceLane). Never a gym run (TG/PL/CV/evolution-gym).
 *   - a permanent holdout: sha256('genome-apply:' + goal id) < 10 % → no genome lines; the arm is stored on the lease.
 *   - a delivery receipt on the lease: genome id, lines sha256 and the sha256 of the LOOP_WORK.md the maker runs on (the gym
 *     fire check applied to the assignment, genomeDelivery).
 *   - auto-retire, never promote: ≥ 20 settled maker-clean outcomes delivered and a Wilson upper bound below the holdout's rate.
 * off (default) and shadow are unchanged.
 */
export type GenomeApplyMode = 'off' | 'shadow' | 'on';
export const genomeApplyMode = (env: NodeJS.ProcessEnv = process.env): GenomeApplyMode =>
  env.GENOME_APPLY_MODE === 'on' ? 'on' : env.GENOME_APPLY_MODE === 'shadow' ? 'shadow' : 'off';
export const GENOME_APPLY_HOLDOUT_RATE = 0.1;
/** settled delivered outcomes before the retire rule may act */
export const GENOME_APPLY_RETIRE_MIN_N = 20;
/** holdout outcomes before the holdout rate means anything; fewer = insufficient (never retire on a 1-sample holdout) */
export const GENOME_APPLY_HOLDOUT_MIN_N = 5;
const GYM_LOOPS = new Set(['evolution-gym', 'tg-001', 'pl-001']);
const isGymLoop = (loop: string) => GYM_LOOPS.has(loop) || /^cv-/.test(loop);

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export type GenomeApplyArm = 'treatment' | 'holdout';
export function genomeApplyArm(goalId: string): GenomeApplyArm {
  return parseInt(sha256(`genome-apply:${goalId}`).slice(0, 8), 16) / 0x1_0000_0000 < GENOME_APPLY_HOLDOUT_RATE ? 'holdout' : 'treatment';
}
export const genomeLinesSha256 = (lines: string[]): string => sha256(lines.join('\n'));

/** Why `g` is not a genome the promotion rule promoted (null = it is). */
export function notPromotedReason(db: Database, g: Genome): string | null {
  if (g.id === BASELINE_GENOME || !g.lines.length) return 'no strategy lines (baseline)';
  if (g.status !== 'active') return `status ${g.status}`;
  try {
    const row = db.prepare(`SELECT 1 FROM genome_trial_results WHERE trial_id = ? AND gate_policy IS NOT NULL AND evidence_json IS NOT NULL
      AND state <> 'hold_ineligible' LIMIT 1`).get(g.id);
    return row ? null : 'no gated promotion record (genome_trial_results with gate_policy + evidence_json)';
  } catch { return 'promotion record unreadable'; }
}

/** The gym species a genome was trialled on (its evolution-gym runs). */
export function trialledSpecies(db: Database, genomeId: string): string[] {
  try {
    return (db.prepare(`SELECT DISTINCT json_extract(metadata, '$.gym.species') AS s FROM loop_runs WHERE loop_name = 'evolution-gym'
      AND json_extract(metadata, '$.gym.genome') = ?`).all(genomeId) as Array<{ s: string | null }>).map((r) => r.s).filter((s): s is string => Boolean(s));
  } catch { return []; }
}

export interface GenomeApplyPlan { arm: GenomeApplyArm; genome: Genome; lines_sha256: string; lane: AceLane; species: string }
export function planGenomeApply(db: Database, input: { goalId: string | null; loopName: string; runtime: string; model: string | null; runMetadata?: Record<string, unknown> },
  env: NodeJS.ProcessEnv = process.env): { plan: GenomeApplyPlan | null; reason: string; genome_id?: string } {
  if (genomeApplyMode(env) !== 'on') return { plan: null, reason: 'off' };
  if (isGymLoop(input.loopName) || input.runMetadata?.gym !== undefined) return { plan: null, reason: 'gym run' };
  const lane = aceLane(db, input.goalId);
  if (!lane || !input.goalId) return { plan: null, reason: 'not an oracle-lane goal' };
  const g = strategyGenomeFor(db, input.runtime, input.model, env);
  if (!g || g.id === BASELINE_GENOME) return { plan: null, reason: 'no active strategy genome for this species' };
  const why = notPromotedReason(db, g);
  if (why) return { plan: null, reason: `genome ${g.id} not applied: ${why}`, genome_id: g.id };
  const species = makerSpeciesKey(input.runtime, input.model);
  if (!trialledSpecies(db, g.id).includes(species)) return { plan: null, reason: `genome ${g.id} not applied: never trialled on ${species}`, genome_id: g.id };
  return { plan: { arm: genomeApplyArm(input.goalId), genome: g, lines_sha256: genomeLinesSha256(g.lines), lane: lane.lane, species }, reason: 'planned' };
}

export interface GenomeApplyReceipt { mode: 'on'; arm: GenomeApplyArm; genome_id: string; lines: number; lines_sha256: string; delivered: boolean;
  genome_lines_found: number; assignment_sha256: string | null; lane: AceLane; species: string; at: string; reason?: string }

/**
 * Applies the plan to one maker lease: the treatment arm gets the genome's lines appended to its LOOP_WORK.md (once: a line
 * already in the text is not added again), the holdout arm gets nothing; both record the receipt on the lease as
 * `genome_apply` and a `genome_apply` loop event. Returns null when nothing qualifies (off, shadow, not oracle, gym, …).
 */
export function applyGenomeToLease(db: Database, input: { runId: string; goalId: string | null; loopName: string; leaseId: string },
  env: NodeJS.ProcessEnv = process.env, now = new Date()): GenomeApplyReceipt | null {
  if (genomeApplyMode(env) !== 'on') return null;
  const lease = db.prepare('SELECT runtime, metadata FROM worker_leases WHERE id = ?').get(input.leaseId) as { runtime: string; metadata: string | null } | undefined;
  if (!lease) return null;
  const meta = parse(lease.metadata);
  let runMetadata: Record<string, unknown> = {};
  try { runMetadata = parse((db.prepare('SELECT metadata FROM loop_runs WHERE id = ?').get(input.runId) as { metadata: string | null } | undefined)?.metadata); } catch { /* no run row */ }
  const { plan, reason, genome_id } = planGenomeApply(db, { goalId: input.goalId, loopName: input.loopName, runtime: lease.runtime,
    model: typeof meta.model === 'string' ? meta.model : null, runMetadata }, env);
  if (!plan) {
    if (genome_id) record(db, input.runId, 'genome_apply_skipped', reason, { genome_id, maker_lease_id: input.leaseId });
    return null;
  }
  const file = typeof meta.assignment_file === 'string' ? meta.assignment_file : null;
  let text: string | null = null;
  try { text = file ? fs.readFileSync(file, 'utf8') : null; } catch { text = null; }
  const g = plan.genome;
  const base = { mode: 'on' as const, arm: plan.arm, genome_id: g.id, lines: g.lines.length, lines_sha256: plan.lines_sha256, lane: plan.lane, species: plan.species, at: now.toISOString() };
  let receipt: GenomeApplyReceipt;
  if (plan.arm === 'holdout') {
    receipt = { ...base, delivered: false, genome_lines_found: 0, assignment_sha256: text === null ? null : sha256(text) };
  } else if (text === null || !file) {
    receipt = { ...base, delivered: false, genome_lines_found: 0, assignment_sha256: null, reason: 'assignment file unreadable' };
  } else {
    const missing = g.lines.filter((l) => l.trim() && !text!.includes(l.trim()));
    if (missing.length) {
      text = `${text.trimEnd()}\n\n## Strategy (promoted genome ${g.id}, lines sha256:${plan.lines_sha256.slice(0, 12)})\n\n${missing.map((l) => `- ${l.trim()}`).join('\n')}\n`;
      fs.writeFileSync(file, text, 'utf8');
    }
    const d = genomeDelivery(db, g, text);
    receipt = { ...base, delivered: d.delivered, genome_lines_found: d.genome_lines_found, assignment_sha256: d.goal_sha256, ...(d.reason ? { reason: d.reason } : {}) };
  }
  db.prepare("UPDATE worker_leases SET metadata = json_set(COALESCE(NULLIF(metadata, ''), '{}'), '$.genome_apply', json(?)) WHERE id = ?").run(JSON.stringify(receipt), input.leaseId);
  record(db, input.runId, 'genome_apply', `Genome ${g.id} ${plan.arm === 'holdout' ? 'withheld (holdout arm)' : receipt.delivered ? `applied: ${g.lines.length} line(s)` : `not delivered: ${receipt.reason}`}`,
    { ...receipt, maker_lease_id: input.leaseId });
  return receipt;
}

/** The outcome ref of a lease's receipt: `genome-apply:<treatment|holdout|undelivered>:<genome id>` (none without a receipt). */
export function genomeApplyRefs(meta: { genome_apply?: unknown }): string[] {
  const r = meta.genome_apply && typeof meta.genome_apply === 'object' ? meta.genome_apply as Partial<GenomeApplyReceipt> : null;
  if (!r || typeof r.genome_id !== 'string') return [];
  return [`genome-apply:${r.arm === 'holdout' ? 'holdout' : r.delivered ? 'treatment' : 'undelivered'}:${r.genome_id}`];
}

export interface ArmStats { n: number; verified: number; rate: number | null; ci: [number, number] | null }
const arm = (n: number, verified: number): ArmStats => ({ n, verified, rate: n ? +(verified / n).toFixed(3) : null, ci: n ? wilson(verified, n) : null });

/**
 * Settled real production maker outcomes per genome and arm, maker-clean as the bandit counts them (runtime-bandit.ts): a zero
 * attributed to a reviewer or the environment, an infra / no-change zero and an outcome of a fallback runtime are left out;
 * gym, synthetic and extra-repo outcomes never count. null = skill_outcomes unreadable.
 */
export function genomeApplyStats(db: Database, env: NodeJS.ProcessEnv = process.env): Map<string, { treatment: ArmStats; holdout: ArmStats; undelivered: number }> | null {
  let rows: Array<{ success: number; refs: string | null }>;
  try {
    rows = db.prepare(`SELECT success, evidence_refs_json AS refs FROM skill_outcomes WHERE skill_id LIKE 'loop-maker:%' AND skill_id NOT LIKE 'loop-maker:gym:%'
      AND evidence_refs_json LIKE '%"genome-apply:%' AND ${notFallbackOutcomeSql('skill_outcomes')} AND ${realRunIdSql('skill_outcomes.task_id')}
      AND NOT (success = 0 AND ${nonMakerRunSql('skill_outcomes.task_id', env)}) AND NOT (success = 0 AND ${UNFAIR_ZERO_SQL})`).all() as typeof rows;
  } catch { return null; }
  const acc = new Map<string, { t: [number, number]; h: [number, number]; u: number }>();
  for (const r of rows) {
    let refs: unknown[] = []; try { refs = JSON.parse(r.refs || '[]') as unknown[]; } catch { /* malformed: skipped */ }
    for (const ref of refs) {
      const m = typeof ref === 'string' ? /^genome-apply:(treatment|holdout|undelivered):(.+)$/.exec(ref) : null;
      if (!m) continue;
      const a = acc.get(m[2]) ?? { t: [0, 0], h: [0, 0], u: 0 };
      if (m[1] === 'treatment') a.t = [a.t[0] + 1, a.t[1] + (r.success ? 1 : 0)];
      else if (m[1] === 'holdout') a.h = [a.h[0] + 1, a.h[1] + (r.success ? 1 : 0)];
      else a.u++;
      acc.set(m[2], a);
    }
  }
  return new Map([...acc].map(([id, a]) => [id, { treatment: arm(a.t[0], a.t[1]), holdout: arm(a.h[0], a.h[1]), undelivered: a.u }]));
}

/**
 * The retire rule: retire when the delivered arm has ≥ GENOME_APPLY_RETIRE_MIN_N outcomes, the holdout ≥ GENOME_APPLY_HOLDOUT_MIN_N,
 * and the holdout's verified rate lies above the delivered arm's Wilson 95 % upper bound (the delivered rate is below the
 * holdout's by more than its CI). Anything less is 'insufficient'; a gap inside the CI is 'keep'.
 */
export function retireDecision(t: ArmStats, h: ArmStats): { decision: 'retire' | 'keep' | 'insufficient'; reason: string } {
  if (t.n < GENOME_APPLY_RETIRE_MIN_N) return { decision: 'insufficient', reason: `${t.n} of ${GENOME_APPLY_RETIRE_MIN_N} delivered outcomes` };
  if (h.n < GENOME_APPLY_HOLDOUT_MIN_N) return { decision: 'insufficient', reason: `${h.n} of ${GENOME_APPLY_HOLDOUT_MIN_N} holdout outcomes` };
  const upper = t.ci![1]; const hr = h.verified / h.n;
  return upper < hr
    ? { decision: 'retire', reason: `delivered ${t.verified}/${t.n} (Wilson upper ${upper}) below holdout ${h.verified}/${h.n} = ${hr.toFixed(3)}` }
    : { decision: 'keep', reason: `delivered ${t.verified}/${t.n} (Wilson upper ${upper}) not below holdout ${h.verified}/${h.n} = ${hr.toFixed(3)}` };
}

/**
 * GENOME_APPLY_MODE=on only: retires each active genome the rule condemns (status 'active' → 'retired', the same registry
 * update dream-evolution uses, guarded on status 'active'), with a `genome_apply_retire` evidence judgment and an open
 * `stall` row (subsystem genome_apply:<id>, kept open by the stall watch's genome_apply detector for 24 h). Never promotes.
 */
export function genomeApplyRetireCheck(db: Database, env: NodeJS.ProcessEnv = process.env, now = new Date()): Array<{ genome_id: string; retired: boolean; reason: string }> {
  if (genomeApplyMode(env) !== 'on') return [];
  const stats = genomeApplyStats(db, env);
  if (!stats) return [];
  const out: Array<{ genome_id: string; retired: boolean; reason: string }> = [];
  const at = now.toISOString();
  for (const [id, s] of stats) {
    const status = (db.prepare('SELECT status FROM maker_genomes WHERE id = ?').get(id) as { status: string } | undefined)?.status;
    if (status !== 'active' || id === BASELINE_GENOME) continue;
    const d = retireDecision(s.treatment, s.holdout);
    if (d.decision !== 'retire') continue;
    const note = `genome_apply auto-retire: ${d.reason}`;
    const retired = db.transaction(() => {
      if (db.prepare("UPDATE maker_genomes SET status = 'retired', note = ?, updated_at = ? WHERE id = ? AND status = 'active'").run(note, at, id).changes !== 1) return false;
      const answers = JSON.stringify({ treatment: s.treatment, holdout: s.holdout, undelivered: s.undelivered, rule: retireRuleText() });
      db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
        VALUES (?, 'genome_apply_retire', 'maker_genome', ?, ?, 'enforce', 'retired', ?, ?, ?)`).run(randomUUID(), id, sha256(answers).slice(0, 16), note, answers, at);
      db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
        VALUES (?, 'stall', 'subsystem', ?, ?, 'annotation', 'open', ?, ?, ?)`).run(randomUUID(), `genome_apply:${id}`, at, note.slice(0, 300),
        JSON.stringify({ detail: note, since: at, detector: 'genome_apply' }), at);
      return true;
    })();
    if (retired) { console.warn(`🧬 ${note} (genome ${id})`); out.push({ genome_id: id, retired: true, reason: d.reason }); }
  }
  return out;
}
const retireRuleText = () => `retire when delivered n >= ${GENOME_APPLY_RETIRE_MIN_N}, holdout n >= ${GENOME_APPLY_HOLDOUT_MIN_N} and holdout rate > delivered Wilson 95 % upper bound`;

/** Retire decisions of the last `hours` (the stall watch's genome_apply detector). */
export function recentGenomeRetirements(db: Database, sinceIso: string): Array<{ genome_id: string; at: string; reason: string | null }> {
  return (db.prepare("SELECT subject_id AS genome_id, created_at AS at, reason FROM judgments WHERE judgment = 'genome_apply_retire' AND created_at >= ? ORDER BY created_at")
    .all(sinceIso) as Array<{ genome_id: string; at: string; reason: string | null }>);
}

/** Evidence section `genome_apply`: delivered vs holdout per genome, lease receipts per arm and the retire decisions (read-only). */
export function genomeApplyEvidence(db: Database, env: NodeJS.ProcessEnv = process.env) {
  const stats = genomeApplyStats(db, env);
  const statusOf = (id: string) => { try { return (db.prepare('SELECT status FROM maker_genomes WHERE id = ?').get(id) as { status: string } | undefined)?.status ?? null; } catch { return null; } };
  let leases: Record<string, number> | null = null;
  try {
    leases = Object.fromEntries((db.prepare(`SELECT CASE WHEN json_extract(metadata, '$.genome_apply.arm') = 'holdout' THEN 'holdout'
        WHEN json_extract(metadata, '$.genome_apply.delivered') = 1 THEN 'delivered' ELSE 'undelivered' END AS k, COUNT(*) AS n
      FROM worker_leases WHERE role = 'maker' AND json_extract(metadata, '$.genome_apply.genome_id') IS NOT NULL GROUP BY 1`).all() as Array<{ k: string; n: number }>).map((r) => [r.k, r.n]));
  } catch { leases = null; }
  let retires: Array<{ genome_id: string; at: string; reason: string | null }> | null;
  try { retires = recentGenomeRetirements(db, '0000'); } catch { retires = null; }
  return {
    mode: genomeApplyMode(env), holdout_rate: GENOME_APPLY_HOLDOUT_RATE, retire_rule: retireRuleText(),
    leases: leases === null ? null : { delivered: leases.delivered ?? 0, holdout: leases.holdout ?? 0, undelivered: leases.undelivered ?? 0 },
    genomes: stats === null ? null : [...stats].map(([genome_id, s]) => {
      const d = retireDecision(s.treatment, s.holdout);
      return { genome_id, status: statusOf(genome_id), treatment: s.treatment, holdout: s.holdout, undelivered: s.undelivered,
        difference: s.treatment.rate !== null && s.holdout.rate !== null ? +(s.treatment.rate - s.holdout.rate).toFixed(3) : null, decision: d.decision, reason: d.reason };
    }),
    retire_decisions: retires,
    note: 'GENOME_APPLY_MODE=on: an active genome promoted by the gym rule is appended to oracle-lane LOOP_WORK.md of its trialled species; sha256(genome-apply:goal id) < 10 % = permanent holdout. Outcomes are settled production maker outcomes, maker-clean (bandit proxy). treatment = delivered; null rate = no outcome yet.',
  };
}

const parse = (s: string | null | undefined): Record<string, unknown> => { try { const v = JSON.parse(s || '{}'); return v && typeof v === 'object' ? v as Record<string, unknown> : {}; } catch { return {}; } };
function record(db: Database, runId: string, type: string, message: string, metadata: Record<string, unknown>): void {
  try { new LoopEventService(db).recordEvent(runId, type, 'info', message, metadata); } catch { /* events are evidence only */ }
}
