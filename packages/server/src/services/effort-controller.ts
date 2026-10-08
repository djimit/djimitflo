import { createHash, randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { parseSpecies, type Species } from './evolve-selection';
import { fitnessKeys, fitnessPosterior } from './fitness-view';
import { speciesKey } from './runtime-bandit';
import { LoopEventService } from './loop-event-service';

/**
 * "Effort Paradox" (operator-approved 08-10). Two pieces, both default off:
 *
 * 1. EVC effort controller — SHADOW ONLY (EFFORT_CONTROLLER_MODE=off|shadow). At a decision point every option gets
 *      EVC = P(success | option, lane, species)·V + VOI − λ_tok·cloud tokens/1M − λ_kWh·kWh
 *    and the max is picked (with probability EFFORT_EXPLORATION, default 0.05, a non-max option instead: explored:true).
 *    The pick is only recorded (`effort_decision` loop event, or a `judgments` row for judgment dispatch); nothing reads it.
 *    V = 1 verified change. λ_tok = verified changes per M cloud maker tokens over the last 7 days (fallback
 *    EFFORT_LAMBDA_TOK, default 0.41). λ_kWh = EFFORT_LAMBDA_KWH (default 0: the GPU has slack).
 * 2. X1 sibling randomisation (EFFORT_SIBLING_RANDOMISE=true, acting): an oracle-lane goal (one that gets evolve siblings)
 *    lands in arm 'on' (siblings as today) or 'off' (no sibling) by sha256 of its goal id; the arm is stored on the goal
 *    (metadata.effort_arm) and in an `effort_arm` event; evolution-evidence `effort_x1` compares the arms.
 */
export type EffortMode = 'off' | 'shadow';
export const effortMode = (env: NodeJS.ProcessEnv = process.env): EffortMode => (env.EFFORT_CONTROLLER_MODE === 'shadow' ? 'shadow' : 'off');
export const siblingRandomiseEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.EFFORT_SIBLING_RANDOMISE === 'true';

export interface EffortOption { name: string; p: number; v: number; voi: number; tokens: number; kwh: number }
export interface EffortParams { lambda_tok: number; lambda_kwh: number; exploration: number }
export interface EffortChoice { chosen: string; best: string; explored: boolean; evc: Record<string, number> }

export const evc = (o: EffortOption, p: EffortParams): number => o.p * o.v + o.voi - p.lambda_tok * (o.tokens / 1e6) - p.lambda_kwh * o.kwh;

/** The max-EVC option (ties: the first listed), or with probability `exploration` a uniformly drawn non-max one. */
export function chooseEffort(options: EffortOption[], params: EffortParams, rng: () => number = Math.random): EffortChoice {
  const values = Object.fromEntries(options.map((o) => [o.name, +evc(o, params).toFixed(6)]));
  const best = options.reduce((b, o) => (values[o.name] > values[b.name] ? o : b), options[0]).name;
  const others = options.filter((o) => o.name !== best);
  if (others.length && rng() < params.exploration) return { chosen: others[Math.min(others.length - 1, Math.floor(rng() * others.length))].name, best, explored: true, evc: values };
  return { chosen: best, best, explored: false, evc: values };
}

const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);

/** A species burns no cloud tokens when it runs on our hardware: a remote host, or a local model server (llama-router, ollama without :cloud). */
export const cloudSpecies = (s: Species): boolean => !['remote', 'mock', 'manual'].includes(s.runtime) && !/llama-router|^ollama\/(?!.*:cloud)/.test(s.model ?? '');

export function effortParams(db: Database, env: NodeJS.ProcessEnv = process.env, now = Date.now()): EffortParams & { lambda_tok_source: 'data' | 'env'; verified_7d: number; cloud_tokens_7d: number } {
  const since = new Date(now - 7 * 86_400_000).toISOString();
  let verified = 0; let cloudTokens = 0;
  try {
    verified = (db.prepare("SELECT COUNT(*) AS n FROM self_improvements WHERE status = 'verified' AND updated_at >= ?").get(since) as { n: number }).n;
    const leases = db.prepare(`SELECT runtime, json_extract(metadata, '$.model') AS model, json_extract(metadata, '$.runtime_usage.total_tokens') AS tokens
      FROM worker_leases WHERE role = 'maker' AND created_at >= ? AND json_extract(metadata, '$.runtime_usage.total_tokens') > 0`).all(since) as Array<{ runtime: string; model: string | null; tokens: number }>;
    cloudTokens = leases.filter((l) => cloudSpecies({ runtime: l.runtime, ...(l.model ? { model: l.model } : {}) })).reduce((a, l) => a + Number(l.tokens), 0);
  } catch { /* minimal schema: fall back to the env */ }
  const data = verified > 0 && cloudTokens > 0;
  return { lambda_tok: data ? +(verified / (cloudTokens / 1e6)).toFixed(6) : num(env.EFFORT_LAMBDA_TOK, 0.41), lambda_tok_source: data ? 'data' : 'env',
    lambda_kwh: num(env.EFFORT_LAMBDA_KWH, 0), exploration: Math.min(1, num(env.EFFORT_EXPLORATION, 0.05)), verified_7d: verified, cloud_tokens_7d: cloudTokens };
}

