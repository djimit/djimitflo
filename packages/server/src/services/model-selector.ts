import type { Database } from 'better-sqlite3';
import { modelPrice } from './loop-budget-service';

/**
 * MS-1 (operator 2026-10-05: "model choice by cost should be Djimitflo's own behaviour"). Ollama Cloud usage was dominated
 * by kimi-k3 (an extra-high usage model) while an A/B on 5 real panel prompts gave identical, valid JSON verdicts from
 * kimi-k3, glm-5.3 and glm-5.3-flash. Instead of hand-swapping models, every call of a consumer is recorded in
 * llm_model_calls; in shadow mode a sample also asks one cheaper candidate and records whether it parsed and agreed;
 * chooseModel picks the cheapest candidate that has earned it. MODEL_SELECTOR_MODE=off|shadow|enforce (default off).
 */
export type SelectorMode = 'off' | 'shadow' | 'enforce';
export const modelSelectorMode = (env: NodeJS.ProcessEnv = process.env): SelectorMode =>
  env.MODEL_SELECTOR_MODE === 'shadow' || env.MODEL_SELECTOR_MODE === 'enforce' ? env.MODEL_SELECTOR_MODE : 'off';
export const shadowRate = (env: NodeJS.ProcessEnv = process.env): number => {
  const v = Number(env.MODEL_SELECTOR_SHADOW_RATE); return Number.isFinite(v) && v >= 0 && v <= 1 && env.MODEL_SELECTOR_SHADOW_RATE !== undefined ? v : 0.1;
};

const WINDOW_MS = 14 * 86_400_000;
const MIN_CALLS = 20; const MIN_OK = 0.95; const MIN_WILSON = 0.9; const MIN_AGREE = 0.8;
const DEFAULT_WEIGHTS = 'kimi-k3=4,glm-5.3=2,glm-5.3-flash=1';

const baseName = (model: string): string => model.replace(/^ollama:/, '').replace(/:cloud$/, '');
/** Relative usage cost of a model (MODEL_COST_WEIGHTS name=weight; unknown = 2). */
export function costWeight(model: string, env: NodeJS.ProcessEnv = process.env): number {
  const weights = new Map((env.MODEL_COST_WEIGHTS || DEFAULT_WEIGHTS).split(',').map((p) => p.split('=').map((s) => s.trim()) as [string, string]));
  const w = Number(weights.get(baseName(model)));
  return Number.isFinite(w) && w > 0 ? w : 2;
}
export const candidates = (consumer: string, env: NodeJS.ProcessEnv = process.env): string[] =>
  String(env[`MODEL_CANDIDATES_${consumer.toUpperCase()}`] || '').split(',').map((s) => s.trim()).filter(Boolean);

