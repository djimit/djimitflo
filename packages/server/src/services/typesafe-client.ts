/**
 * Thin client for TypeSafe's System One API (docs.typesafe.ai): typed questions (noul / choice / score) in, calibrated
 * probabilities (+ confidence for choice/score) out — a fast, cheap, consistent judgment layer next to the slow LLM panel.
 * Zero dependencies (fetch). Fail-open by design: callers treat any error as "no judgment" and keep their existing logic.
 *   TYPESAFE_API_KEY (required)  TYPESAFE_MODEL (default jev-1.13.0, pinned: aliases move)  TYPESAFE_BASE_URL
 * Known model limits (docs "Jev 1.13"): literal reading, weak at counting/arithmetic/dates, steerable by injected
 * instructions, no cross-question invariants, not for text generation — keep arithmetic in code and never use it as a security boundary.
 */
export interface TsQuestion { type: 'noul' | 'choice' | 'score'; instructions: string; criteria?: unknown }
export interface TsAnswer { type: string; noul?: number; choice?: string; score?: number; probabilities?: Record<string, number>; confidence?: number }
export interface TsResponse { model: string; answers: Record<string, TsAnswer>; usage?: { input_tokens?: number; output_tokens?: number } }

export const typesafeConfigured = (): boolean => Boolean(process.env.TYPESAFE_API_KEY?.trim());

const BREAKER_MS = 60_000;
let downUntil = 0; let failures = 0;
export function resetTypesafeBreaker(): void { downUntil = 0; failures = 0; }

const MAX_STATE_CHARS = 60_000; // the model takes 32k tokens of state + question; stay well below
const SECRET_RE = /(?:apikey_|sk-|ghp_|xox[bp]-|AKIA)[A-Za-z0-9_\-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi;

/** Redacts obvious secrets and caps size before state leaves the host. Strings only: structure is preserved. */
export function prepareState<T>(state: T): T {
  const scrub = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(SECRET_RE, '[redacted]').slice(0, MAX_STATE_CHARS);
    if (Array.isArray(v)) return v.slice(0, 200).map(scrub);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, scrub(x)]));
    return v;
  };
  return scrub(state) as T;
}

import { recordLlmCall } from './model-selector';

/**
 * B8 (prod 06-10): a fleet-discovery burst fired ~295 parallel calls; Node queued them and 271 hit the 10 s timeout while
 * still waiting (10–238 s recorded). One shared limiter: at most TYPESAFE_MAX_CONCURRENCY (default 6) requests in flight;
 * the rest wait and their timeout starts only when their request starts; beyond TYPESAFE_MAX_QUEUE (default 200) waiting
 * calls fail fast with TYPESAFE_QUEUE_FULL (callers are fail-open). Normal traffic (≤ 6 at once) never waits.
 * JEV-BURST (prod 7 d to 08-10: 1 104 of 1 299 jev calls fell in the 07:xx discovery ingest, 539 usable; the other 195 calls
 * 191 ok, avg 0.7 s): the ingest enqueues a whole batch inside one synchronous transaction, so nothing drains while it runs and
 * a 500-discovery batch overflowed the 200 queue (288 queue_full on 08-10). A waiting call holds only a closure and its state
 * and its timeout has not started, so the default queue is 1 000 (~1 min to drain at 6 × ~0.4 s). latency_ms is the request
 * time from the moment it gets a slot; it used to include the wait (ok calls averaged 156 s, median of all calls 39 s).
 */
let active = 0;
const waiting: Array<() => void> = [];
export function resetTypesafeLimiter(): void { active = 0; waiting.length = 0; }
const envInt = (name: string, d: number): number => { const n = Number(process.env[name]); return Number.isInteger(n) && n > 0 ? n : d; };
async function acquire(): Promise<boolean> {
  if (active < envInt('TYPESAFE_MAX_CONCURRENCY', 6)) { active += 1; return true; }
  if (waiting.length >= envInt('TYPESAFE_MAX_QUEUE', 1000)) return false;
  await new Promise<void>((resolve) => waiting.push(resolve));
  active += 1;
  return true;
}
function release(): void { active = Math.max(0, active - 1); waiting.shift()?.(); }

const MODEL = (): string => process.env.TYPESAFE_MODEL || 'jev-1.13.0';
const statusOf = (err: unknown): string => {
  const e = err as { name?: string; message?: string };
  if (e?.name === 'TimeoutError' || /aborted due to timeout|timed? ?out/i.test(e?.message ?? '')) return 'timeout';
  return String(e?.message ?? err).slice(0, 80);
};

export class TypeSafeClient {
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  /** One ledger row per call (final outcome + attempts), not one per attempt; breaker_open and queue_full are recorded too. */
  async systemOne(state: unknown, questions: Record<string, TsQuestion>, opts: { timeoutMs?: number; retries?: number } = {}): Promise<TsResponse> {
    const key = process.env.TYPESAFE_API_KEY?.trim();
    if (!key) throw new Error('TYPESAFE_NOT_CONFIGURED');
    let started = Date.now();
    const record = (ok: boolean, status: string, attempts: number, tokensIn?: number) =>
      recordLlmCall({ consumer: 'jev', model: MODEL(), provider: 'typesafe', ok, latencyMs: Date.now() - started, outChars: 0, tokensIn, taskKind: 'systemone', status, attempts });
    if (Date.now() < downUntil) { record(false, 'breaker_open', 0); throw new Error('TYPESAFE_BREAKER_OPEN'); }
    if (!(await acquire())) { record(false, 'queue_full', 0); throw new Error('TYPESAFE_QUEUE_FULL'); }
    started = Date.now(); // a slot is ours: latency is the request, not the wait
    try {
      const base = (process.env.TYPESAFE_BASE_URL || 'https://api.typesafe.ai').replace(/\/$/, '');
      const body = JSON.stringify({ state: prepareState(state), model: MODEL(), questions });
      const retries = opts.retries ?? 2;
      let lastStatus = 'unknown'; let attempts = 0;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        attempts += 1;
        try {
          const response = await this.fetchFn(`${base}/v1/systemone`, {
            method: 'POST', body, signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          });
          if (response.ok) {
            failures = 0; const out = (await response.json()) as TsResponse;
            record(true, 'ok', attempts, Math.ceil(body.length / 4));
            return out;
          }
          lastStatus = `http_${response.status}`;
          if (response.status === 401 || response.status === 422) break; // retrying cannot help
          if (response.status !== 429 && response.status !== 529 && response.status < 500) break;
        } catch (err) {
          lastStatus = statusOf(err);
        }
        if (attempt < retries) await new Promise((r) => setTimeout(r, 400 * 2 ** attempt)); // exponential backoff (docs: 429)
      }
      failures += 1;
      if (failures >= 3) downUntil = Date.now() + BREAKER_MS;
      record(false, lastStatus, attempts);
      throw new Error(`TYPESAFE_FAILED: ${lastStatus}`);
    } finally {
      release();
    }
  }
}
