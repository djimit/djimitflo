import { createHash, randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { recordModelCall } from './model-selector';
import { recordPolicyViolation } from './policy-violations';

/**
 * Plan K1: a fast content-safety check on text Djimitflo did not write (fleet/HF discoveries, replies from external
 * agents) before it flows into prompts. NVIDIA nemotron-3.5-content-safety answers in ~0.3 s and flagged a prompt
 * injection 'unsafe' while paper text stayed 'safe' (measured 2026-09-27). The verdict is recorded as a judgment
 * ('content_safety'). Fail-open. NOT shadow-only everywhere: KB ingest (kb-corpus) quarantines a page on 'unsafe' in every
 * mode, and those rows are recorded with mode 'enforce' (P0-11); other callers only record (mode 'shadow').
 *   CONTENT_SAFETY_MODE=shadow + NVIDIA_API_KEY (default off); 'enforce' checks the same way and additionally makes the
 *   prompt gate (gateUntrustedForPrompt, B19) exclude untrusted text without a 'safe' verdict.
 */
export const contentSafetyEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => (env.CONTENT_SAFETY_MODE === 'shadow' || env.CONTENT_SAFETY_MODE === 'enforce') && Boolean(env.NVIDIA_API_KEY);

/**
 * CONTENT_SAFETY_SCOPE (default 'all' = every subject). 'decision' = only text that can lead to a decision: replies/messages
 * from external agents, remote-host patches / maker results and lure probes. Prod 7 d to 2026-10-08: 1 246 calls, 760 errors
 * (NVIDIA 429 + timeouts), mostly fleet discovery events — those and KB pages are already gated by discovery_relevance /
 * taxonomy and never act directly, so under 'decision' they get no call and no row.
 */
const DECISION_SUBJECTS = new Set(['social_reply', 'remote_patch', 'maker_result', 'lure_probe']);
export const contentSafetyApplies = (subjectType: string, env: NodeJS.ProcessEnv = process.env, promptBound = false): boolean =>
  contentSafetyEnabled(env) && (promptBound || env.CONTENT_SAFETY_SCOPE !== 'decision' || DECISION_SUBJECTS.has(subjectType));

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
  if (m) return { verdict: m[1].toLowerCase() as 'safe' | 'unsafe', categories: cats ? cats[1].trim().slice(0, 200) : '' };
  // Llama Guard shape: the whole answer is "safe", or "unsafe" with category codes on the next line
  const g = /^\s*(safe|unsafe)\s*(?:\n\s*([A-Z0-9, ]+?))?\s*$/i.exec(text);
  return { verdict: g ? (g[1].toLowerCase() as 'safe' | 'unsafe') : null, categories: g?.[2] ? g[2].trim().slice(0, 200) : '' };
}

/**
 * Z0: prod 7 d to 2026-10-01: 3 230 of 4 695 verdicts were http_429 (2 769 from bus-event bursts). After a 429 that
 * outlived the retries, stop calling for CONTENT_SAFETY_429_PAUSE_MS (default 10 min): skipped subjects get no row, so the
 * daily KB sync re-checks them; nothing was ever blocked by this shadow check.
 */
let pausedUntil = 0;
export const resetContentSafetyPause = (): void => { pausedUntil = 0; };

/**
 * P0-11: the row's mode is the regime the verdict is used under, not a fixed label. `acting` = the caller acts on the verdict
 * whatever CONTENT_SAFETY_MODE says (KB ingest quarantines a page on 'unsafe'); a prompt-bound check acts under enforce.
 */
export async function checkContentSafety(db: Database, subject: { type: string; id: string }, text: string, fetchFn: typeof fetch = fetch, promptBound = false, acting = false): Promise<'safe' | 'unsafe' | null> {
  if (!contentSafetyApplies(subject.type, process.env, promptBound) || !text.trim() || Date.now() < pausedUntil) return null;
  const model = process.env.CONTENT_SAFETY_MODEL || 'nvidia/nemotron-3.5-content-safety';
  const started = Date.now();
  const mode = acting || (promptBound && process.env.CONTENT_SAFETY_MODE === 'enforce') ? 'enforce' : 'shadow';
  // prod 2026-09-27: 1 241 of 1 312 KB pages got no verdict and nothing said why; failures are recorded as 'error' now
  const record = (decision: string, reason: string) => {
    db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, latency_ms, model, created_at)
      VALUES (?, 'content_safety', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), subject.type, subject.id,
      createHash('sha256').update(text).digest('hex').slice(0, 16), mode, decision, reason, Date.now() - started, model, new Date().toISOString());
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