export interface ModelCall {
  consumer: string; model: string; ok: boolean; latencyMs: number; outChars: number; shadow: 0 | 1; agree: boolean | null;
  /** UX-18: every server-side model call lands here too (no prompt text, ever). */
  provider?: string | null; tokensIn?: number | null; tokensOut?: number | null; taskKind?: string | null; runId?: string | null; status?: string | null;
  /** B8: attempts behind this call (one row per call, not per attempt). */
  attempts?: number | null;
}
const int = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
export function recordModelCall(db: Database, c: ModelCall, at = new Date()): void {
  try {
    db.prepare(`INSERT INTO llm_model_calls (consumer, model, ok, latency_ms, out_chars, shadow, agree, provider, tokens_in, tokens_out, task_kind, run_id, status, attempts, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(c.consumer, c.model, c.ok ? 1 : 0, Math.round(c.latencyMs), c.outChars, c.shadow, c.agree === null ? null : c.agree ? 1 : 0,
        c.provider ?? null, int(c.tokensIn), int(c.tokensOut), c.taskKind ?? null, c.runId ?? null, c.status ?? null, int(c.attempts), at.toISOString());
  } catch { /* the ledger never breaks the call it measures */ }
}

/**
 * UX-18: call sites without a db handle (llm-fallback, jev, embeddings) record through the ledger registered at boot.
 * ponytail: one process-wide handle; tests register their own and reset with setLlmLedger(null).
 */
let ledgerDb: Database | null = null;
export function setLlmLedger(db: Database | null): void { ledgerDb = db; }
export type LlmCall = Omit<ModelCall, 'shadow' | 'agree'> & { shadow?: 0 | 1; agree?: boolean | null };
export function recordLlmCall(c: LlmCall, db: Database | null = ledgerDb): void {
  if (!db) return;
  recordModelCall(db, { shadow: 0, agree: null, ...c });
}
/** Times an async model call and records it (ok = resolved); the call's own result and error pass through untouched. */
export async function measured<T>(c: Omit<LlmCall, 'ok' | 'latencyMs' | 'outChars'>, call: () => Promise<T>, size: (r: T) => { outChars?: number; tokensIn?: number | null; tokensOut?: number | null } = () => ({}), db: Database | null = ledgerDb): Promise<T> {
  const started = Date.now();
  try {
    const r = await call();
    let extra: { outChars?: number; tokensIn?: number | null; tokensOut?: number | null } = {};
    try { extra = size(r); } catch { /* sizing never breaks the call */ }
    recordLlmCall({ ...c, ok: true, latencyMs: Date.now() - started, outChars: extra.outChars ?? 0, tokensIn: extra.tokensIn ?? c.tokensIn, tokensOut: extra.tokensOut ?? c.tokensOut, status: c.status ?? 'ok' }, db);
    return r;
  } catch (error) {
    recordLlmCall({ ...c, ok: false, latencyMs: Date.now() - started, outChars: 0, status: (error instanceof Error ? error.message : String(error)).slice(0, 80) }, db);
    throw error;
  }
}

const wilsonLower = (ok: number, n: number, z = 1.96): number => {
  if (!n) return 0; const p = ok / n; const z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
};

interface Stats { n: number; ok: number; compared: number; agreed: number }
function stats(db: Database, consumer: string, model: string, now: number): Stats {
  try {
    return db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(ok), 0) AS ok, COALESCE(SUM(CASE WHEN shadow = 1 AND agree IS NOT NULL THEN 1 ELSE 0 END), 0) AS compared,
      COALESCE(SUM(CASE WHEN shadow = 1 AND agree = 1 THEN 1 ELSE 0 END), 0) AS agreed FROM llm_model_calls WHERE consumer = ? AND model = ? AND created_at >= ?`)
      .get(consumer, model, new Date(now - WINDOW_MS).toISOString()) as Stats;
  } catch { return { n: 0, ok: 0, compared: 0, agreed: 0 }; }
}
/** A candidate has earned traffic: ≥ 20 calls, ok ≥ 95 % with Wilson lower bound ≥ 0.9, and ≥ 20 shadow comparisons agreeing ≥ 80 %. */
export function qualifies(s: Stats): boolean {
  return s.n >= MIN_CALLS && s.ok / s.n >= MIN_OK && wilsonLower(s.ok, s.n) >= MIN_WILSON && s.compared >= MIN_CALLS && s.agreed / s.compared >= MIN_AGREE;
}

/** The cheapest candidate (cheaper than the incumbent) that qualified in the last 14 days; otherwise the incumbent. */
export function chooseModel(db: Database, consumer: string, incumbent: string, env: NodeJS.ProcessEnv = process.env, now = Date.now()): string {
  const own = costWeight(incumbent, env);
  const best = candidates(consumer, env).filter((m) => m !== incumbent && costWeight(m, env) < own && qualifies(stats(db, consumer, m, now)))
    .sort((a, b) => costWeight(a, env) - costWeight(b, env))[0];
  return best ?? incumbent;
}

/** Shadow round-robin: the candidate with the fewest shadow calls so far, cheapest first on ties. */
export function shadowCandidate(db: Database, consumer: string, incumbent: string, env: NodeJS.ProcessEnv = process.env, now = Date.now()): string | null {
  const shadowCount = (m: string): number => {
    try { return (db.prepare('SELECT COUNT(*) AS n FROM llm_model_calls WHERE consumer = ? AND model = ? AND shadow = 1 AND created_at >= ?').get(consumer, m, new Date(now - WINDOW_MS).toISOString()) as { n: number }).n; } catch { return 0; }
  };
  return candidates(consumer, env).filter((m) => m !== incumbent)
    .map((m) => ({ m, n: shadowCount(m), w: costWeight(m, env) })).sort((a, b) => a.n - b.n || a.w - b.w)[0]?.m ?? null;
}

