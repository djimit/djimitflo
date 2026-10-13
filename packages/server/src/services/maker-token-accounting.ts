import type { Database } from 'better-sqlite3';
import { modelPrice } from './loop-budget-service';

/**
 * P0 remediation §5: per-maker token accounting on the lease (`metadata.token_accounting`), so cost per verified success
 * per species becomes knowable. Only what the runtime actually reports is recorded — a count it does not report stays null,
 * never 0 and never guessed. Monetary cost is an estimate from LLM_PRICE_PER_MTOK (UX-18) and only when the model has a
 * price and both input and output tokens were reported; otherwise null with the reason.
 *
 * What each runtime reports (stdout of the maker run):
 * - opencode: `step_finish` events, `part.tokens` {input, output, reasoning, cache.read/write, total}, summed over steps
 *   (the same events the A4 token brake sums) → provider_reported
 * - codex (`exec --json`): `turn.completed` usage {input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens}
 * - claude (`--output-format json`): result usage {input_tokens, output_tokens, cache_read_input_tokens, ...}, modelUsage keys
 * - remote: the host returns only a patch and a reason (remote_maker_jobs has no token column) → unavailable
 * - atomic, mock and anything else without a usage object → unavailable
 * Old leases without the field read as 'unrecorded' (readTokenAccounting).
 */
export type MeasurementSource = 'provider_reported' | 'runtime_log' | 'estimated' | 'unavailable';
export type Completeness = 'complete' | 'partial' | 'none';

export interface MakerTokenAccounting {
  version: 1;
  runtime: string;
  model_id: string | null;
  model_source: 'runtime_reported' | 'lease_config' | null;
  provider: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  reasoning_tokens: number | null;
  total_tokens: number | null;
  /** server wall clock around the runtime call (always measured when the call returned) */
  duration_ms: number | null;
  retry_count: number;
  estimated_cost_usd: number | null;
  cost_reason: string | null;
  measurement_source: MeasurementSource;
  completeness: Completeness;
  reason: string | null;
}

export interface TokenAccountingInput {
  runtime: string;
  stdout: string;
  leaseMetadata: Record<string, unknown>;
  durationMs: number | null;
}

type Counts = { input: number | null; output: number | null; cached: number | null; reasoning: number | null; total: number | null; model?: string | null };

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const add = (a: number | null, b: number | null): number | null => (b === null ? a : (a ?? 0) + b);

function jsonLines(stdout: string): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try { const v = JSON.parse(t); if (v && typeof v === 'object') out.push(v); } catch { /* not a JSON line */ }
  }
  return out;
}

function opencodeCounts(stdout: string): Counts | null {
  let c: Counts = { input: null, output: null, cached: null, reasoning: null, total: null }; let steps = 0;
  for (const e of jsonLines(stdout)) {
    if (e.type !== 'step_finish') continue;
    const t = (e.part ?? e)?.tokens;
    if (!t || typeof t !== 'object') continue;
    steps += 1;
    c = { input: add(c.input, num(t.input)), output: add(c.output, num(t.output)), reasoning: add(c.reasoning, num(t.reasoning)),
      cached: add(c.cached, num(t.cache?.read)), total: add(c.total, num(t.total)) };
  }
  return steps ? c : null;
}

function codexCounts(stdout: string): Counts | null {
  let c: Counts = { input: null, output: null, cached: null, reasoning: null, total: null }; let turns = 0;
  for (const e of jsonLines(stdout)) {
    if (e.type !== 'turn.completed' || !e.usage || typeof e.usage !== 'object') continue;
    turns += 1;
    const u = e.usage;
    c = { input: add(c.input, num(u.input_tokens)), output: add(c.output, num(u.output_tokens)), cached: add(c.cached, num(u.cached_input_tokens)),
      reasoning: add(c.reasoning, num(u.reasoning_output_tokens)), total: null };
  }
  if (!turns) return null;
  return { ...c, total: c.input !== null && c.output !== null ? c.input + c.output : null };
}