/** Beta(1,1) posterior mean of k successes in n. */
const betaMean = (ok: number, n: number): number => (1 + ok) / (2 + n);
/** Rough energy of a local run: mean outcome duration × ~0.3 kW (R9700 under load). Cloud energy is not on our meter. */
const LOCAL_KW = 0.3;

/** One maker species as an option: fitness-view posterior (production + capped gym prior + merge), mean lease tokens. */
function speciesOption(db: Database, lane: string, s: Species, now: number): EffortOption {
  const p = fitnessPosterior(db, lane, [s], now)[0].mean;
  const one = <T>(sql: string, ...args: unknown[]): T | undefined => { try { return db.prepare(sql).get(...args) as T | undefined; } catch { return undefined; } };
  const tokens = cloudSpecies(s) ? Number(one<{ t: number | null }>(`SELECT AVG(json_extract(metadata, '$.runtime_usage.total_tokens')) AS t FROM worker_leases
    WHERE role = 'maker' AND runtime = ? AND COALESCE(json_extract(metadata, '$.model'), '') = ? AND json_extract(metadata, '$.runtime_usage.total_tokens') IS NOT NULL`, s.runtime, s.model ?? '')?.t) || 0 : 0;
  const prod = fitnessKeys(lane, s)[0];
  const ms = cloudSpecies(s) ? 0 : Number(one<{ d: number | null }>('SELECT AVG(duration_ms) AS d FROM skill_outcomes WHERE skill_id = ? AND COALESCE(model, \'\') = ?', prod.skillId, prod.model)?.d) || 0;
  return { name: speciesKey(s), p: +p.toFixed(4), v: 1, voi: 0, tokens: Math.round(tokens), kwh: +((ms / 3_600_000) * LOCAL_KW).toFixed(4) };
}

function decide(db: Database, env: NodeJS.ProcessEnv, rng: () => number, now: number, point: string, defaultOption: string, options: EffortOption[], extra: Record<string, unknown> = {}) {
  const params = effortParams(db, env, now);
  const choice = chooseEffort(options, params, rng);
  return { decision_point: point, default_option: defaultOption, chosen_option: choice.chosen, best_option: choice.best, explored: choice.explored, evc: choice.evc,
    inputs: { options, lambda_tok: params.lambda_tok, lambda_tok_source: params.lambda_tok_source, verified_7d: params.verified_7d, cloud_tokens_7d: params.cloud_tokens_7d,
      lambda_kwh: params.lambda_kwh, exploration: params.exploration, ...extra } };
}
const message = (d: { decision_point: string; default_option: string; chosen_option: string; explored: boolean }) =>
  `EVC (shadow) at ${d.decision_point}: would pick ${d.chosen_option}${d.explored ? ' (explored)' : ''}; default ${d.default_option}`;

/**
 * Hook (a): the loop daemon's evolve-sibling decision. Options: none, each configured sibling species and — with more than
 * one — 'all' (the sum of their EVCs). `actual` is what the daemon does (after X1), recorded as default_option.
 */
export function recordEffortSibling(db: Database, runId: string, lane: string, candidates: Species[], actual: Species[], env: NodeJS.ProcessEnv = process.env,
  rng: () => number = Math.random, now = Date.now()): void {
  if (effortMode(env) !== 'shadow' || !candidates.length) return;
  try {
    const each = candidates.map((s) => speciesOption(db, lane, s, now));
    const all: EffortOption[] = each.length > 1 ? [{ name: 'all', p: +each.reduce((a, o) => a + o.p, 0).toFixed(4), v: 1, voi: 0, tokens: each.reduce((a, o) => a + o.tokens, 0), kwh: +each.reduce((a, o) => a + o.kwh, 0).toFixed(4) }] : [];
    const options = [...all, { name: 'none', p: 0, v: 1, voi: 0, tokens: 0, kwh: 0 }, ...each];
    const def = !actual.length ? 'none' : actual.length > 1 ? 'all' : speciesKey(actual[0]);
    const d = decide(db, env, rng, now, 'evolve_sibling', def, options, { lane });
    new LoopEventService(db).recordEvent(runId, 'effort_decision', 'info', message(d), d);
  } catch { /* shadow: never affects the loop */ }
}

