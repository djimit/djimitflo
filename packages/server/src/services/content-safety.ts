import { createHash, randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

/**
 * Plan K1: a fast content-safety check on text Djimitflo did not write (fleet/HF discoveries, replies from external
 * agents) before it flows into prompts. NVIDIA nemotron-3.5-content-safety answers in ~0.3 s and flagged a prompt
 * injection 'unsafe' while paper text stayed 'safe' (measured 2026-09-27). SHADOW ONLY: the verdict is recorded as a
 * judgment ('content_safety'); nothing is blocked (quarantine is an operator decision). Fail-open.
 *   CONTENT_SAFETY_MODE=shadow + NVIDIA_API_KEY (default off)
 */
export const contentSafetyEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.CONTENT_SAFETY_MODE === 'shadow' && Boolean(env.NVIDIA_API_KEY);

/**
 * NVIDIA's free tier answers 429 after ~4 calls in a burst (measured 2026-09-27: 4×200 then 429s within 3 s), which left
 * 1 241 of 1 312 KB pages without a safety verdict. Retry 429s with backoff (Retry-After when given), at most 3 times.
 */
export async function nvidiaFetch(url: string, init: RequestInit, fetchFn: typeof fetch = fetch, waitMs = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchFn(url, init);
    if (res.status !== 429 || attempt >= 3) return res;
    await waitMs(Math.min((Number(res.headers?.get?.('retry-after')) || 2 ** attempt * 2) * 1_000, 30_000));
  }
}

export function parseSafety(content: string): { verdict: 'safe' | 'unsafe' | null; categories: string } {
  const text = content || '';
  const m = /user safety"?\s*:\s*"?(safe|unsafe)/i.exec(text);
  const cats = /safety categories"?\s*:\s*"?([^"\n}]+)/i.exec(text);
  return { verdict: m ? (m[1].toLowerCase() as 'safe' | 'unsafe') : null, categories: cats ? cats[1].trim().slice(0, 200) : '' };
}

export async function checkContentSafety(db: Database, subject: { type: string; id: string }, text: string, fetchFn: typeof fetch = fetch): Promise<'safe' | 'unsafe' | null> {
  if (!contentSafetyEnabled() || !text.trim()) return null;
  const model = process.env.CONTENT_SAFETY_MODEL || 'nvidia/nemotron-3.5-content-safety';
  const started = Date.now();
  // prod 2026-09-27: 1 241 of 1 312 KB pages got no verdict and nothing said why; failures are recorded as 'error' now
  const record = (decision: string, reason: string) => db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, latency_ms, model, created_at)
      VALUES (?, 'content_safety', ?, ?, ?, 'shadow', ?, ?, ?, ?, ?)`).run(randomUUID(), subject.type, subject.id,
      createHash('sha256').update(text).digest('hex').slice(0, 16), decision, reason, Date.now() - started, model, new Date().toISOString());
  try {
    const res = await nvidiaFetch(`${(process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', signal: AbortSignal.timeout(60_000),
      headers: { Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: text.slice(0, 4_000) }], max_tokens: 60 }),
    }, fetchFn);
    if (!res.ok) { record('error', `http_${res.status}`); return null; }
    const body = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const { verdict, categories } = parseSafety(body.choices?.[0]?.message?.content ?? '');
    if (!verdict) { record('error', `unparsed:${JSON.stringify((body.choices?.[0]?.message?.content ?? '').slice(0, 80))}`); return null; }
    record(verdict === 'safe' ? 'yes' : 'no', `verdict=${verdict}${categories ? ` categories=${categories}` : ''}`);
    return verdict;
  } catch (error) {
    try { record('error', (error instanceof Error ? error.name === 'TimeoutError' ? 'timeout' : error.message : String(error)).slice(0, 120)); } catch { /* never break the caller */ }
    return null;
  }
}