function claudeCounts(stdout: string): Counts | null {
  const result = jsonLines(stdout).reverse().find((e) => e.usage && typeof e.usage === 'object' && (e.type === 'result' || 'total_cost_usd' in e || 'modelUsage' in e));
  if (!result) return null;
  const u = result.usage;
  const input = num(u.input_tokens); const output = num(u.output_tokens);
  const models = result.modelUsage && typeof result.modelUsage === 'object' ? Object.keys(result.modelUsage) : [];
  return { input, output, cached: add(num(u.cache_read_input_tokens), num(u.cache_creation_input_tokens)), reasoning: null,
    total: input !== null && output !== null ? input + output : null, model: models.length === 1 ? models[0] : null };
}

/** Any other runtime: a generic `usage` object in its log; recorded as runtime_log, never as provider_reported. */
function genericCounts(stdout: string): Counts | null {
  for (const e of jsonLines(stdout)) {
    const u = e.usage ?? e.token_usage ?? e.response?.usage;
    if (!u || typeof u !== 'object') continue;
    const input = num(u.prompt_tokens ?? u.input_tokens); const output = num(u.completion_tokens ?? u.output_tokens);
    const total = num(u.total_tokens) ?? (input !== null && output !== null ? input + output : null);
    if (input === null && output === null && total === null) continue;
    return { input, output, cached: null, reasoning: null, total };
  }
  return null;
}

const UNAVAILABLE: Record<string, string> = {
  remote: 'remote host reports only a patch and a reason; no token counts',
  atomic: 'atomic runtime prints plain text without usage',
  mock: 'mock runtime has no model',
};

function providerOf(runtime: string, model: string | null): string | null {
  if (runtime === 'codex') return 'openai';
  if (runtime === 'claude') return 'anthropic';
  if (runtime === 'opencode' && model?.includes('/')) return model.split('/')[0];
  return null;
}

export function computeTokenAccounting(input: TokenAccountingInput): MakerTokenAccounting {
  const { runtime, stdout, leaseMetadata: meta } = input;
  const configured = typeof meta.model === 'string' && meta.model ? meta.model : null;
  const counts = UNAVAILABLE[runtime] ? null
    : runtime === 'opencode' ? opencodeCounts(stdout)
      : runtime === 'codex' ? codexCounts(stdout)
        : runtime === 'claude' ? claudeCounts(stdout)
          : genericCounts(stdout);
  const reportedModel = counts?.model ?? null;
  const model = reportedModel ?? configured;
  const base = {
    version: 1 as const, runtime, model_id: model, model_source: reportedModel ? 'runtime_reported' as const : configured ? 'lease_config' as const : null,
    provider: providerOf(runtime, model), duration_ms: num(input.durationMs), retry_count: Number(meta.retry_attempt) || 0,
  };
  const measured = counts && [counts.input, counts.output, counts.total].some((v) => v !== null);
  if (!counts || !measured) {
    return { ...base, input_tokens: null, output_tokens: null, cached_tokens: null, reasoning_tokens: null, total_tokens: null,
      estimated_cost_usd: null, cost_reason: 'no token counts', measurement_source: 'unavailable', completeness: 'none',
      reason: UNAVAILABLE[runtime] ?? (counts ? 'usage events carried no token counts' : 'runtime output carried no usage') };
  }
  const price = model ? modelPrice(model) : null;
  const costable = price && counts.input !== null && counts.output !== null;
  return { ...base, input_tokens: counts.input, output_tokens: counts.output, cached_tokens: counts.cached, reasoning_tokens: counts.reasoning,
    total_tokens: counts.total,
    estimated_cost_usd: costable ? +((counts.input! * price.input + counts.output! * price.output) / 1_000_000).toFixed(6) : null,
    cost_reason: costable ? null : !model ? 'model unknown' : !price ? `no LLM_PRICE_PER_MTOK price for ${model}` : 'input/output split not reported',
    measurement_source: ['opencode', 'codex', 'claude'].includes(runtime) ? 'provider_reported' : 'runtime_log',
    completeness: counts.input !== null && counts.output !== null && counts.total !== null ? 'complete' : 'partial', reason: null };
}

