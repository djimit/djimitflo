import type { Database } from 'better-sqlite3';
import { AuditEventType, RiskLevel } from '@djimitflo/shared';
import { AuditService } from './audit-service';
import { guardTick } from './scheduler-registry';
import { ollamaUsage7d } from './inference-budget';
import { randomUUID } from 'node:crypto';

/**
 * OLLAMA_AUTO_FAILOVER (off|on, operator 18-10): Ollama Cloud's weekly usage limit answered every call with an HTTP error
 * ("you (<account>) have reached your weekly usage limit, add usage credits") until the operator set
 * OLLAMA_OUTAGE_FALLBACK_RUNTIME=claude by hand. On: any Ollama call whose error matches the weekly/session usage-limit
 * shape — the panel and every other generateText caller (llm-fallback), an opencode lease's stderr — records
 * 'ollama_limited' in system_state (survives restarts) with detected_at and the error class; while it holds,
 * applyOutageFallback acts as if OLLAMA_OUTAGE_FALLBACK_RUNTIME=claude (the manual flag still wins). A probe every 30 min
 * (one tiny call on the cheapest model) clears it when it succeeds. Transitions are audit events
 * (inference_ollama_limited / inference_ollama_recovered); stall-watch detector 'inference_limited' reports the state.
 * Off: nothing recorded, nothing read — identical behaviour.
 */
export type AutoFailoverMode = 'off' | 'on';
export const autoFailoverMode = (env: NodeJS.ProcessEnv = process.env): AutoFailoverMode =>
  env.OLLAMA_AUTO_FAILOVER?.trim().toLowerCase() === 'on' ? 'on' : 'off';

/** PANEL_FALLBACK_RUNTIME (off|claude): specialist panel reviews on the Claude Code CLI (subscription) while Ollama is limited. */
export const panelFallbackRuntime = (env: NodeJS.ProcessEnv = process.env): 'claude' | null =>
  env.PANEL_FALLBACK_RUNTIME?.trim().toLowerCase() === 'claude' ? 'claude' : null;
export const panelFallbackModel = (env: NodeJS.ProcessEnv = process.env): string => env.PANEL_FALLBACK_MODEL?.trim() || 'haiku';
/** Provenance model prefix of a fallback review ('claude:<model>'); panel calibration leaves such reviews out. */
export const PANEL_FALLBACK_PREFIX = 'claude:';
/** SQL: the specialist review (alias) is not a PANEL_FALLBACK_RUNTIME review. */
export const notPanelFallbackReviewSql = (alias: string): string => `COALESCE(${alias}.model, '') NOT LIKE '${PANEL_FALLBACK_PREFIX}%'`;

/** Any flag that needs the usage-limit shape surfaced from an Ollama HTTP error. */
export const limitWatching = (env: NodeJS.ProcessEnv = process.env): boolean => autoFailoverMode(env) === 'on' || panelFallbackRuntime(env) !== null;

export type LimitClass = 'weekly' | 'session' | 'daily' | 'hourly' | 'monthly' | 'usage';
const LIMIT_SHAPE = /\[ollama_usage_limit:(\w+)\]|\b(weekly|session|daily|hourly|monthly)\s+usage\s+limit\b|reached your (?:(weekly|session|daily|hourly|monthly) )?usage limit|add usage credits/i;
const CLASSES = new Set<string>(['weekly', 'session', 'daily', 'hourly', 'monthly', 'usage']);
/** The Ollama Cloud usage-limit error class in a call's error text / CLI output, else null. */
export function ollamaLimitClass(text: string | null | undefined): LimitClass | null {
  const m = String(text ?? '').match(LIMIT_SHAPE);
  if (!m) return null;
  const cls = (m[1] || m[2] || m[3])?.toLowerCase();
  return cls && CLASSES.has(cls) ? cls as LimitClass : 'usage';
}
/** Marker appended to an Ollama HTTP error that matched the limit shape (limitWatching on), e.g. `[ollama_usage_limit:weekly]`. */
export const limitMarker = (cls: LimitClass): string => `[ollama_usage_limit:${cls}]`;

