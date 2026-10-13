import { createHash } from 'crypto';
import type { Database } from 'better-sqlite3';
import { modelPriceEntry } from './loop-budget-service';

/**
 * P0 remediation §5: per-maker token accounting on the lease (`metadata.token_accounting`), so cost per verified success
 * per species becomes knowable. Only what the runtime actually reports is recorded — a count it does not report stays null,
 * never 0 and never guessed.
 *
 * Token fields (one meaning for every runtime):
 * - input_tokens: uncached input. codex reports input_tokens *including* cached_input_tokens, so input = input − cached;
 *   opencode (`tokens.input`) and claude (`input_tokens`) already exclude the cache.
 * - cache_read_tokens: opencode cache.read, claude cache_read_input_tokens, codex cached_input_tokens.
 * - cache_write_tokens: opencode cache.write, claude cache_creation_input_tokens; codex does not report it (null).
 * - output_tokens, reasoning_tokens: as reported (codex reasoning is part of its output_tokens).
 * - total_tokens: reported total (opencode), else input + cache read + cache write + output when all reported ones are known.
 *
 * Cost is an estimate from LLM_PRICE_PER_MTOK (UX-18, "model=in/out[/cache_read[/cache_write]]" USD per MTok), only when the
 * model has a price and input and output were reported; otherwise null with the reason. Cache tokens without a cache price
 * leave the cost 'partial' with cost_reason 'cache tokens not priced'. The price used is stored with the cost (per-MTok
 * prices, price_source, price_version = first 16 hex of sha256 of the model's raw entry) so aggregates never mix prices.
 *
 * What each runtime reports (stdout of the maker run):
 * - opencode: `step_finish` events, `part.tokens`, summed over steps (the same events the A4 token brake sums) → provider_reported
 * - codex (`exec --json`): `turn.completed` usage → provider_reported
 * - claude (`--output-format json`): result usage, model from modelUsage → provider_reported
 * - remote: the host returns only a patch and a reason (remote_maker_jobs has no token column) → unavailable
 * - atomic, mock → unavailable; any other runtime: a generic usage object → runtime_log, else unavailable
 * Old leases without the field read as 'unrecorded' (readTokenAccounting).
 */
export type MeasurementSource = 'provider_reported' | 'runtime_log' | 'estimated' | 'unavailable';
export type Completeness = 'complete' | 'partial' | 'none';
export const TOKEN_FIELDS = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens', 'total_tokens'] as const;
export type TokenField = typeof TOKEN_FIELDS[number];

export interface MakerTokenAccounting extends Record<TokenField, number | null> {
  version: 1;
  runtime: string;
  model_id: string | null;
  model_source: 'runtime_reported' | 'lease_config' | null;
  provider: string | null;
  /** server wall clock around the runtime call (always measured when the call returned) */
  duration_ms: number | null;
  retry_count: number;
  estimated_cost_usd: number | null;
  /** 'partial' when cache tokens were not priced; null without a cost */
  cost_completeness: 'complete' | 'partial' | null;
  cost_reason: string | null;
  price_input_per_mtok: number | null;
  price_output_per_mtok: number | null;
  price_cache_read_per_mtok: number | null;
  price_cache_write_per_mtok: number | null;
  price_source: 'LLM_PRICE_PER_MTOK' | null;
  price_version: string | null;
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

type Counts = { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null; reasoning: number | null; total: number | null; model?: string | null };
const EMPTY: Counts = { input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null, total: null };

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const add = (a: number | null, b: number | null): number | null => (b === null ? a : (a ?? 0) + b);
/** input + cache + output, only when in and out are known; unreported cache fields count as absent, not as 0 tokens used */
const sumTotal = (c: Counts): number | null => (c.input !== null && c.output !== null ? c.input + c.output + (c.cacheRead ?? 0) + (c.cacheWrite ?? 0) : null);

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
  let c = EMPTY; let steps = 0;
  for (const e of jsonLines(stdout)) {
    if (e.type !== 'step_finish') continue;
    const t = (e.part ?? e)?.tokens;
    if (!t || typeof t !== 'object') continue;
    steps += 1;
    c = { input: add(c.input, num(t.input)), output: add(c.output, num(t.output)), reasoning: add(c.reasoning, num(t.reasoning)),
      cacheRead: add(c.cacheRead, num(t.cache?.read)), cacheWrite: add(c.cacheWrite, num(t.cache?.write)), total: add(c.total, num(t.total)) };
  }
  return steps ? c : null;
}

function codexCounts(stdout: string): Counts | null {
  let rawInput: number | null = null; let c = EMPTY; let turns = 0;
  for (const e of jsonLines(stdout)) {
    if (e.type !== 'turn.completed' || !e.usage || typeof e.usage !== 'object') continue;
    turns += 1;
    const u = e.usage;
    rawInput = add(rawInput, num(u.input_tokens));
    c = { ...c, output: add(c.output, num(u.output_tokens)), cacheRead: add(c.cacheRead, num(u.cached_input_tokens)), reasoning: add(c.reasoning, num(u.reasoning_output_tokens)) };
  }
  if (!turns) return null;
  const input = rawInput === null ? null : Math.max(0, rawInput - (c.cacheRead ?? 0));
  const out = { ...c, input };
  return { ...out, total: sumTotal(out) };
}