/**
 * Hook (b): remote gym claim. Options: serve the task or skip it. A gym attempt produces no verified change (P = 0); its
 * value is information, VOI = q(1 − q) with q the task's Beta(1,1) pass rate over earlier scored attempts (no history: 0.25).
 */
export function recordEffortGym(db: Database, runId: string, species: string, commit: string, env: NodeJS.ProcessEnv = process.env,
  rng: () => number = Math.random, now = Date.now()): void {
  if (effortMode(env) !== 'shadow') return;
  try {
    const hist = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(json_extract(metadata, '$.gym_result.status') = 'success'), 0) AS ok FROM loop_runs
      WHERE loop_name = 'evolution-gym' AND json_extract(metadata, '$.gym.commit') = ? AND json_extract(metadata, '$.gym_result.status') IN ('success', 'failure')
        AND json_extract(metadata, '$.gym.canary') IS NULL`).get(commit) as { n: number; ok: number };
    const q = betaMean(hist.ok, hist.n);
    const [s] = parseSpecies(species, 1);
    const tokens = s && cloudSpecies(s) ? Number((db.prepare("SELECT AVG(tokens_used) AS t FROM skill_outcomes WHERE domain = 'gym' AND skill_id = ? AND COALESCE(model, '') = ?")
      .get(`loop-maker:gym:${s.runtime}`, s.model ?? '') as { t: number | null }).t) || 0 : 0;
    const options: EffortOption[] = [{ name: 'serve', p: 0, v: 1, voi: +(q * (1 - q)).toFixed(6), tokens: Math.round(tokens), kwh: 0 }, { name: 'skip', p: 0, v: 1, voi: 0, tokens: 0, kwh: 0 }];
    const d = decide(db, env, rng, now, 'remote_gym_claim', 'serve', options, { species, commit, task_pass: { n: hist.n, ok: hist.ok, q: +q.toFixed(4) } });
    new LoopEventService(db).recordEvent(runId, 'effort_decision', 'info', message(d), d);
  } catch { /* shadow: never affects the claim */ }
}

/**
 * Who acts on a judgment's decision (verified in code 08-10). VOI is 0 without one. Not every consumer is always on:
 * the flag in brackets gates it. telegram_access and content_safety are written directly, not through runJudgment,
 * so hook (c) never sees them; they are listed for completeness.
 */
export const JUDGMENT_CONSUMERS: Record<string, string | null> = {
  proposal_prescreen: 'self-improvement-auto-review-scheduler: a confident no parks the proposal [TYPESAFE_PROPOSAL_PRESCREEN_MODE=enforce]',
  kb_passage_relevance: 'kb-corpus: passage selection for the panel',
  telegram_access: 'telegram-identity: access gate (direct insert)',
  content_safety: 'kb-corpus: a verdicted page is not re-checked (direct insert)',
  discovery_relevance: 'expert-source-units / interest-feedback / committee-swarm / dream-evolution read the yes verdicts',
  checker_second_opinion: 'honest-numbers oracleAgreement: kappa and enforce eligibility',
  failure_cause: 'dream-state consolidate → engineering-rule memory candidates; commons evidence pack',
  reflection_triage: 'needs-grounding-triage [NEEDS_GROUNDING_TRIAGE_ENABLED]; commons-grounding topic filter',
  commons_contribution: 'agent-social-autopilot threadGated [COMMONS_THREAD_GATE_ENABLED]',
  decision_context: 'agent review: selected memories injected [TYPESAFE_DECISION_CONTEXT_MODE=enforce]',
  commons_idea: null,
  risk_atomic: null,
};

/**
 * Hook (c): judgment dispatch (runJudgment / runJudgments). Options: run or skip. A judgment produces no verified change
 * (P = 0); VOI = q(1 − q) with q the Beta(1,1) share of 'yes' over its last 30 days when a consumer acts on it, else 0;
 * tokens = its mean input + output tokens over 30 days. Recorded as a `judgments` row 'effort_decision' (mode shadow,
 * decision = the chosen option) on the judgment's own subject.
 */
export function recordEffortJudgment(db: Database, judgment: string, subject: { type: string; id: string }, env: NodeJS.ProcessEnv = process.env,
  rng: () => number = Math.random, now = Date.now()): void {
  if (effortMode(env) !== 'shadow') return;
  try {
    const since = new Date(now - 30 * 86_400_000).toISOString();
    const h = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(decision = 'yes'), 0) AS yes, AVG(input_tokens + output_tokens) AS t FROM judgments
      WHERE judgment = ? AND decision <> 'error' AND created_at >= ?`).get(judgment, since) as { n: number; yes: number; t: number | null };
    const consumer = JUDGMENT_CONSUMERS[judgment] ?? null;
    const q = betaMean(h.yes, h.n);
    const options: EffortOption[] = [{ name: 'run', p: 0, v: 1, voi: consumer ? +(q * (1 - q)).toFixed(6) : 0, tokens: Math.round(Number(h.t) || 0), kwh: 0 }, { name: 'skip', p: 0, v: 1, voi: 0, tokens: 0, kwh: 0 }];
    const d = decide(db, env, rng, now, `judgment:${judgment}`, 'run', options, { consumer, history: { n: h.n, yes: h.yes, q: +q.toFixed(4) } });
    db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, model, created_at)
      VALUES (?, 'effort_decision', ?, ?, ?, 'shadow', ?, ?, ?, 'evc', ?)`).run(randomUUID(), subject.type, subject.id, judgment, d.chosen_option, message(d), JSON.stringify(d), new Date(now).toISOString());
  } catch { /* shadow: never affects the judgment */ }
}

/** X1: the arm of a goal — sha256 of a salted goal id (independent of the memory-holdout arms), ~50/50. */
export const siblingArm = (goalId: string): 'on' | 'off' => (createHash('sha256').update(`effort-x1:${goalId}`).digest()[0] % 2 === 0 ? 'on' : 'off');

/** X1: assign (idempotent per goal), store on the goal and log on the run. */
export function assignSiblingArm(db: Database, runId: string, goalId: string): 'on' | 'off' {
  const arm = siblingArm(goalId);
  try {
    db.prepare("UPDATE goals SET metadata = json_set(COALESCE(NULLIF(metadata, ''), '{}'), '$.effort_arm', ?) WHERE id = ?").run(arm, goalId);
    new LoopEventService(db).recordEvent(runId, 'effort_arm', 'info', `X1 sibling randomisation: arm ${arm}${arm === 'off' ? ' (no evolve sibling)' : ''}`, { goal_id: goalId, arm });
  } catch { /* the arm still decides; only the record is best-effort */ }
  return arm;
}

/** evolution-evidence `effort_x1`: goals per arm and their proposal outcome; infra = a maker outcome tagged infra_failed. */
export function effortX1Evidence(db: Database, since: string, env: NodeJS.ProcessEnv, fisher: (a: number, b: number, c: number, d: number) => number) {
  let rows: Array<{ arm: string; goals: number; verified: number; regressed: number; infra: number }> = [];
  try {
    rows = db.prepare(`SELECT json_extract(g.metadata, '$.effort_arm') AS arm, COUNT(*) AS goals,
        COALESCE(SUM(s.status = 'verified'), 0) AS verified, COALESCE(SUM(s.status = 'regressed'), 0) AS regressed,
        COALESCE(SUM(EXISTS (SELECT 1 FROM loop_runs r JOIN skill_outcomes o ON o.task_id = r.id WHERE r.goal_id = g.id
          AND o.evidence_refs_json LIKE '%"outcome_class:infra_failed"%')), 0) AS infra
      FROM goals g LEFT JOIN self_improvements s ON s.id = g.improvement_id
      WHERE json_extract(g.metadata, '$.effort_arm') IN ('on', 'off') AND g.created_at >= ? GROUP BY 1`).all(since) as typeof rows;
  } catch { /* missing tables */ }
  const arm = (name: string) => {
    const r = rows.find((x) => x.arm === name) ?? { goals: 0, verified: 0, regressed: 0, infra: 0 };
    const settled = r.verified + r.regressed;
    return { goals: r.goals, verified: r.verified, regressed: r.regressed, infra: r.infra, verified_rate: settled ? +(r.verified / settled).toFixed(3) : null };
  };
  const on = arm('on'); const off = arm('off');
  return { enabled: env.EFFORT_SIBLING_RANDOMISE ?? null, on, off, fisher_p: +fisher(on.verified, on.regressed, off.verified, off.regressed).toPrecision(4),
    note: 'X1 (EFFORT_SIBLING_RANDOMISE): oracle-lane goals by sha256 of the goal id; on = evolve siblings as configured, off = none. verified_rate over settled (verified + regressed); two-sided Fisher exact.' };
}