export interface OllamaLimitState {
  state: 'ollama_limited'; detected_at: string; error_class: LimitClass; source: string; excerpt: string;
  last_probe_at?: string; last_probe_result?: string;
}
const KEY = 'inference_ollama_state';
const ensure = (db: Database): void => {
  db.exec("CREATE TABLE IF NOT EXISTS system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))");
};
const write = (db: Database, s: OllamaLimitState, at: string): void => {
  ensure(db);
  db.prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(KEY, JSON.stringify(s), at);
};
const audit = (db: Database, action: string, metadata: Record<string, unknown>): void => {
  try {
    new AuditService(db).record({ event_type: AuditEventType.CONFIG_CHANGED, action, resource_type: 'inference_provider', resource_id: 'ollama',
      risk_level: RiskLevel.MEDIUM, metadata });
  } catch { /* the state is persisted either way */ }
};

/** The persisted limited state (null = not limited, or the table / row is missing or unreadable). */
export function readOllamaLimit(db: Database): OllamaLimitState | null {
  try {
    const row = db.prepare('SELECT value FROM system_state WHERE key = ?').get(KEY) as { value: string } | undefined;
    const s = row ? JSON.parse(row.value) as OllamaLimitState : null;
    return s?.state === 'ollama_limited' ? s : null;
  } catch { return null; }
}

