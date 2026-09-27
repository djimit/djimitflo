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
  try {
    const res = await fetchFn(`${(process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: text.slice(0, 4_000) }], max_tokens: 60 }),
    });
    if (!res.ok) return null;
    const body = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const { verdict, categories } = parseSafety(body.choices?.[0]?.message?.content ?? '');
    if (!verdict) return null;
    db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, latency_ms, model, created_at)
      VALUES (?, 'content_safety', ?, ?, ?, 'shadow', ?, ?, ?, ?, ?)`).run(randomUUID(), subject.type, subject.id,
      createHash('sha256').update(text).digest('hex').slice(0, 16), verdict === 'safe' ? 'yes' : 'no',
      `verdict=${verdict}${categories ? ` categories=${categories}` : ''}`, Date.now() - started, model, new Date().toISOString());
    return verdict;
  } catch { return null; }
}
