import { createHash, randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { recordModelCall } from './model-selector';
import { recordPolicyViolation } from './policy-violations';
import { guardTick, markRun } from './scheduler-registry';

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
 * CONTENT_SAFETY_RATE_LIMIT (calls per minute; unset/invalid = no limit, the old behaviour): every provider call (each
 * chunk, each 429 retry) takes a slot of one process-wide token bucket — burst N, then one per 60/N s, in arrival order
 * (GCRA: `tat` is the theoretical arrival time of the next call). A caller whose slot is more than RATE_QUEUE_MAX_MS away is
 * not queued: its check is recorded as error 'rate_limited (deferred)' (no verdict, never safe) and retried later
 * (retryContentSafetyErrors / kb-sync's pending re-send). Measured prod 09-27..10-05 (nemotron, free tier): after an idle
 * gap 62–94 calls pass before the first 429 (23–61 s); saturated, 574 verdicts in 137 min = 4.2/min. So 4 is the sustained rate.
 * ponytail: per process, not per NVIDIA account; proposal-dedupe embeddings share the account outside this bucket.
 */
const RATE_QUEUE_MAX_MS = 120_000;
let tat = 0;
export const resetContentSafetyRateLimit = (): void => { tat = 0; };
const rateLimit = (env: NodeJS.ProcessEnv): number => { const n = Number(env.CONTENT_SAFETY_RATE_LIMIT); return Number.isFinite(n) && n > 0 ? n : 0; };
/** ms to wait before the call (0 = now), or null = deferred (queue bound exceeded). Reserves the slot. */
export function reserveSafetySlot(env: NodeJS.ProcessEnv = process.env, now = Date.now()): number | null {
  const rate = rateLimit(env);
  if (!rate) return 0;
  const interval = 60_000 / rate;
  const start = Math.max(tat, now);
  const wait = start - Math.max(0, Math.ceil(rate) - 1) * interval - now;
  if (wait > RATE_QUEUE_MAX_MS) return null;
  tat = start + interval;
  return Math.max(0, wait);
}

/**
 * CONTENT_SAFETY_CHUNKING=on (default off = the first 4 000 chars, unchanged): the whole text is checked in 4 000-char windows
 * with a 200-char overlap, at most 8 (30 600 chars); a longer text gets its verdict on the first 8 and `truncated=true`.
 * Unsafe if any window is unsafe; a window without a verdict leaves the whole text without one. Callers hash and check
 * `safetyWindow(text)`: a text of ≤ 4 000 chars keeps its hash (and verdict) when the flag flips; a longer one is unknown
 * until re-checked (KB: kb-sync re-sends it; not served meanwhile).
 */
const WINDOW = 4_000;
const OVERLAP = 200;
const MAX_CHUNKS = 8;
const chunkingOn = (env: NodeJS.ProcessEnv = process.env): boolean => env.CONTENT_SAFETY_CHUNKING === 'on';
export const safetyWindow = (text: string, env: NodeJS.ProcessEnv = process.env): string => (chunkingOn(env) ? text : text.slice(0, WINDOW));
export function safetyChunks(text: string, env: NodeJS.ProcessEnv = process.env): { chunks: string[]; total: number } {
  if (!chunkingOn(env) || text.length <= WINDOW) return { chunks: [text.slice(0, WINDOW)], total: 1 };
  const step = WINDOW - OVERLAP;
  const total = 1 + Math.ceil((text.length - WINDOW) / step);
  return { chunks: Array.from({ length: Math.min(total, MAX_CHUNKS) }, (_, i) => text.slice(i * step, i * step + WINDOW)), total };
}

/**
 * P0-11: the row's mode is the regime the verdict is used under, not a fixed label. `acting` = the caller acts on the verdict
 * whatever CONTENT_SAFETY_MODE says (KB ingest quarantines a page on 'unsafe'); a prompt-bound check acts under enforce.
 */
export async function checkContentSafety(db: Database, subject: { type: string; id: string }, text: string, fetchFn: typeof fetch = fetch, promptBound = false, acting = false): Promise<'safe' | 'unsafe' | null> {
  if (!contentSafetyApplies(subject.type, process.env, promptBound) || !text.trim() || Date.now() < pausedUntil) return null;
  const model = process.env.CONTENT_SAFETY_MODEL || 'nvidia/nemotron-3.5-content-safety';
  const started = Date.now();
  const mode = acting || (promptBound && process.env.CONTENT_SAFETY_MODE === 'enforce') ? 'enforce' : 'shadow';
  const { chunks, total } = safetyChunks(text);
  let sentChars = 0;
  // prod 2026-09-27: 1 241 of 1 312 KB pages got no verdict and nothing said why; failures are recorded as 'error' now
  const record = (decision: string, reason: string) => {
    db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, latency_ms, model, created_at)
      VALUES (?, 'content_safety', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), subject.type, subject.id,
      createHash('sha256').update(text).digest('hex').slice(0, 16), mode, decision, reason, Date.now() - started, model, new Date().toISOString());
    // UX-18: one ledger row per recorded verdict (consumer 'content_safety'); sizes only, never the text
    recordModelCall(db, { consumer: 'content_safety', model, provider: 'nvidia', ok: decision !== 'error', latencyMs: Date.now() - started, outChars: 0, shadow: 0, agree: null,
      tokensIn: Math.ceil((sentChars || chunks[0].length) / 4), taskKind: 'safety', status: reason.slice(0, 80), dataSource: subject.type });
  };
  const rate = rateLimit(process.env);
  // rate limited: each attempt (nvidiaFetch retries included) waits for its slot; the timeout starts when the call does
  const call: typeof fetch = rate ? async (url, init) => {
    const wait = reserveSafetySlot(process.env);
    if (wait === null) throw new Error('rate_limited (deferred)');
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    return fetchFn(url, { ...init, signal: AbortSignal.timeout(60_000) });
  } : fetchFn;
  const ignore = new Set((process.env.CONTENT_SAFETY_IGNORE_CATEGORIES || '').split(/[\s,]+/).filter(Boolean).map((c) => c.toUpperCase()));
  const unsafeCats: string[] = []; const ignoredCats: string[] = []; const ignoredRaw: string[] = [];
  let checked = 0; let unsafe = false;
  try {
    for (const chunk of chunks) {
      if (checked > 0 && Date.now() < pausedUntil) return null; // another check paused mid-text: no verdict, no row
      const res = await nvidiaFetch(`${(process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/$/, '')}/chat/completions`, {
        method: 'POST', signal: AbortSignal.timeout(60_000),
        headers: { Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: chunk }], max_tokens: 60 }),
      }, call);
      sentChars += chunk.length;
      if (res.status === 429) {
        // prod 02-10 07:21Z: a bus burst fired 600+ checks at once; 531 came back 429 after the first one paused → one row, not 531
        if (Date.now() < pausedUntil) return null;
        pausedUntil = Date.now() + (Number(process.env.CONTENT_SAFETY_429_PAUSE_MS) || 600_000);
      }
      if (!res.ok) { record('error', `http_${res.status}${res.status === 429 ? ' (pausing checks)' : ''}`); return null; }
      const body = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      const parsed = parseSafety(body.choices?.[0]?.message?.content ?? '');
      if (!parsed.verdict) { record('error', `unparsed:${JSON.stringify((body.choices?.[0]?.message?.content ?? '').slice(0, 80))}`); return null; }
      checked++;
      // prod 2026-10-31: Llama Guard flags plain technical text S14 (code interpreter abuse) → CONTENT_SAFETY_IGNORE_CATEGORIES=S14
      // makes an 'unsafe' whose categories are ALL ignored count as safe; the categories stay in the reason
      const cats = parsed.categories.split(/[\s,]+/).filter(Boolean).map((c) => c.toUpperCase());
      const ignored = parsed.verdict === 'unsafe' && cats.length > 0 && cats.every((c) => ignore.has(c));
      if (ignored) { ignoredRaw.push(parsed.categories); ignoredCats.push(...cats); }
      if (parsed.verdict === 'unsafe' && !ignored) { unsafe = true; if (parsed.categories) unsafeCats.push(parsed.categories); break; } // one unsafe window decides
    }
    const verdict = unsafe ? 'unsafe' : 'safe'; // reached only when every window answered
    const categories = [...new Set(verdict === 'unsafe' ? unsafeCats : ignoredRaw)].join(',');
    const chunkInfo = chunkingOn() ? ` chunks=${checked}/${total}${total > MAX_CHUNKS ? ' truncated=true' : ''}` : '';
    const ignoredInfo = verdict === 'safe' && ignoredCats.length ? ` ignored=${[...new Set(ignoredCats)].join(',')}` : '';
    record(verdict === 'safe' ? 'yes' : 'no', `verdict=${verdict}${chunkInfo}${categories ? ` categories=${categories}` : ''}${ignoredInfo}`);
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
    try { record('error', (error instanceof Error ? error.message : String(error)).slice(0, 120)); } catch { /* never break the caller */ }
    return null;
  }
}

