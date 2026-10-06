import type { Database } from 'better-sqlite3';
import { betaSample } from './self-improvement-service';
import { PROMOTE_AFTER } from './runtime-bandit';
import { rng as seeded } from './gym-mutants';

/**
 * RX-15 (Phase F): report-only off-policy evaluation of the maker bandit. Every bandit_selected event logs the posterior
 * the choice was drawn from ({species, runs, ok} per species, incumbent first); replaying chooseSpecies' rules by seeded
 * Monte Carlo gives P(chosen species | logged state). With that propensity, the run's real outcome and the fitness view's
 * would_pick (fitness_shadow event of the same run) we estimate by SNIPS what the fitness-view policy would have scored.
 * Nothing acts on it: promoting the fitness view into chooseSpecies needs a lower CI bound ≥ 0 with ESS ≥ 60 (H13).
 */
export interface ArmState { species: string; runs: number; ok: number }

/** chooseSpecies' rules on given arm counts, one draw. Mirrors runtime-bandit.ts (Thompson, PROMOTE_AFTER, challenger cap). */
export function simulateChoice(arms: ArmState[], maxShare: number, r: () => number): number {
  const samples = arms.map((a) => betaSample(1 + a.ok, 1 + a.runs - a.ok, r));
  const best = samples.reduce((b, s, i) => (s > samples[b] ? i : b), 0);
  if (best === 0) return 0;
  if (arms[best].runs >= PROMOTE_AFTER) return best;
  return r() < maxShare ? best : 0;
}

/** P(each arm chosen | arms) by seeded Monte Carlo (default 10 000 draws). Sums to 1. */
export function propensities(arms: ArmState[], maxShare: number, draws = 10_000, seed = 1): number[] {
  const r = seeded(seed); const counts = arms.map(() => 0);
  for (let i = 0; i < draws; i++) counts[simulateChoice(arms, maxShare, r)]++;
  return counts.map((c) => c / draws);
}

export interface OpeRow { run_id: string; chosen: string; propensity: number; target_prob: number; reward: number }
export interface OpeResult {
  events: number; reconstructable: number; not_reconstructable: number; assumed_max_share: number;
  n: number; logged_value: number | null; target_value: number | null; difference: number | null;
  ci: [number, number] | null; ess: number; status: 'insufficient' | 'ok'; note: string;
}

const MAX_WEIGHT = 20;
const snips = (rows: OpeRow[]) => {
  const w = rows.map((x) => Math.min(MAX_WEIGHT, x.target_prob / x.propensity));
  const sw = w.reduce((a, b) => a + b, 0);
  const target = sw > 0 ? rows.reduce((a, x, i) => a + w[i] * x.reward, 0) / sw : 0;
  const logged = rows.reduce((a, x) => a + x.reward, 0) / rows.length;
  const ess = sw > 0 ? (sw * sw) / w.reduce((a, b) => a + b * b, 0) : 0;
  return { target, logged, diff: target - logged, ess };
};

/** SNIPS value of a target policy vs the logged policy, clipped weights, seeded bootstrap CI on the difference, ESS. */
export function offPolicyValue(rows: OpeRow[], minEss = 30, boot = 2000, seed = 7): Pick<OpeResult, 'n' | 'logged_value' | 'target_value' | 'difference' | 'ci' | 'ess' | 'status'> {
  if (!rows.length) return { n: 0, logged_value: null, target_value: null, difference: null, ci: null, ess: 0, status: 'insufficient' };
  const base = snips(rows); const r = seeded(seed); const diffs: number[] = [];
  for (let b = 0; b < boot; b++) diffs.push(snips(rows.map(() => rows[Math.floor(r() * rows.length)])).diff);
  diffs.sort((a, b) => a - b);
  const round = (x: number) => +x.toFixed(4);
  return { n: rows.length, logged_value: round(base.logged), target_value: round(base.target), difference: round(base.diff),
    ci: [round(diffs[Math.floor(0.025 * boot)]), round(diffs[Math.ceil(0.975 * boot) - 1])], ess: +base.ess.toFixed(1),
    status: base.ess < minEss ? 'insufficient' : 'ok' };
}

/** All logged bandit decisions → propensity rows for the fitness-view argmax policy (deterministic would_pick). */
export function banditOpe(db: Database, env: NodeJS.ProcessEnv = process.env): OpeResult {
  const defaultShare = Number(env.LOOP_BANDIT_MAX_SHARE) || 0.1;
  let events: Array<{ run_id: string; message: string; meta: string }> = [];
  try {
    events = db.prepare("SELECT loop_run_id AS run_id, message, metadata AS meta FROM loop_events WHERE event_type = 'bandit_selected' ORDER BY created_at").all() as typeof events;
  } catch { /* no loop_events table */ }
  const rows: OpeRow[] = []; let notReconstructable = 0; let assumed = 0;
  for (const e of events) {
    let meta: { posterior?: ArmState[]; chosen?: string; max_share?: number } = {};
    try { meta = JSON.parse(e.meta || '{}'); } catch { /* skip */ }
    const arms = (meta.posterior ?? []).map((p) => ({ species: String(p.species), runs: Number(p.runs), ok: Number(p.ok) }));
    const chosen = meta.chosen ?? /^Maker species (\S+):/.exec(e.message)?.[1];
    const idx = arms.findIndex((a) => a.species === chosen);
    if (arms.length < 2 || idx < 0 || arms.some((a) => !Number.isFinite(a.runs) || !Number.isFinite(a.ok))) { notReconstructable++; continue; }
    if (meta.max_share === undefined) assumed++;
    let shadow: { would_pick?: string } | undefined; let reward: { success: number } | undefined;
    try {
      const s = db.prepare("SELECT metadata FROM loop_events WHERE loop_run_id = ? AND event_type = 'fitness_shadow' ORDER BY created_at DESC LIMIT 1").get(e.run_id) as { metadata: string } | undefined;
      shadow = s ? JSON.parse(s.metadata) : undefined;
      const [runtime, ...model] = String(chosen).split('@');
      reward = db.prepare("SELECT success FROM skill_outcomes WHERE task_id = ? AND skill_id LIKE ? AND COALESCE(model, '') = ? ORDER BY created_at LIMIT 1")
        .get(e.run_id, `loop-maker:%:${runtime}`, model.join('@')) as { success: number } | undefined;
    } catch { /* skill_outcomes is lazy */ }
    if (!shadow?.would_pick || !reward) { notReconstructable++; continue; }
    const p = propensities(arms, meta.max_share ?? defaultShare)[idx];
    if (p <= 0) { notReconstructable++; continue; }
    rows.push({ run_id: e.run_id, chosen: String(chosen), propensity: p, target_prob: shadow.would_pick === chosen ? 1 : 0, reward: reward.success ? 1 : 0 });
  }
  return { events: events.length, reconstructable: rows.length, not_reconstructable: notReconstructable, assumed_max_share: assumed, ...offPolicyValue(rows),
    note: 'report-only: SNIPS of the fitness-view argmax vs the logged bandit; weights clipped at 20; promoting needs CI lower bound ≥ 0 with ESS ≥ 60 (H13)' };
}
