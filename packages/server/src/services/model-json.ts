import type { Database } from 'better-sqlite3';
import type { ZodType } from 'zod';
import { recordModelCall } from './model-selector';

/**
 * UX-19: one place that turns a model answer into JSON. Models wrap the object in reasoning (<think>…</think>), code
 * fences or prose (prod 06-10: glm-5.3-flash gave a usable panel answer 2/26 times; glm-5.3 narrates on long expert
 * prompts). With LLM_JSON_REPAIR_ENABLED=true an unusable answer gets ONE repair call to the same model; the outcome is
 * recorded in llm_model_calls (status 'repaired' / 'unparseable') so the ledger shows the repair rate. Flag off = no
 * extra call and callers behave exactly as before.
 */
export const jsonRepairEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.LLM_JSON_REPAIR_ENABLED === 'true';

/** The first balanced JSON object in a model answer, after removing <think> blocks (moved from expert-council-service). */
export function firstJsonObject(content: string): Record<string, unknown> | null {
  const text = String(content ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0; let inString = false; let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') inString = false; continue; }
      if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}' && --depth === 0) {
        try { const value = JSON.parse(text.slice(start, i + 1)); if (value && typeof value === 'object' && !Array.isArray(value)) return value; } catch { /* not JSON: try the next "{" */ }
        break;
      }
    }
  }
  return null;
}

/** Strip think tags and code fences, take the first balanced object, validate it. */
export function parseModelJson<T>(text: string, schema: ZodType<T>): T | null {
  const unfenced = String(text ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```(?:json)?/gi, '');
  const candidate = firstJsonObject(unfenced);
  if (!candidate) return null;
  const result = schema.safeParse(candidate);
  return result.success ? result.data : null;
}

/**
 * One repair attempt: show the model its own answer and the shape it must return. Returns the repaired answer TEXT
 * (so callers keep their own normalisation) or null. Never throws; records the outcome when a model name is known.
 */
export async function repairModelJson<T>(opts: {
  db?: Database; consumer: string; model: string | undefined; raw: string; schema: ZodType<T>; shape: string;
  ask: (prompt: string) => Promise<string>; env?: NodeJS.ProcessEnv;
}): Promise<string | null> {
  if (!jsonRepairEnabled(opts.env)) return null;
  const started = Date.now();
  let repaired: string | null = null;
  try {
    const prompt = `Your previous answer was not valid JSON in the required shape. Return ONLY this JSON shape, no prose, no markdown:\n${opts.shape}\n\nYour previous answer:\n${opts.raw.slice(0, 8_000)}`;
    const text = await opts.ask(prompt);
    if (parseModelJson(text, opts.schema)) repaired = text;
  } catch { repaired = null; }
  if (opts.db && opts.model) {
    recordModelCall(opts.db, { consumer: opts.consumer, model: opts.model, ok: repaired !== null, latencyMs: Date.now() - started,
      outChars: repaired?.length ?? 0, shadow: 0, agree: null, status: repaired !== null ? 'repaired' : 'unparseable', taskKind: 'json_repair' });
  }
  return repaired;
}