/** Never throws: an accounting failure is recorded as completeness 'none' with the reason and never touches the outcome. */
export function safeTokenAccounting(compute: () => MakerTokenAccounting, runtime: string): MakerTokenAccounting {
  try { return compute(); } catch (err) {
    return { version: 1, runtime, model_id: null, model_source: null, provider: null, input_tokens: null, output_tokens: null, cached_tokens: null,
      reasoning_tokens: null, total_tokens: null, duration_ms: null, retry_count: 0, estimated_cost_usd: null, cost_reason: 'accounting failed',
      measurement_source: 'unavailable', completeness: 'none', reason: `accounting_error: ${String((err as Error)?.message ?? err).slice(0, 200)}` };
  }
}

/** Leases written before this field existed have no accounting: 'unrecorded', never zero tokens. */
export function readTokenAccounting(metadata: Record<string, unknown> | null | undefined): MakerTokenAccounting | { status: 'unrecorded' } {
  const a = metadata?.token_accounting as MakerTokenAccounting | undefined;
  return a && typeof a === 'object' && a.version === 1 ? a : { status: 'unrecorded' };
}

export interface MakerTokenAggregateRow {
  runtime: string; model: string; leases: number; unrecorded: number; tokens_measured: number; tokens_measured_share: number | null;
  cost_known: number; cost_known_share: number | null; total_tokens_measured: number; estimated_cost_usd_known: number;
  by_source: Record<MeasurementSource, number>;
}

/** Read-only aggregate per runtime × model over maker leases created since `since` (fail-soft: no table → empty). */
export function makerTokenAccountingEvidence(db: Database, since: string) {
  let rows: Array<{ runtime: string; metadata: string }> = [];
  try { rows = db.prepare("SELECT runtime, metadata FROM worker_leases WHERE role = 'maker' AND created_at >= ?").all(since) as typeof rows; } catch { rows = []; }
  const groups = new Map<string, MakerTokenAggregateRow>();
  for (const r of rows) {
    let meta: Record<string, unknown> = {};
    try { meta = JSON.parse(r.metadata || '{}'); } catch { /* unreadable → unrecorded */ }
    const a = readTokenAccounting(meta);
    const model = ('version' in a ? a.model_id : null) ?? (typeof meta.model === 'string' ? meta.model : null) ?? 'unknown';
    const key = `${r.runtime}\u0000${model}`;
    const g = groups.get(key) ?? { runtime: r.runtime, model, leases: 0, unrecorded: 0, tokens_measured: 0, tokens_measured_share: null, cost_known: 0, cost_known_share: null,
      total_tokens_measured: 0, estimated_cost_usd_known: 0, by_source: { provider_reported: 0, runtime_log: 0, estimated: 0, unavailable: 0 } };
    g.leases += 1;
    if (!('version' in a)) g.unrecorded += 1;
    else {
      g.by_source[a.measurement_source] += 1;
      if (a.completeness !== 'none' && a.measurement_source !== 'estimated') { g.tokens_measured += 1; g.total_tokens_measured += a.total_tokens ?? 0; }
      if (a.estimated_cost_usd !== null) { g.cost_known += 1; g.estimated_cost_usd_known = +(g.estimated_cost_usd_known + a.estimated_cost_usd).toFixed(6); }
    }
    groups.set(key, g);
  }
  const by_runtime_model = [...groups.values()].map((g) => ({ ...g,
    tokens_measured_share: g.leases ? +(g.tokens_measured / g.leases).toFixed(3) : null, cost_known_share: g.leases ? +(g.cost_known / g.leases).toFixed(3) : null }))
    .sort((a, b) => a.runtime.localeCompare(b.runtime) || a.model.localeCompare(b.model));
  return { since, leases: rows.length, by_runtime_model,
    note: 'maker leases only; shares are over all leases incl. unrecorded (written before token accounting); cost is an estimate from LLM_PRICE_PER_MTOK, null without a price' };
}