/** The text a fleet discovery event is checked on (bus ingest and retryContentSafetyErrors: same text, same hash). */
export const discoverySafetyText = (event: Record<string, unknown>): string => [event.title, event.note].filter((v) => typeof v === 'string').join('\n');

/**
 * Persisted retry (with CONTENT_SAFETY_RATE_LIMIT only): prod to 11-07, 3 506 discovery events have only 'error' rows (bus
 * bursts 09-27..10-05) and nothing re-checked them. Each tick re-checks at most `limit` (default one minute of the budget)
 * discovery events whose rows are all errors, least recently failed first, through the same bucket; it stops at the first
 * check without a verdict. KB pages are re-sent by kb-sync (kbPendingSafety); prompt-bound subjects are re-checked on their
 * next prompt (gateUntrustedForPrompt); a social reply's checked text is not stored, so it is not retried.
 */
export async function retryContentSafetyErrors(db: Database, fetchFn: typeof fetch = fetch, limit?: number): Promise<{ checked: number; verdicts: number; reason?: string }> {
  const rate = rateLimit(process.env);
  if (!rate) return { checked: 0, verdicts: 0, reason: 'rate_limit_unset' };
  if (!contentSafetyApplies('external_event')) return { checked: 0, verdicts: 0, reason: contentSafetyEnabled() ? 'scope_excludes_external_event' : 'content_safety_disabled' };
  const due = db.prepare(`SELECT e.id, e.payload FROM judgments j JOIN external_events e ON e.id = j.subject_id
    WHERE j.judgment = 'content_safety' AND j.subject_type = 'external_event' AND j.decision = 'error' AND e.event_type LIKE 'discovery.%'
      AND NOT EXISTS (SELECT 1 FROM judgments v WHERE v.judgment = 'content_safety' AND v.subject_id = j.subject_id AND v.subject_type = 'external_event' AND v.decision IN ('yes', 'no'))
    GROUP BY e.id ORDER BY MAX(j.created_at), e.id LIMIT ?`).all(Math.max(1, Math.floor(limit ?? rate))) as Array<{ id: string; payload: string }>;
  let checked = 0; let verdicts = 0;
  for (const row of due) {
    let event: Record<string, unknown> = {};
    try { event = JSON.parse(row.payload) as Record<string, unknown>; } catch { /* no text: checked as empty, skipped below */ }
    const text = discoverySafetyText(event);
    if (!text.trim()) continue;
    checked++;
    if (!(await checkContentSafety(db, { type: 'external_event', id: row.id }, text, fetchFn))) break;
    verdicts++;
  }
  return { checked, verdicts };
}

/** Scheduler `content_safety_retry` (every 5 min) while CONTENT_SAFETY_RATE_LIMIT is set and content safety is on; null otherwise. */
export const CONTENT_SAFETY_RETRY_INTERVAL_MS = 5 * 60_000;
export function startContentSafetyRetry(db: Database, intervalMs = CONTENT_SAFETY_RETRY_INTERVAL_MS): (() => void) | null {
  if (!rateLimit(process.env) || !contentSafetyEnabled()) return null;
  const tick = guardTick('content_safety_retry', async () => { await retryContentSafetyErrors(db); markRun('content_safety_retry'); });
  const timer = setInterval(tick, intervalMs); timer.unref?.();
  return () => clearInterval(timer);
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
  const body = safetyWindow(text);
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