/**
 * B19 (Frontier Experts baseline / Evolution Spine): untrusted text that is about to be interpolated into a model prompt
 * (paper abstracts and evidence excerpts, expert claims, discovery titles, KB pages) needs a recorded 'safe' verdict for
 * exactly that text. An earlier verdict (same subject + text hash) is reused, otherwise the text is checked first —
 * prompt-bound text is checked even under CONTENT_SAFETY_SCOPE=decision. Mode = CONTENT_SAFETY_MODE:
 *   unset (default) — no gate, prompts unchanged, no call, no row;
 *   shadow (prod)    — prompts unchanged; what enforce would exclude is recorded ('content_safety_prompt_gate', decision 'no');
 *   enforce          — fail closed: unsafe text AND text without a verdict (429 / timeout / error / no key) is excluded, recorded.
 */
export async function gateUntrustedForPrompt(db: Database, subject: { type: string; id: string }, text: string, fetchFn: typeof fetch = fetch): Promise<{ include: boolean; verdict: 'safe' | 'unsafe' | null }> {
  const mode = process.env.CONTENT_SAFETY_MODE === 'enforce' ? 'enforce' : process.env.CONTENT_SAFETY_MODE === 'shadow' ? 'shadow' : 'off';
  const body = text.slice(0, 4_000);
  if (mode === 'off' || !body.trim()) return { include: true, verdict: null };
  const hash = createHash('sha256').update(body).digest('hex').slice(0, 16);
  const latest = (decisions: string) => db.prepare(`SELECT decision, reason FROM judgments WHERE judgment = 'content_safety' AND subject_type = ? AND subject_id = ? AND state_hash = ?
    AND decision IN (${decisions}) ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(subject.type, subject.id, hash) as { decision: string; reason: string } | undefined;
  const prior = latest("'yes', 'no'");
  const verdict = prior ? (prior.decision === 'yes' ? 'safe' : 'unsafe') : await checkContentSafety(db, subject, body, fetchFn, true);
  if (verdict === 'safe') return { include: true, verdict };
  const reason = `${mode === 'enforce' ? 'excluded' : 'would exclude'}: ${verdict === 'unsafe' ? 'verdict unsafe' : `no safe verdict (${latest("'error'")?.reason.slice(0, 80) ?? 'check unavailable'})`}`;
  try {
    // one row per subject + text + mode + reason: a claim read by every committee job is not recorded every time
    if (!db.prepare("SELECT 1 FROM judgments WHERE judgment = 'content_safety_prompt_gate' AND subject_type = ? AND subject_id = ? AND state_hash = ? AND mode = ? AND reason = ? LIMIT 1").get(subject.type, subject.id, hash, mode, reason)) {
      db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at) VALUES (?, 'content_safety_prompt_gate', ?, ?, ?, ?, 'no', ?, ?)`)
        .run(randomUUID(), subject.type, subject.id, hash, mode, reason, new Date().toISOString());
    }
  } catch { /* recording must not decide inclusion */ }
  return { include: mode !== 'enforce', verdict };
}

/** B19: the items whose untrusted text may enter a prompt (sequential: NVIDIA's free tier 429s on bursts). A gate that throws excludes only under enforce. */
export async function filterForPrompt<T>(db: Database, items: T[], subject: (item: T) => { type: string; id: string }, text: (item: T) => string, fetchFn: typeof fetch = fetch): Promise<T[]> {
  const out: T[] = [];
  for (const item of items) {
    const { include } = await gateUntrustedForPrompt(db, subject(item), text(item), fetchFn).catch(() => ({ include: process.env.CONTENT_SAFETY_MODE !== 'enforce' }));
    if (include) out.push(item);
  }
  return out;
}
