import { createHash, randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { recordModelCall } from './model-selector';
import { recordPolicyViolation } from './policy-violations';

/**
 * Plan K1: a fast content-safety check on text Djimitflo did not write (fleet/HF discoveries, replies from external
 * agents) before it flows into prompts. NVIDIA nemotron-3.5-content-safety answers in ~0.3 s and flagged a prompt
 * injection 'unsafe' while paper text stayed 'safe' (measured 2026-09-27). SHADOW ONLY: the verdict is recorded as a
 * judgment ('content_safety'); nothing is blocked (quarantine is an operator decision). Fail-open.
 *   CONTENT_SAFETY_MODE=shadow + NVIDIA_API_KEY (default off)
 */
export const contentSafetyEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.CONTENT_SAFETY_MODE === 'shadow' && Boolean(env.NVIDIA_API_KEY);

/**
 * CONTENT_SAFETY_SCOPE (default 'all' = every subject). 'decision' = only text that can lead to a decision: replies/messages
 * from external agents, remote-host patches / maker results and lure probes. Prod 7 d to 2026-10-08: 1 246 calls, 760 errors
 * (NVIDIA 429 + timeouts), mostly fleet discovery events — those and KB pages are already gated by discovery_relevance /
 * taxonomy and never act directly, so under 'decision' they get no call and no row.
 */
const DECISION_SUBJECTS = new Set(['social_reply', 'remote_patch', 'maker_result', 'lure_probe']);
export const contentSafetyApplies = (subjectType: string, env: NodeJS.ProcessEnv = process.env): boolean =>
  contentSafetyEnabled(env) && (env.CONTENT_SAFETY_SCOPE !== 'decision' || DECISION_SUBJECTS.has(subjectType));

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

/**
 * Z0: prod 7 d to 2026-10-01: 3 230 of 4 695 verdicts were http_429 (2 769 from bus-event bursts). After a 429 that
 * outlived the retries, stop calling for CONTENT_SAFETY_429_PAUSE_MS (default 10 min): skipped subjects get no row, so the
 * daily KB sync re-checks them; nothing was ever blocked by this shadow check.
 */
let pausedUntil = 0;
export const resetContentSafetyPause = (): void => { pausedUntil = 0; };

export async function checkContentSafety(db: Database, subject: { type: string; id: string }, text: string, fetchFn: typeof fetch = fetch): Promise<'safe' | 'unsafe' | null> {
  if (!contentSafetyApplies(subject.type) || !text.trim() || Date.now() < pausedUntil) return null;
  const model = process.env.CONTENT_SAFETY_MODEL || 'nvidia/nemotron-3.5-content-safety';
  const started = Date.now();
  // prod 2026-09-27: 1 241 of 1 312 KB pages got no verdict and nothing said why; failures are recorded as 'error' now
  const record = (decision: string, reason: string) => {
    db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, latency_ms, model, created_at)
      VALUES (?, 'content_safety', ?, ?, ?, 'shadow', ?, ?, ?, ?, ?)`).run(randomUUID(), subject.type, subject.id,
      createHash('sha256').update(text).digest('hex').slice(0, 16), decision, reason, Date.now() - started, model, new Date().toISOString());
    // UX-18: one ledger row per recorded verdict (consumer 'content_safety'); sizes only, never the text
    recordModelCall(db, { consumer: 'content_safety', model, provider: 'nvidia', ok: decision !== 'error', latencyMs: Date.now() - started, outChars: 0, shadow: 0, agree: null,
      tokensIn: Math.ceil(Math.min(text.length, 4_000) / 4), taskKind: 'safety', status: reason.slice(0, 80) });
  };
  try {
    const res = await nvidiaFetch(`${(process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', signal: AbortSignal.timeout(60_000),
      headers: { Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: text.slice(0, 4_000) }], max_tokens: 60 }),
    }, fetchFn);
    if (res.status === 429) {
      // prod 02-10 07:21Z: a bus burst fired 600+ checks at once; 531 came back 429 after the first one paused → one row, not 531
      if (Date.now() < pausedUntil) return null;
      pausedUntil = Date.now() + (Number(process.env.CONTENT_SAFETY_429_PAUSE_MS) || 600_000);
    }
    if (!res.ok) { record('error', `http_${res.status}${res.status === 429 ? ' (pausing checks)' : ''}`); return null; }
    const body = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const { verdict, categories } = parseSafety(body.choices?.[0]?.message?.content ?? '');
    if (!verdict) { record('error', `unparsed:${JSON.stringify((body.choices?.[0]?.message?.content ?? '').slice(0, 80))}`); return null; }
    record(verdict === 'safe' ? 'yes' : 'no', `verdict=${verdict}${categories ? ` categories=${categories}` : ''}`);
    // §16 step 8 (shadow, POLICY_VIOLATION_LOG): untrusted input judged unsafe is counted; nothing is blocked (still shadow)
    if (verdict === 'unsafe') {
      const stateHash = createHash('sha256').update(text).digest('hex').slice(0, 16);
      recordPolicyViolation(db, { kind: 'content_unsafe', actor: `${subject.type}:${subject.id}`.slice(0, 200), severity: 'high', dedupe_key: `${subject.type}:${subject.id}:${stateHash}`,
        evidence_ref: `judgment:content_safety:${subject.type}:${subject.id}:${stateHash}`, description: `content safety 'unsafe'${categories ? ` (${categories})` : ''} on ${subject.type}` });
    }
    return verdict;
  } catch (error) {
    // prod 05-10 07:23Z: a burst of 300 checks ended in 224 timeouts within 16 s — a timeout pauses like a 429, one row per burst
    if (error instanceof Error && error.name === 'TimeoutError') {
      if (Date.now() < pausedUntil) return null;
      pausedUntil = Date.now() + (Number(process.env.CONTENT_SAFETY_429_PAUSE_MS) || 600_000);
      try { record('error', 'timeout (pausing checks)'); } catch { /* never break the caller */ }
      return null;
    }
    try { record('error', (error instanceof Error ? error.name === 'TimeoutError' ? 'timeout' : error.message : String(error)).slice(0, 120)); } catch { /* never break the caller */ }
    return null;
  }
}