/** OLLAMA_AUTO_FAILOVER on and the limited state holds. */
export const ollamaLimited = (db: Database | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean =>
  autoFailoverMode(env) === 'on' && Boolean(db) && readOllamaLimit(db!) !== null;

/**
 * An Ollama call's error text / CLI output. Matching the usage-limit shape with OLLAMA_AUTO_FAILOVER on records the
 * limited state (first detection = transition event; later ones keep the original detected_at). Returns the class, or null.
 */
export function noteOllamaOutput(db: Database | null | undefined, text: string | null | undefined, source: string, env: NodeJS.ProcessEnv = process.env, now = new Date()): LimitClass | null {
  const cls = ollamaLimitClass(text);
  if (!cls || !db || autoFailoverMode(env) !== 'on') return cls;
  try {
    if (readOllamaLimit(db)) return cls;
    const at = now.toISOString();
    const s: OllamaLimitState = { state: 'ollama_limited', detected_at: at, error_class: cls, source: source.slice(0, 80),
      excerpt: String(text).match(LIMIT_SHAPE)?.[0].slice(0, 120) ?? cls };
    write(db, s, at);
    audit(db, 'inference_ollama_limited', { ...s });
    recordLimitCalibration(db, s, now);
    console.warn(`🛑 inference: Ollama usage limit (${cls}) detected via ${s.source}; opencode leases fail over to claude until the probe succeeds`);
  } catch { /* detection never breaks the call it watches */ }
  return cls;
}

/**
 * Operator 18-10: the rolling 7-d Ollama token total at the moment the limit hit, as judgment 'ollama_limit_calibration'
 * (annotation), so OLLAMA_WEEKLY_TOKEN_BUDGET can be set from real data. Fail-soft (no judgments table → nothing).
 */
export function recordLimitCalibration(db: Database, s: OllamaLimitState, now = new Date()): void {
  try {
    const usage = ollamaUsage7d(db, now.getTime());
    db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
      VALUES (?, 'ollama_limit_calibration', 'inference_provider', 'ollama', ?, 'annotation', 'limit_hit', ?, ?, ?)`)
      .run(randomUUID(), `${s.error_class}:${s.detected_at}`, `Ollama ${s.error_class} usage limit via ${s.source}; 7-d Ollama tokens ${usage.total_tokens ?? 'unknown'}`.slice(0, 300),
        JSON.stringify({ ...usage, error_class: s.error_class, source: s.source, detected_at: s.detected_at }), now.toISOString());
  } catch { /* judgments table absent */ }
}

/** Clear the limited state (probe success). Returns false when nothing was limited. */
export function clearOllamaLimit(db: Database, reason: string, now = new Date()): boolean {
  const before = readOllamaLimit(db);
  if (!before) return false;
  db.prepare('DELETE FROM system_state WHERE key = ?').run(KEY);
  audit(db, 'inference_ollama_recovered', { reason, limited_since: before.detected_at, error_class: before.error_class, recovered_at: now.toISOString() });
  console.log(`✅ inference: Ollama recovered (${reason}); limited since ${before.detected_at}`);
  return true;
}

export const PROBE_INTERVAL_MS = 30 * 60_000;
/** The cheapest model by MODEL_COST_WEIGHTS (default glm-5.3-flash), as an Ollama Cloud name; OLLAMA_FAILOVER_PROBE_MODEL overrides. */
export function probeModel(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OLLAMA_FAILOVER_PROBE_MODEL?.trim()) return env.OLLAMA_FAILOVER_PROBE_MODEL.trim();
  const pairs = (env.MODEL_COST_WEIGHTS || 'kimi-k3=4,glm-5.3=2,glm-5.3-flash=1').split(',').map((p) => p.split('=').map((s) => s.trim()))
    .filter(([name, w]) => name && Number.isFinite(Number(w)) && Number(w) > 0).sort((a, b) => Number(a[1]) - Number(b[1]));
  const name = pairs[0]?.[0] || 'glm-5.3-flash';
  return name.includes(':') ? name : `${name}:cloud`;
}
export type ProbeCall = (model: string) => Promise<string>;
const defaultProbeCall: ProbeCall = async (model) => {
  const { generateText, llmEndpoints } = await import('./llm-fallback.js'); // lazy: llm-fallback imports this module
  // primary only: a configured fallback host answering says nothing about Ollama Cloud's quota
  return generateText({ prompt: 'Reply with {"ok":true}', model, maxTokens: 8, timeoutMs: 30_000, purpose: 'inference_failover:probe' },
    { endpoints: llmEndpoints(process.env.OLLAMA_URL || 'https://ollama.com', {}) });
};

/** One probe while limited: success clears the state; failure keeps it (last_probe_at / result recorded). */
export async function probeOllama(db: Database, call: ProbeCall = defaultProbeCall, env: NodeJS.ProcessEnv = process.env, now = () => new Date()): Promise<'skipped' | 'cleared' | 'still_limited'> {
  const s = autoFailoverMode(env) === 'on' ? readOllamaLimit(db) : null;
  if (!s) return 'skipped';
  try {
    await call(probeModel(env));
    clearOllamaLimit(db, `probe ${probeModel(env)} succeeded`, now());
    return 'cleared';
  } catch (err) {
    const current = readOllamaLimit(db);
    if (current) write(db, { ...current, last_probe_at: now().toISOString(), last_probe_result: (err instanceof Error ? err.message : String(err)).slice(0, 160) }, now().toISOString());
    return 'still_limited';
  }
}

/** The 30-min probe (scheduler 'inference_failover_probe'); a tick without a limited state does nothing. */
export function startOllamaProbe(db: Database, intervalMs = PROBE_INTERVAL_MS, env: NodeJS.ProcessEnv = process.env): (() => void) | null {
  if (autoFailoverMode(env) !== 'on') return null;
  const timer = setInterval(guardTick('inference_failover_probe', () => probeOllama(db)), intervalMs); timer.unref?.();
  return () => clearInterval(timer);
}

/** Evidence (under `inference.failover`): mode, the persisted state, transitions in the window (null = audit table missing). */
export function autoFailoverEvidence(db: Database, since: string, env: NodeJS.ProcessEnv = process.env) {
  let transitions: Array<{ action: string; n: number }> | null = null;
  try {
    transitions = db.prepare(`SELECT action, COUNT(*) AS n FROM audit_events WHERE action IN ('inference_ollama_limited', 'inference_ollama_recovered')
      AND timestamp >= ? GROUP BY action`).all(since) as Array<{ action: string; n: number }>;
  } catch { transitions = null; }
  return { mode: autoFailoverMode(env), state: autoFailoverMode(env) === 'on' ? readOllamaLimit(db) : null, probe_model: probeModel(env), transitions };
}
