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

export class TypeSafeClient {
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async systemOne(state: unknown, questions: Record<string, TsQuestion>, opts: { timeoutMs?: number; retries?: number } = {}): Promise<TsResponse> {
    const key = process.env.TYPESAFE_API_KEY?.trim();
    if (!key) throw new Error('TYPESAFE_NOT_CONFIGURED');
    if (Date.now() < downUntil) throw new Error('TYPESAFE_BREAKER_OPEN');
    const base = (process.env.TYPESAFE_BASE_URL || 'https://api.typesafe.ai').replace(/\/$/, '');
    const body = JSON.stringify({ state: prepareState(state), model: process.env.TYPESAFE_MODEL || 'jev-1.13.0', questions });
    const retries = opts.retries ?? 2;
    let lastError = 'unknown';
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await this.fetchFn(`${base}/v1/systemone`, {
          method: 'POST', body, signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        });
        if (response.ok) { failures = 0; return (await response.json()) as TsResponse; }
        lastError = `HTTP ${response.status}`;
        if (response.status === 401 || response.status === 422) break; // retrying cannot help
        if (response.status !== 429 && response.status !== 529 && response.status < 500) break;
      } catch (err) { lastError = err instanceof Error ? err.message : String(err); }
      if (attempt < retries) await new Promise((r) => setTimeout(r, 400 * 2 ** attempt)); // exponential backoff (docs: 429)
    }
    failures += 1;
    if (failures >= 3) downUntil = Date.now() + BREAKER_MS;
    throw new Error(`TYPESAFE_FAILED: ${lastError}`);
  }
}