/** Evidence: per consumer × model in the selector window, plus what chooseModel would pick per known consumer. */
export function modelEvidence(db: Database, incumbents: Record<string, string | undefined>, env: NodeJS.ProcessEnv = process.env, now = Date.now()) {
  let rows: Array<{ consumer: string; model: string; n: number; ok_rate: number; agree_rate: number | null; median_latency_ms: number | null; cost_weight: number }> = [];
  try {
    const since = new Date(now - WINDOW_MS).toISOString();
    const groups = db.prepare(`SELECT consumer, model, COUNT(*) AS n, AVG(ok) AS ok_rate, AVG(agree) AS agree_rate FROM llm_model_calls
      WHERE created_at >= ? GROUP BY 1, 2 ORDER BY 1, n DESC`).all(since) as Array<{ consumer: string; model: string; n: number; ok_rate: number; agree_rate: number | null }>;
    const lat = db.prepare('SELECT latency_ms AS l FROM llm_model_calls WHERE consumer = ? AND model = ? AND created_at >= ? ORDER BY latency_ms');
    rows = groups.map((g) => {
      const ls = (lat.all(g.consumer, g.model, since) as Array<{ l: number }>).map((r) => r.l);
      return { ...g, ok_rate: +g.ok_rate.toFixed(3), agree_rate: g.agree_rate === null ? null : +g.agree_rate.toFixed(3),
        median_latency_ms: ls.length ? ls[Math.floor(ls.length / 2)] : null, cost_weight: costWeight(g.model, env) };
    });
  } catch { /* table absent on an old schema */ }
  const would_pick = Object.fromEntries(Object.entries(incumbents).map(([c, inc]) => [c, inc ? chooseModel(db, c, inc, env, now) : null]));
  // UX-18: every server-side LLM call per consumer over 7 d — calls, ok, tokens, and a cost only when every model has a configured price
  let usage_7d: Array<{ consumer: string; calls: number; ok: number; tokens_in: number; tokens_out: number; est_cost_usd: number | null }> = [];
  try {
    const per = db.prepare(`SELECT consumer, model, COUNT(*) AS calls, COALESCE(SUM(ok), 0) AS ok, COALESCE(SUM(tokens_in), 0) AS tin, COALESCE(SUM(tokens_out), 0) AS tout
      FROM llm_model_calls WHERE created_at >= ? GROUP BY 1, 2`).all(new Date(now - 7 * 86_400_000).toISOString()) as Array<{ consumer: string; model: string; calls: number; ok: number; tin: number; tout: number }>;
    const by = new Map<string, { consumer: string; calls: number; ok: number; tokens_in: number; tokens_out: number; est_cost_usd: number | null }>();
    for (const r of per) {
      const key = r.consumer.startsWith('resident:') ? 'resident' : r.consumer;
      const cur = by.get(key) ?? { consumer: key, calls: 0, ok: 0, tokens_in: 0, tokens_out: 0, est_cost_usd: 0 };
      const price = modelPrice(r.model, env);
      cur.calls += r.calls; cur.ok += r.ok; cur.tokens_in += r.tin; cur.tokens_out += r.tout;
      cur.est_cost_usd = price && cur.est_cost_usd !== null ? +(cur.est_cost_usd + (r.tin * price.input + r.tout * price.output) / 1_000_000).toFixed(4) : null;
      by.set(key, cur);
    }
    usage_7d = [...by.values()].sort((a, b) => b.calls - a.calls);
  } catch { /* table absent on an old schema */ }
  return { mode: modelSelectorMode(env), rows, would_pick, usage_7d };
}

/**
 * MS-2: the same selection for a consumer whose calls go through one ask(model, system, user) function (Frontier Experts:
 * expert reviews, technique cards, council perspectives share one runner). usable() says whether an answer has the
 * expected shape; agree() compares a shadow answer with the incumbent's (null = not comparable). Off: one incumbent call,
 * nothing recorded. Shadow: the incumbent answers; a sample also asks one cheaper candidate, recorded and discarded.
 * Enforce: the cheapest qualified model answers; an unusable answer falls back to the incumbent.
 */
export type AskModel = (model: string, system: string, user: string) => Promise<{ json: unknown; chars: number }>;
export function selectingRunner(db: Database, consumer: string, incumbent: string, ask: AskModel, usable: (json: unknown) => boolean,
  agree: (a: unknown, b: unknown) => boolean | null, env: NodeJS.ProcessEnv = process.env, random: () => number = Math.random, now?: number) {
  return async (system: string, user: string): Promise<unknown> => {
    const mode = modelSelectorMode(env);
    if (mode === 'off') return (await ask(incumbent, system, user)).json;
    const call = async (model: string, shadow: 0 | 1, reference?: unknown): Promise<{ json: unknown; ok: boolean }> => {
      const started = Date.now();
      try {
        const { json, chars } = await ask(model, system, user);
        const ok = usable(json);
        recordModelCall(db, { consumer, model, ok, latencyMs: Date.now() - started, outChars: chars, shadow, agree: shadow && ok && usable(reference) ? agree(reference, json) : null });
        return { json, ok };
      } catch (error) {
        recordModelCall(db, { consumer, model, ok: false, latencyMs: Date.now() - started, outChars: 0, shadow, agree: null });
        if (shadow) return { json: null, ok: false };
        throw error;
      }
    };
    const pick = mode === 'enforce' ? chooseModel(db, consumer, incumbent, env, now) : incumbent;
    let answer = await call(pick, 0);
    // the incumbent's raw answer is what callers always got (they validate it themselves); a cheaper pick must be usable
    if (!answer.ok && pick !== incumbent) answer = await call(incumbent, 0);
    if (mode === 'shadow' && random() < shadowRate(env)) {
      const candidate = shadowCandidate(db, consumer, incumbent, env, now);
      if (candidate) await call(candidate, 1, answer.json);
    }
    return answer.json;
  };
}