function claudeCounts(stdout: string): Counts | null {
  const result = jsonLines(stdout).reverse().find((e) => e.usage && typeof e.usage === 'object' && (e.type === 'result' || 'total_cost_usd' in e || 'modelUsage' in e));
  if (!result) return null;
  const u = result.usage;
  const models = result.modelUsage && typeof result.modelUsage === 'object' ? Object.keys(result.modelUsage) : [];
  const c: Counts = { input: num(u.input_tokens), output: num(u.output_tokens), cacheRead: num(u.cache_read_input_tokens), cacheWrite: num(u.cache_creation_input_tokens),
    reasoning: null, total: null, model: models.length === 1 ? models[0] : null };
  return { ...c, total: sumTotal(c) };
}

/** Any other runtime: a generic `usage` object in its log; recorded as runtime_log, never as provider_reported. */
function genericCounts(stdout: string): Counts | null {
  for (const e of jsonLines(stdout)) {
    const u = e.usage ?? e.token_usage ?? e.response?.usage;
    if (!u || typeof u !== 'object') continue;
    const input = num(u.prompt_tokens ?? u.input_tokens); const output = num(u.completion_tokens ?? u.output_tokens);
    const total = num(u.total_tokens) ?? (input !== null && output !== null ? input + output : null);
    if (input === null && output === null && total === null) continue;
    return { ...EMPTY, input, output, total };
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

type CostPart = Pick<MakerTokenAccounting, 'estimated_cost_usd' | 'cost_completeness' | 'cost_reason' | 'price_input_per_mtok' | 'price_output_per_mtok'
  | 'price_cache_read_per_mtok' | 'price_cache_write_per_mtok' | 'price_source' | 'price_version'>;
const NO_PRICE = { price_input_per_mtok: null, price_output_per_mtok: null, price_cache_read_per_mtok: null, price_cache_write_per_mtok: null, price_source: null, price_version: null };
const NO_TOKENS = { input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, reasoning_tokens: null, total_tokens: null };

function cost(model: string | null, c: Counts): CostPart {
  const none = (reason: string): CostPart => ({ estimated_cost_usd: null, cost_completeness: null, cost_reason: reason, ...NO_PRICE });
  if (!model) return none('model unknown');
  const p = modelPriceEntry(model);
  if (!p) return none(`no LLM_PRICE_PER_MTOK price for ${model}`);
  if (c.input === null || c.output === null) return none('input/output split not reported');
  let usd = c.input * p.input + c.output * p.output; let unpriced = false;
  for (const [tokens, price] of [[c.cacheRead, p.cache_read], [c.cacheWrite, p.cache_write]] as const) {
    if (!tokens) continue;
    if (price === null) unpriced = true; else usd += tokens * price;
  }
  return { estimated_cost_usd: +(usd / 1_000_000).toFixed(6), cost_completeness: unpriced ? 'partial' : 'complete', cost_reason: unpriced ? 'cache tokens not priced' : null,
    price_input_per_mtok: p.input, price_output_per_mtok: p.output, price_cache_read_per_mtok: p.cache_read, price_cache_write_per_mtok: p.cache_write,
    price_source: 'LLM_PRICE_PER_MTOK', price_version: createHash('sha256').update(p.raw).digest('hex').slice(0, 16) };
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
    return { ...base, ...NO_TOKENS, ...NO_PRICE, estimated_cost_usd: null, cost_completeness: null, cost_reason: 'no token counts', measurement_source: 'unavailable', completeness: 'none',
      reason: UNAVAILABLE[runtime] ?? (counts ? 'usage events carried no token counts' : 'runtime output carried no usage') };
  }
  return { ...base, input_tokens: counts.input, output_tokens: counts.output, cache_read_tokens: counts.cacheRead, cache_write_tokens: counts.cacheWrite,
    reasoning_tokens: counts.reasoning, total_tokens: counts.total, ...cost(model, counts),
    measurement_source: ['opencode', 'codex', 'claude'].includes(runtime) ? 'provider_reported' : 'runtime_log',
    completeness: counts.input !== null && counts.output !== null && counts.total !== null ? 'complete' : 'partial', reason: null };
}

/** Never throws: an accounting failure is recorded as completeness 'none' with the reason and never touches the outcome. */
export function safeTokenAccounting(compute: () => MakerTokenAccounting, runtime: string): MakerTokenAccounting {
  try { return compute(); } catch (err) {
    return { version: 1, runtime, model_id: null, model_source: null, provider: null, ...NO_TOKENS, ...NO_PRICE, duration_ms: null, retry_count: 0,
      estimated_cost_usd: null, cost_completeness: null, cost_reason: 'accounting failed', measurement_source: 'unavailable', completeness: 'none',
      reason: `accounting_error: ${String((err as Error)?.message ?? err).slice(0, 200)}` };
  }
}

/** Leases written before this field existed have no accounting: 'unrecorded', never zero tokens. */
export function readTokenAccounting(metadata: Record<string, unknown> | null | undefined): MakerTokenAccounting | { status: 'unrecorded' } {
  const a = metadata?.token_accounting as MakerTokenAccounting | undefined;
  return a && typeof a === 'object' && a.version === 1 ? a : { status: 'unrecorded' };
}

/** per token field: n = leases that reported it, sum/mean over those only (null when none did) */
export type FieldStat = { n: number; sum: number | null; mean: number | null };
export interface MakerTokenAggregateRow {
  runtime: string; model: string; leases: number; unrecorded: number; tokens_measured: number; tokens_measured_share: number | null;
  cost_known: number; cost_known_share: number | null; cost_partial: number;
  fields: Record<TokenField, FieldStat>;
  /** costs per price version, never summed across versions */
  cost_by_price_version: Array<{ price_version: string; leases: number; partial: number; estimated_cost_usd: number }>;
  by_source: Record<MeasurementSource, number>;
}

/** Read-only aggregate per runtime × model over maker leases created since `since` (fail-soft: no table → empty). */
export function makerTokenAccountingEvidence(db: Database, since: string) {
  let rows: Array<{ runtime: string; metadata: string }> = [];
  try { rows = db.prepare("SELECT runtime, metadata FROM worker_leases WHERE role = 'maker' AND created_at >= ?").all(since) as typeof rows; } catch { rows = []; }
  const groups = new Map<string, MakerTokenAggregateRow & { versions: Map<string, { leases: number; partial: number; usd: number }> }>();
  for (const r of rows) {
    let meta: Record<string, unknown> = {};
    try { meta = JSON.parse(r.metadata || '{}'); } catch { /* unreadable → unrecorded */ }
    const a = readTokenAccounting(meta);
    const model = ('version' in a ? a.model_id : null) ?? (typeof meta.model === 'string' ? meta.model : null) ?? 'unknown';
    const key = `${r.runtime}\u0000${model}`;
    const g = groups.get(key) ?? { runtime: r.runtime, model, leases: 0, unrecorded: 0, tokens_measured: 0, tokens_measured_share: null, cost_known: 0, cost_known_share: null, cost_partial: 0,
      fields: Object.fromEntries(TOKEN_FIELDS.map((f) => [f, { n: 0, sum: null, mean: null }])) as Record<TokenField, FieldStat>,
      cost_by_price_version: [], by_source: { provider_reported: 0, runtime_log: 0, estimated: 0, unavailable: 0 }, versions: new Map() };
    g.leases += 1;
    if (!('version' in a)) g.unrecorded += 1;
    else {
      g.by_source[a.measurement_source] += 1;
      if (a.completeness !== 'none' && a.measurement_source !== 'estimated') {
        g.tokens_measured += 1;
        for (const f of TOKEN_FIELDS) {
          const v = a[f];
          if (typeof v === 'number') { g.fields[f].n += 1; g.fields[f].sum = (g.fields[f].sum ?? 0) + v; }
        }
      }
      if (a.estimated_cost_usd !== null && a.estimated_cost_usd !== undefined) {
        g.cost_known += 1;
        if (a.cost_completeness === 'partial') g.cost_partial += 1;
        const version = a.price_version ?? 'unversioned';
        const v = g.versions.get(version) ?? { leases: 0, partial: 0, usd: 0 };
        v.leases += 1; v.partial += a.cost_completeness === 'partial' ? 1 : 0; v.usd += a.estimated_cost_usd;
        g.versions.set(version, v);
      }
    }
    groups.set(key, g);
  }
  const by_runtime_model: MakerTokenAggregateRow[] = [...groups.values()].map(({ versions, ...g }) => ({ ...g,
    fields: Object.fromEntries(TOKEN_FIELDS.map((f) => [f, { ...g.fields[f], mean: g.fields[f].n ? +((g.fields[f].sum ?? 0) / g.fields[f].n).toFixed(1) : null }])) as Record<TokenField, FieldStat>,
    cost_by_price_version: [...versions.entries()].map(([price_version, v]) => ({ price_version, leases: v.leases, partial: v.partial, estimated_cost_usd: +v.usd.toFixed(6) }))
      .sort((x, y) => x.price_version.localeCompare(y.price_version)),
    tokens_measured_share: g.leases ? +(g.tokens_measured / g.leases).toFixed(3) : null, cost_known_share: g.leases ? +(g.cost_known / g.leases).toFixed(3) : null }))
    .sort((a, b) => a.runtime.localeCompare(b.runtime) || a.model.localeCompare(b.model));
  return { since, leases: rows.length, by_runtime_model,
    note: 'maker leases only; shares are over all leases incl. unrecorded (written before token accounting); per-field n/sum/mean count only leases that reported that field; cost is an estimate from LLM_PRICE_PER_MTOK, reported per price_version, partial when cache tokens are not priced' };
}
