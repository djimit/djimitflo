import { createHash } from 'crypto';
import type { Database } from 'better-sqlite3';
import { loopPrSettlements } from './merge-survival';
import { efficiencyView, exclusiveWh, gpuJobs, hostSamples, isLocalModel, leaseConsumer, MIN_ENERGY_COVERAGE, tokenLedger, type EfficiencyView, type Job } from './resource-ledger';

/**
 * Verified efficiency ledger (operator 2026-10-14: "total attributable cost per independently verified successful task").
 * Read-only derivation over the immutable execution records — worker_leases.metadata.runtime_usage, judgments tokens,
 * llm_model_calls rows, host_power_samples — nothing is written, no historical row is rewritten.
 *
 * - Usage events: one per token-consuming record, identity sha256(source|row_id|field), exactly one primary owner (lease,
 *   judgment or model call). Mirror rows (a second record of a cost another record owns) are listed, never counted.
 *   A call shared by several owners (runJudgments R1: one System One call, N judgment rows) is marked shared with its
 *   allocation rule; the split was made at write time, so the members sum to the call and nothing is duplicated.
 * - Every measure carries its coverage; a missing part is UNKNOWN (null), never 0. USD only from a dated price entry with a
 *   source, labelled inferred. Human review minutes are not recorded → UNKNOWN.
 * - Metrics are versioned (id + version + definition hash). A definition change is a new version; the old value is
 *   recomputed and shown next to the new one. Removing a duplicate count is an ACCOUNTING_CORRECTION, never a saving.
 */

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const DAY = 86_400_000;

export interface MetricDef { id: string; version: number; definition: string; hash: string; supersedes?: number; reason?: string }
const def = (id: string, version: number, definition: string, extra: Pick<MetricDef, 'supersedes' | 'reason'> = {}): MetricDef =>
  ({ id, version, definition, hash: sha(`${id}|${version}|${definition}`).slice(0, 16), ...extra });

/** Append-only: change a definition by adding a version (the test pins every hash), never by editing a published one. */
export const METRIC_DEFINITIONS: readonly MetricDef[] = [
  def('efficiency.cloud_tokens', 1, 'Σ worker_leases runtime_usage.total_tokens (runtime ≠ manual, ≠ remote) + Σ llm_model_calls tokens_in + tokens_out (non-local models), every consumer, rows created in the window'),
  def('efficiency.cloud_tokens', 2, 'v1 without llm_model_calls consumer = maker: that row (B29 recordMakerCall, since 2026-10-12) mirrors the maker lease runtime_usage the lease branch already counts',
    { supersedes: 1, reason: 'maker tokens counted twice (lease + its ledger mirror) since 2026-10-12T16:57Z — ACCOUNTING_CORRECTION, not a saving' }),
  def('cost.usage_event', 1, 'One event per token-consuming record created in the window: worker_leases (runtime ≠ manual; field runtime_usage), judgments with input+output tokens > 0 (field tokens), llm_model_calls (field tokens) except mirrors — consumer maker (owner: the lease), consumer jev with tokens (owner: the judgment rows), purpose transport:* (owner: the caller row), attempts = 0 (never sent). id = sha256(source|row_id|field)[0:32]; exactly one primary owner. judgments rows of one runJudgments call (same subject, state_hash, model, tokens, second) are one shared call, split equally at write. Tokens: provider_reported (runtime / provider usage) else UNKNOWN; no estimator exists, so estimated is always null.'),
  def('cost.population', 1, 'The task population is fixed first: self_improvements created in the window. A usage event belongs to a member when its run (lease loop_run → goal.improvement_id, model call run_id) or its judgment subject (self_improvement; loop_run; worker_lease → its run; specialist_panel → self_improvements.panel_id) leads to that member. Every such event in [since, now) counts — unsuccessful, unverified, cancelled and retried attempts and their reviewers included. Events that lead to no member are reported as unattributed, never spread over the population.'),
  def('cost.per_verified_task', 1, 'Σ reconciled tokens of the population (cost.population) ÷ population members with status verified. censored = members not yet in a terminal status (verified, regressed, infra_failed, no_change, archived).'),
  def('cost.per_valid_reviewer_verdict', 1, 'Σ tokens of the population reviewer leases (checker, security_checker) ÷ those leases completed with verdict accepted | needs_revision | rejected.'),
  def('cost.per_merged_pr', 1, 'Σ reconciled tokens of the population ÷ loop PRs of population runs with pr_outcome.state = merged. censored = population PRs still open.'),
  def('cost.per_surviving_pr', 1, 'Σ reconciled tokens of the population ÷ population PRs in SETTLED_SURVIVED (14 d, merge-survival). censored = MERGED_SURVIVAL_PENDING, never a failure.'),
  def('cost.unverified_run_share', 1, 'population tokens on runs whose maker outcome failed (skill_outcomes loop-maker:*, task_id = run, success 0) ÷ population tokens on runs with a maker outcome; window = the same over every run-linked event in the window.'),
  def('cost.reviewer_no_verdict', 1, 'tokens of reviewer leases without a valid verdict (failed, cancelled, or insufficient_evidence): population, and window = every reviewer lease created in the window.'),
];
export type MetricRef = Pick<MetricDef, 'id' | 'version' | 'hash'>;
export function metricRef(id: string, version?: number): MetricRef {
  const all = METRIC_DEFINITIONS.filter((m) => m.id === id && (version === undefined || m.version === version));
  const m = all.sort((a, b) => b.version - a.version)[0];
  if (!m) throw new Error(`unknown metric ${id}@${version ?? 'latest'}`);
  return { id: m.id, version: m.version, hash: m.hash };
}

/** Rows lost in the 2026-10-11 provider snapshot rollback (docs/research/RECOVERY-2026-10-12.md): UNKNOWN, never zero. */
export const LOST_WINDOWS: ReadonlyArray<{ from: string; to: string; ref: string }> = [
  { from: '2026-10-11T04:16:22.715Z', to: '2026-10-12T16:43:39Z', ref: 'docs/research/RECOVERY-2026-10-12.md' },
];

/** USD per million tokens. An entry needs as_of and source; LLM_PRICE_PER_MTOK has neither and is not admitted here. */
export interface PriceEntry { model: string; usd_per_mtok_input: number; usd_per_mtok_output: number; usd_per_mtok_other?: number; as_of: string; source: string }
/** ponytail: empty until an operator adds a dated, sourced list price; flat-subscription marginal 0 is not a price. */
export const PRICE_LIST: readonly PriceEntry[] = [];

export type Source = 'worker_leases' | 'judgments' | 'llm_model_calls';
export interface TokenSplit { input: number | null; output: number | null; other: number | null; total: number }
export interface UsageEvent {
  id: string; source: Source; row_id: string; field: string; at: string; consumer: string;
  role: 'maker' | 'reviewer' | 'other_lease' | 'judgment' | 'server_llm';
  owner: { kind: 'lease' | 'judgment' | 'model_call'; id: string };
  shared: { group: string; members: number; rule: string } | null;
  locality: 'cloud' | 'local'; model: string | null;
  tokens_provider_reported: TokenSplit | null;
  /** no token estimator exists anywhere in the pipeline: always null, kept apart from provider-reported on purpose */
  tokens_estimated: number | null;
  tokens_reconciled: number | null; reconciled_basis: 'provider_reported' | 'estimated' | 'UNKNOWN';
  usd_inferred: number | null;
  run_id: string | null; proposal_id: string | null;
  /** maker outcome of the run (skill_outcomes): true / false, null = no outcome */
  run_verified: boolean | null;
  proposal_verified: boolean | null; pr_merged: boolean | null;
  /** SETTLED_SURVIVED true, SETTLED_REGRESSED false, null = censored / pending / no PR */
  pr_survived: boolean | null;
  /** reviewer leases only: completed with accepted | needs_revision | rejected */
  valid_verdict: boolean | null;
}
export interface Mirror { source: Source; rule: string; rows: number; tokens: number; owner_kind: UsageEvent['owner']['kind'] }

function safeAll<T>(db: Database, sql: string, ...args: unknown[]): T[] { try { return db.prepare(sql).all(...args) as T[]; } catch { return []; } }
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const eventId = (source: Source, rowId: string, field: string) => sha(`${source}|${rowId}|${field}`).slice(0, 32);
const VALID_VERDICTS = new Set(['accepted', 'needs_revision', 'rejected']);
const TERMINAL = new Set(['verified', 'regressed', 'infra_failed', 'no_change', 'archived']);

function priceOf(model: string | null, prices: readonly PriceEntry[]): PriceEntry | null {
  if (!model) return null;
  const base = model.replace(/^ollama[:/]/, '').replace(/:cloud$/, '');
  return prices.find((p) => p.model === model || p.model === base) ?? null;
}
function usdOf(t: TokenSplit | null, p: PriceEntry | null): number | null {
  if (!t || !p || t.input === null || t.output === null) return null;
  if ((t.other ?? 0) > 0 && p.usd_per_mtok_other === undefined) return null;
  return +((t.input * p.usd_per_mtok_input + t.output * p.usd_per_mtok_output + (t.other ?? 0) * (p.usd_per_mtok_other ?? 0)) / 1e6).toFixed(6);
}

export interface UsageOptions { now?: number; prices?: readonly PriceEntry[]; /** v1 source: count the maker ledger mirror as its own event (reproduces the double count) */ includeMakerMirror?: boolean }

/** Every usage event created in [since, until), with its owner and outcome fields, plus the mirror rows left out. */
export function usageEvents(db: Database, since: string, until: string, opts: UsageOptions = {}): { events: UsageEvent[]; mirrors: Mirror[] } {
  const now = opts.now ?? Date.now(); const prices = opts.prices ?? PRICE_LIST;
  const runProposal = new Map(safeAll<{ id: string; p: string | null }>(db, 'SELECT r.id, g.improvement_id AS p FROM loop_runs r LEFT JOIN goals g ON g.id = r.goal_id').map((r) => [r.id, r.p]));
  const proposalStatus = new Map(safeAll<{ id: string; status: string }>(db, 'SELECT id, status FROM self_improvements').map((r) => [r.id, r.status]));
  const runOutcome = new Map(safeAll<{ t: string; ok: number }>(db, `SELECT task_id AS t, MAX(success) AS ok FROM skill_outcomes WHERE skill_id LIKE 'loop-maker:%'
      AND skill_id NOT LIKE 'loop-maker:gym:%' AND skill_id NOT LIKE 'loop-maker:merge:%' AND task_id IS NOT NULL GROUP BY task_id`).map((r) => [r.t, r.ok === 1]));
  const settlements = new Map((() => { try { return loopPrSettlements(db, now); } catch { return []; } })().map((s) => [s.run_id, s]));
  const leaseRun = new Map(safeAll<{ id: string; r: string }>(db, 'SELECT id, loop_run_id AS r FROM worker_leases').map((r) => [r.id, r.r]));
  const panelProposal = new Map(safeAll<{ panel: string; id: string }>(db, 'SELECT panel_id AS panel, id FROM self_improvements WHERE panel_id IS NOT NULL').map((r) => [r.panel, r.id]));
  const outcomeOf = (runId: string | null, proposalId: string | null) => {
    const p = proposalId ?? (runId ? runProposal.get(runId) ?? null : null);
    const st = p ? proposalStatus.get(p) : undefined;
    const s = runId ? settlements.get(runId) : undefined;
    return {
      run_id: runId, proposal_id: p, run_verified: runId && runOutcome.has(runId) ? runOutcome.get(runId)! : null,
      proposal_verified: st === undefined ? null : st === 'verified',
      pr_merged: s ? s.outcome?.state === 'merged' : null,
      pr_survived: s?.settlement.state === 'SETTLED_SURVIVED' ? true : s?.settlement.state === 'SETTLED_REGRESSED' ? false : null,
    };
  };
  const reconcile = (t: TokenSplit | null) => ({ tokens_estimated: null, tokens_reconciled: t ? t.total : null, reconciled_basis: (t ? 'provider_reported' : 'UNKNOWN') as UsageEvent['reconciled_basis'] });
  const events: UsageEvent[] = [];

  // 1. worker leases — the maker / reviewer runtime's own usage report
  for (const l of safeAll<{ id: string; run: string; role: string; runtime: string; status: string; at: string; model: string | null; model_id: string | null; total: unknown; pin: unknown; pout: unknown; verdict: string | null }>(db,
    `SELECT id, loop_run_id AS run, role, runtime, status, created_at AS at, json_extract(metadata, '$.model') AS model, json_extract(metadata, '$.model_id') AS model_id,
      json_extract(metadata, '$.runtime_usage.total_tokens') AS total, json_extract(metadata, '$.runtime_usage.prompt_tokens') AS pin,
      json_extract(metadata, '$.runtime_usage.completion_tokens') AS pout, json_extract(metadata, '$.verdict') AS verdict
     FROM worker_leases WHERE created_at >= ? AND created_at < ? AND runtime != 'manual'`, since, until)) {
    const total = num(l.total); const input = num(l.pin); const output = num(l.pout);
    const t: TokenSplit | null = total !== null && total > 0
      ? { input, output, other: input !== null && output !== null ? Math.max(0, total - input - output) : null, total } : null;
    const reviewer = l.role === 'checker' || l.role === 'security_checker';
    const model = l.model ?? l.model_id;
    events.push({ id: eventId('worker_leases', l.id, 'runtime_usage'), source: 'worker_leases', row_id: l.id, field: 'runtime_usage', at: l.at,
      consumer: leaseConsumer(l.role, l.runtime, l.model), role: l.role === 'maker' ? 'maker' : reviewer ? 'reviewer' : 'other_lease',
      owner: { kind: 'lease', id: l.id }, shared: null, locality: l.runtime === 'remote' ? 'local' : 'cloud', model,
      tokens_provider_reported: t, ...reconcile(t), usd_inferred: usdOf(t, priceOf(model, prices)), ...outcomeOf(l.run, null),
      valid_verdict: reviewer ? l.status === 'completed' && VALID_VERDICTS.has(String(l.verdict)) : null });
  }

  // 2. judgments with tokens (jev System One; @local = the workstation's local shadow)
  const jrows = safeAll<{ id: string; judgment: string; st: string; sid: string; hash: string; model: string | null; tin: number; tout: number; at: string }>(db,
    `SELECT id, judgment, subject_type AS st, subject_id AS sid, state_hash AS hash, model, input_tokens AS tin, output_tokens AS tout, created_at AS at
     FROM judgments WHERE created_at >= ? AND created_at < ? AND COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) > 0`, since, until);
  const groupKey = (j: (typeof jrows)[number]) => `${j.st}|${j.sid}|${j.hash}|${j.model ?? ''}|${j.tin}|${j.tout}|${j.at.slice(0, 19)}`;
  const groupSize = new Map<string, number>();
  for (const j of jrows) groupSize.set(groupKey(j), (groupSize.get(groupKey(j)) ?? 0) + 1);
  for (const j of jrows) {
    const t: TokenSplit = { input: j.tin, output: j.tout, other: 0, total: j.tin + j.tout };
    const members = groupSize.get(groupKey(j)) ?? 1;
    const runId = j.st === 'loop_run' ? j.sid : j.st === 'worker_lease' ? leaseRun.get(j.sid) ?? null : null;
    events.push({ id: eventId('judgments', j.id, 'tokens'), source: 'judgments', row_id: j.id, field: 'tokens', at: j.at, consumer: `judgment:${j.judgment}`, role: 'judgment',
      owner: { kind: 'judgment', id: j.id }, shared: members > 1 ? { group: sha(groupKey(j)).slice(0, 16), members, rule: 'equal_split_at_write (judgment-service runJudgments R1)' } : null,
      locality: j.judgment.endsWith('@local') ? 'local' : 'cloud', model: j.model, tokens_provider_reported: t, ...reconcile(t), usd_inferred: usdOf(t, priceOf(j.model, prices)),
      ...outcomeOf(runId, j.st === 'self_improvement' ? j.sid : j.st === 'specialist_panel' ? panelProposal.get(j.sid) ?? null : null), valid_verdict: null });
  }

  // 3. server-side model calls, minus the rows that mirror a cost another record owns
  const mirrors = new Map<string, Mirror>();
  const mirror = (rule: string, owner: Mirror['owner_kind'], tokens: number) => {
    const m = mirrors.get(rule) ?? { source: 'llm_model_calls' as const, rule, rows: 0, tokens: 0, owner_kind: owner };
    m.rows++; m.tokens += tokens; mirrors.set(rule, m);
  };
  for (const c of safeAll<{ id: number; consumer: string; model: string; provider: string | null; tin: number | null; tout: number | null; run: string | null; purpose: string | null; attempts: number | null; at: string }>(db,
    `SELECT id, consumer, model, provider, tokens_in AS tin, tokens_out AS tout, run_id AS run, purpose, attempts, created_at AS at FROM llm_model_calls WHERE created_at >= ? AND created_at < ?`, since, until)) {
    const known = c.tin !== null || c.tout !== null;
    const tokens = (c.tin ?? 0) + (c.tout ?? 0);
    if (c.consumer === 'maker' && !opts.includeMakerMirror) { mirror('consumer = maker mirrors the maker lease runtime_usage (B29 recordMakerCall)', 'lease', tokens); continue; }
    // O2a: a reviewer row mirrors its checker/security_checker lease (the lease branch above owns the tokens)
    if (c.consumer === 'checker') { mirror('consumer = checker mirrors the reviewer lease runtime_usage (O2a recordWorkerCall)', 'lease', tokens); continue; }
    if (c.consumer === 'jev' && known) { mirror('consumer = jev with tokens mirrors the judgments rows of that System One call', 'judgment', tokens); continue; }
    if (String(c.purpose ?? '').startsWith('transport:')) { mirror('purpose transport:* is the transport row of a caller that records its own row (onUsage)', 'model_call', tokens); continue; }
    if (c.attempts === 0) { mirror('attempts = 0: never sent (breaker_open / queue_full)', 'model_call', tokens); continue; }
    const t: TokenSplit | null = known ? { input: c.tin, output: c.tout, other: 0, total: tokens } : null;
    const rowId = String(c.id);
    events.push({ id: eventId('llm_model_calls', rowId, 'tokens'), source: 'llm_model_calls', row_id: rowId, field: 'tokens', at: c.at, consumer: `llm:${c.consumer}`,
      role: c.consumer === 'maker' ? 'maker' : 'server_llm', owner: { kind: 'model_call', id: rowId }, shared: null,
      locality: isLocalModel(c.provider, c.model) ? 'local' : 'cloud', model: c.model, tokens_provider_reported: t, ...reconcile(t), usd_inferred: usdOf(t, priceOf(c.model, prices)),
      ...outcomeOf(c.run, null), valid_verdict: null });
  }
  return { events, mirrors: [...mirrors.values()] };
}

/** Sum of reconciled tokens over the distinct events (by id) that match — an event is counted at most once per scope. */
export function aggregateScope(events: readonly UsageEvent[], inScope: (e: UsageEvent) => boolean, locality: UsageEvent['locality'] | 'any' = 'cloud'):
  { ids: string[]; events: number; known: number; tokens: number } {
  const seen = new Map<string, UsageEvent>();
  for (const e of events) if (!seen.has(e.id) && (locality === 'any' || e.locality === locality) && inScope(e)) seen.set(e.id, e);
  let tokens = 0; let known = 0;
  for (const e of seen.values()) if (e.tokens_reconciled !== null) { tokens += e.tokens_reconciled; known++; }
  return { ids: [...seen.keys()], events: seen.size, known, tokens };
}

export interface Measure { value: number | null; unit: string; status: 'measured' | 'partial' | 'UNKNOWN'; coverage: number | null; note?: string }
export interface PerUnit { value: number | null; status: 'measured' | 'lower_bound' | 'UNKNOWN'; reason?: string }
const r3 = (x: number) => +x.toFixed(3);
/**
 * Coverage of a token sum: per source, (events with tokens ÷ events) × the source's window coverage; the weakest source
 * wins. Event counts are not comparable across sources (7 k small judgments vs 600 leases), so they are never pooled.
 */
const tokenMeasure = (a: { events: number; known: number; tokens: number }, perSource: Array<{ events: number; known: number; window: number }>): Measure => {
  const parts = perSource.filter((p) => p.events > 0).map((p) => (p.known / p.events) * p.window);
  const coverage = parts.length ? Math.min(...parts) : null;
  return { value: a.known ? a.tokens : null, unit: 'tokens', coverage: coverage === null ? null : r3(coverage),
    status: !a.known ? 'UNKNOWN' : coverage === 1 ? 'measured' : 'partial' };
};
const perUnit = (m: Measure, n: number): PerUnit => {
  if (!n) return { value: null, status: 'UNKNOWN', reason: 'no unit in the cohort' };
  if (m.value === null) return { value: null, status: 'UNKNOWN', reason: m.note ?? 'numerator not measured' };
  return { value: r3(m.value / n), status: m.status === 'measured' ? 'measured' : 'lower_bound', ...(m.status === 'measured' ? {} : { reason: `numerator coverage ${m.coverage}` }) };
};

function overlapMs(since: number, until: number): number {
  return LOST_WINDOWS.reduce((s, w) => s + Math.max(0, Math.min(until, Date.parse(w.to)) - Math.max(since, Date.parse(w.from))), 0);
}
/**
 * Share of [since, until) a source can have recorded, outside the lost windows. llm_model_calls is a ledger that began
 * recording at its first row (UX-18, 2026-10-05): before it, server calls happened unrecorded, so its coverage starts there.
 * Leases and judgments carry their own tokens since they exist; no rows before the first one means no usage, not a gap.
 */
function sourceCoverage(db: Database, table: Source, since: number, until: number): { first_record: string | null; window_coverage: number } {
  const first = safeAll<{ mn: string | null }>(db, `SELECT MIN(created_at) AS mn FROM ${table}`)[0]?.mn ?? null;
  const from = table === 'llm_model_calls' ? Math.max(since, first ? Date.parse(first) : until) : since;
  const span = Math.max(0, until - from) - overlapMs(from, until);
  return { first_record: first, window_coverage: r3(Math.max(0, span) / (until - since)) };
}

export interface ScopeMetric {
  metric: MetricRef; scope: 'task' | 'reviewer' | 'merge' | 'surviving_pr'; definition: string;
  n: number; censored: number | null; censored_reason: string | null;
  numerator: { cloud_tokens: Measure; task_path_cloud_tokens: Measure; local_tokens: Measure; local_gpu_kwh: Measure; review_minutes: Measure; usd: Measure };
  per_unit: { cloud_tokens: PerUnit; task_path_cloud_tokens: PerUnit; local_tokens: PerUnit; local_gpu_kwh: PerUnit; review_minutes: PerUnit; usd: PerUnit };
  /** survivorship-biased contrast: tokens of the successful members' own events only (each event once) — not the metric */
  successful_only: { events: number; cloud_tokens: number; per_unit: number | null };
  /** the same per-unit cloud tokens with the maker ledger mirror counted (the v1 source); delta is an ACCOUNTING_CORRECTION */
  with_duplicate: { cloud_tokens: number; per_unit: number | null; delta_tokens: number; correction: 'ACCOUNTING_CORRECTION' };
}
export interface ShareWindow { value: number | null; numerator_tokens: number; denominator_tokens: number; with_duplicate: number | null }
export interface Share extends ShareWindow { metric: MetricRef; window: ShareWindow; correction: 'ACCOUNTING_CORRECTION'; note: string }
export interface CostPerVerified {
  at: string; window: { since: string; until: string; days: number; lost_windows: typeof LOST_WINDOWS; lost_hours_in_window: number };
  metrics: MetricDef[];
  scopes: ScopeMetric[];
  population: { definition: MetricRef; members: number; verified: number; open: number; runs: number; prs: number; merged: number; surviving: number; survival_pending: number;
    unattributed: { events: number; cloud_tokens: number; note: string } };
  shares: { unverified_run_tokens: Share; reviewer_no_verdict: Share & { leases: number; window: ShareWindow & { leases: number } } };
  by_consumer: Array<{ consumer: string; locality: 'cloud' | 'local'; events: number; events_tokens_known: number; tokens: number; output_split_known: number; coverage: number }>;
  usage: { events: number; by_source: Array<{ source: Source; events: number; events_tokens_known: number; tokens: number; first_record: string | null; window_coverage: number }>;
    mirrors_excluded: Mirror[]; shared_groups: number; shared_events: number; owners: number; sum_over_owners: number; total_tokens: number; owners_sum_equals_total: boolean };
  tool_calls: ToolCallLinkage;
  corrections: Array<{ metric: MetricRef; from: MetricRef; classification: 'ACCOUNTING_CORRECTION'; reason: string; v1_cloud_tokens: number; v2_cloud_tokens: number; delta_tokens: number; note: string }>;
  operational_savings: { verified: never[]; note: string };
  price_list: { entries: number; as_of: string | null; note: string };
  notes: string[];
}

export interface ToolCallLinkage { events: number; linked: number; linked_share: number | null; by_role: Record<string, number>; unlinked: { no_task: number; no_lease_id: number; lease_missing: number }; rule: string }
/**
 * execution_events tool.call → maker / reviewer lease. The engine task id is 'loop-worker-<lease>-<suffix>' and the task's
 * metadata carries lease_id; only that stored link is used (no time-window or path guessing).
 */
export function toolCallLinkage(db: Database, since: string, until: string): ToolCallLinkage {
  const rows = safeAll<{ k: string; n: number }>(db, `SELECT CASE WHEN t.id IS NULL THEN 'no_task' WHEN json_extract(t.metadata, '$.lease_id') IS NULL THEN 'no_lease_id'
      WHEN l.id IS NULL THEN 'lease_missing' ELSE 'linked:' || l.role END AS k, COUNT(*) AS n
    FROM execution_events e LEFT JOIN tasks t ON t.id = e.task_id LEFT JOIN worker_leases l ON l.id = json_extract(t.metadata, '$.lease_id')
    WHERE e.event_type = 'tool.call' AND e.created_at >= ? AND e.created_at < ? GROUP BY 1`, since, until);
  const get = (k: string) => rows.find((r) => r.k === k)?.n ?? 0;
  const by_role = Object.fromEntries(rows.filter((r) => r.k.startsWith('linked:')).map((r) => [r.k.slice(7), r.n]));
  const events = rows.reduce((s, r) => s + r.n, 0); const linked = Object.values(by_role).reduce((s, n) => s + n, 0);
  return { events, linked, linked_share: events ? r3(linked / events) : null, by_role, unlinked: { no_task: get('no_task'), no_lease_id: get('no_lease_id'), lease_missing: get('lease_missing') },
    rule: 'execution_events.task_id → tasks.metadata.lease_id → worker_leases.id (stored link only)' };
}

/** Local GPU energy of task-path jobs (remote makers, committee; gym is R&D), exclusive per host; coverage = sampled / job seconds. */
function taskPathEnergy(db: Database, since: number, until: number): Measure {
  const jobs = gpuJobs(db, new Date(since).toISOString(), new Date(until).toISOString());
  const byHost = new Map<string, Job[]>();
  for (const j of jobs) byHost.set(j.host, [...(byHost.get(j.host) ?? []), j]);
  let wh = 0; let covered = 0; let gpuS = 0;
  for (const [host, hostJobs] of byHost) {
    const e = exclusiveWh(hostSamples(db, host, since, until + DAY), hostJobs); // all jobs split the overlap; only task-path jobs are summed
    hostJobs.forEach((j, k) => { if (j.consumer.startsWith('gym:')) return; wh += e[k].wh; covered += e[k].covered_s; gpuS += (j.end - j.start) / 1000; });
  }
  if (!gpuS) return { value: null, unit: 'kWh', status: 'UNKNOWN', coverage: null, note: 'no task-path local GPU job in the window' };
  const coverage = Math.min(1, covered / gpuS);
  return { value: covered > 0 ? +(wh / 1000).toFixed(4) : null, unit: 'kWh', status: covered === 0 ? 'UNKNOWN' : coverage >= 0.999 ? 'measured' : 'partial', coverage: r3(coverage),
    note: 'GPU package power of the job hosts only; idle host power, VPS CPU and cloud-side energy are UNKNOWN' };
}

export function costPerVerified(db: Database, opts: { now?: number; windowDays?: number; prices?: readonly PriceEntry[] } = {}): CostPerVerified {
  const now = opts.now ?? Date.now(); const days = opts.windowDays ?? 30;
  const sinceMs = now - days * DAY; const since = new Date(sinceMs).toISOString(); const until = new Date(now).toISOString();
  const prices = opts.prices ?? PRICE_LIST;
  const { events, mirrors } = usageEvents(db, since, until, { now, prices });
  const dup = usageEvents(db, since, until, { now, prices, includeMakerMirror: true }).events;
  const lostMs = overlapMs(sinceMs, now);
  const bySource = (['worker_leases', 'judgments', 'llm_model_calls'] as const).map((source) => {
    const a = aggregateScope(events, (e) => e.source === source, 'any');
    return { source, events: a.events, events_tokens_known: a.known, tokens: a.tokens, ...sourceCoverage(db, source, sinceMs, now) };
  });
  const sourceCov = new Map(bySource.map((s) => [s.source, s.window_coverage]));
  const measureTokens = (pred: (e: UsageEvent) => boolean, locality: UsageEvent['locality'] = 'cloud'): Measure =>
    tokenMeasure(aggregateScope(events, pred, locality), bySource.map((src) => {
      const a = aggregateScope(events, (e) => pred(e) && e.source === src.source, locality);
      return { events: a.events, known: a.known, window: sourceCov.get(src.source) ?? 0 };
    }));

  // the population is fixed first; numerators are everything it consumed, denominators its verified / merged / surviving members
  const population = new Map(safeAll<{ id: string; status: string }>(db, 'SELECT id, status FROM self_improvements WHERE created_at >= ? AND created_at < ?', since, until).map((r) => [r.id, r.status]));
  const inPop = (e: UsageEvent) => e.proposal_id !== null && population.has(e.proposal_id);
  const verified = [...population].filter(([, st]) => st === 'verified').map(([id]) => id);
  const openMembers = [...population.values()].filter((st) => !TERMINAL.has(st)).length;
  const runProposal = new Map(safeAll<{ id: string; p: string | null }>(db, 'SELECT r.id, g.improvement_id AS p FROM loop_runs r LEFT JOIN goals g ON g.id = r.goal_id').map((r) => [r.id, r.p]));
  const prs = (() => { try { return loopPrSettlements(db, now); } catch { return []; } })().filter((s) => population.has(runProposal.get(s.run_id) ?? ''));
  const merged = prs.filter((s) => s.outcome?.state === 'merged');
  const mergedRuns = new Set(merged.map((s) => s.run_id));
  const survivedRuns = new Set(merged.filter((s) => s.settlement.state === 'SETTLED_SURVIVED').map((s) => s.run_id));
  const pendingSurvival = merged.filter((s) => s.settlement.state === 'MERGED_SURVIVAL_PENDING').length;
  const openPrs = prs.filter((s) => s.settlement.state === 'OPEN_BLOCKED' && !s.settlement.terminal).length;
  const popReviewer = (e: UsageEvent) => inPop(e) && e.role === 'reviewer';
  const validVerdicts = aggregateScope(events, (e) => popReviewer(e) && e.valid_verdict === true, 'any').events;

  const energy = taskPathEnergy(db, sinceMs, now);
  const unknown = (unit: string, note: string): Measure => ({ value: null, unit, status: 'UNKNOWN', coverage: 0, note });
  const reviewMinutes = unknown('minutes', 'human review / merge time is not recorded (pr_outcome.review_latency_h is wall-clock latency, not effort)');
  const usdMeasure = (pred: (e: UsageEvent) => boolean): Measure => {
    const sel = events.filter((e) => pred(e) && e.tokens_reconciled !== null);
    const priced = sel.filter((e) => e.usd_inferred !== null);
    const tok = sel.reduce((s, e) => s + (e.tokens_reconciled ?? 0), 0); const ptok = priced.reduce((s, e) => s + (e.tokens_reconciled ?? 0), 0);
    if (!priced.length) return unknown('USD', prices.length ? 'no event matches a dated price entry' : 'no dated, sourced price entry (PRICE_LIST is empty; LLM_PRICE_PER_MTOK has no date or source)');
    return { value: +priced.reduce((s, e) => s + (e.usd_inferred ?? 0), 0).toFixed(4), unit: 'USD (inferred, list price)', status: ptok === tok ? 'measured' : 'partial', coverage: tok ? r3(ptok / tok) : null,
      note: 'inferred from list prices, not a provider bill' };
  };

  const scope = (s: ScopeMetric['scope'], metricId: string, n: number, censored: number | null, censoredReason: string | null, numeratorPred: (e: UsageEvent) => boolean,
    successPred: (e: UsageEvent) => boolean): ScopeMetric => {
    const ref = metricRef(metricId);
    const cloud = measureTokens(numeratorPred);
    const taskPred = (e: UsageEvent) => numeratorPred(e) && e.source === 'worker_leases';
    const taskPath = measureTokens(taskPred);
    const local = measureTokens(numeratorPred, 'local');
    if (local.value === null) local.note = 'no local usage event reported tokens (remote / atomic runtimes do not report usage)';
    const kwh: Measure = s === 'reviewer' ? unknown('kWh', 'reviewers run on cloud runtimes; their energy is not measured')
      : { ...energy, note: [energy.note, 'window-wide: the GPU job to population link is not stored'].filter(Boolean).join('; ') };
    const usd = usdMeasure(numeratorPred);
    const success = aggregateScope(events, (e) => numeratorPred(e) && successPred(e));
    const withDup = aggregateScope(dup, numeratorPred);
    const kwhUnit: PerUnit = kwh.value === null || kwh.coverage === null || kwh.coverage < MIN_ENERGY_COVERAGE
      ? { value: null, status: 'UNKNOWN', reason: kwh.value === null ? kwh.note ?? 'not measured' : `INSUFFICIENT_EVIDENCE: job energy coverage ${kwh.coverage} < ${MIN_ENERGY_COVERAGE}` }
      : perUnit(kwh, n);
    return {
      metric: ref, scope: s, definition: METRIC_DEFINITIONS.find((m) => m.id === ref.id && m.version === ref.version)!.definition, n, censored, censored_reason: censoredReason,
      numerator: { cloud_tokens: cloud, task_path_cloud_tokens: taskPath, local_tokens: local, local_gpu_kwh: kwh, review_minutes: reviewMinutes, usd },
      per_unit: { cloud_tokens: perUnit(cloud, n), task_path_cloud_tokens: perUnit(taskPath, n), local_tokens: perUnit(local, n), local_gpu_kwh: kwhUnit,
        review_minutes: perUnit(reviewMinutes, n), usd: perUnit(usd, n) },
      successful_only: { events: success.events, cloud_tokens: success.tokens, per_unit: n ? r3(success.tokens / n) : null },
      with_duplicate: { cloud_tokens: withDup.tokens, per_unit: n ? r3(withDup.tokens / n) : null, delta_tokens: withDup.tokens - (cloud.value ?? 0), correction: 'ACCOUNTING_CORRECTION' },
    };
  };
  const scopes = [
    scope('task', 'cost.per_verified_task', verified.length, openMembers, openMembers ? 'population members not yet in a terminal status' : null, inPop,
      (e) => e.proposal_id !== null && population.get(e.proposal_id) === 'verified'),
    scope('reviewer', 'cost.per_valid_reviewer_verdict', validVerdicts, null, null, popReviewer, (e) => e.valid_verdict === true),
    scope('merge', 'cost.per_merged_pr', mergedRuns.size, openPrs, openPrs ? 'population PRs still open (not merged, not closed): outcome pending' : null, inPop, (e) => e.run_id !== null && mergedRuns.has(e.run_id)),
    scope('surviving_pr', 'cost.per_surviving_pr', survivedRuns.size, pendingSurvival, pendingSurvival ? 'merged PRs inside the 14-day survival window (MERGED_SURVIVAL_PENDING)' : null, inPop,
      (e) => e.run_id !== null && survivedRuns.has(e.run_id)),
  ];
  const unattributed = aggregateScope(events, (e) => !inPop(e));

  const ratio = (evs: readonly UsageEvent[], den: (e: UsageEvent) => boolean, num: (e: UsageEvent) => boolean) => {
    const d = aggregateScope(evs, den).tokens; const n = aggregateScope(evs, (e) => den(e) && num(e));
    return { value: d ? r3(n.tokens / d) : null, n: n.tokens, d, events: n.events };
  };
  const runLinked = (e: UsageEvent) => e.run_id !== null && e.run_verified !== null;
  const failedRun = (e: UsageEvent) => e.run_verified === false;
  const noVerdict = (e: UsageEvent) => e.valid_verdict === false;
  const isReviewer = (e: UsageEvent) => e.role === 'reviewer';
  const unv = ratio(events, (e) => inPop(e) && runLinked(e), failedRun); const unvW = ratio(events, runLinked, failedRun);
  const unvDup = ratio(dup, (e) => inPop(e) && runLinked(e), failedRun); const unvWDup = ratio(dup, runLinked, failedRun);
  const nv = ratio(events, popReviewer, noVerdict); const nvW = ratio(events, isReviewer, noVerdict);
  const nvDup = ratio(dup, popReviewer, noVerdict); const nvWDup = ratio(dup, isReviewer, noVerdict);

  const consumers = new Map<string, CostPerVerified['by_consumer'][number]>();
  for (const e of events) {
    const k = `${e.consumer}|${e.locality}`;
    const c = consumers.get(k) ?? { consumer: e.consumer, locality: e.locality, events: 0, events_tokens_known: 0, tokens: 0, output_split_known: 0, coverage: 0 };
    c.events++;
    if (e.tokens_reconciled !== null) { c.events_tokens_known++; c.tokens += e.tokens_reconciled; }
    if (e.tokens_provider_reported?.output !== null && e.tokens_provider_reported?.output !== undefined) c.output_split_known++;
    c.coverage = r3(c.events_tokens_known / c.events);
    consumers.set(k, c);
  }
  const owners = new Map<string, number>();
  for (const e of events) owners.set(`${e.owner.kind}:${e.owner.id}`, (owners.get(`${e.owner.kind}:${e.owner.id}`) ?? 0) + (e.tokens_reconciled ?? 0));
  const total = events.reduce((s, e) => s + (e.tokens_reconciled ?? 0), 0);
  const sumOwners = [...owners.values()].reduce((s, n) => s + n, 0);
  const groups = new Set(events.filter((e) => e.shared).map((e) => e.shared!.group));

  const v1 = tokenLedger(db, since, until, 1).reduce((s, t) => s + t.cloud, 0); const v2 = tokenLedger(db, since, until, 2).reduce((s, t) => s + t.cloud, 0);
  const dated = prices.map((p) => p.as_of).sort();
  return {
    at: until, window: { since, until, days, lost_windows: LOST_WINDOWS, lost_hours_in_window: r3(lostMs / 3_600_000) },
    metrics: [...METRIC_DEFINITIONS],
    scopes,
    population: { definition: metricRef('cost.population'), members: population.size, verified: verified.length, open: openMembers,
      runs: new Set(events.filter(inPop).map((e) => e.run_id).filter(Boolean)).size, prs: prs.length, merged: mergedRuns.size, surviving: survivedRuns.size, survival_pending: pendingSurvival,
      unattributed: { events: unattributed.events, cloud_tokens: unattributed.tokens,
        note: 'usage in the window that leads to no population member (residents, unlinked panel / server calls, runs of older proposals); reported, never spread' } },
    shares: {
      unverified_run_tokens: { metric: metricRef('cost.unverified_run_share'), value: unv.value, numerator_tokens: unv.n, denominator_tokens: unv.d, with_duplicate: unvDup.value,
        window: { value: unvW.value, numerator_tokens: unvW.n, denominator_tokens: unvW.d, with_duplicate: unvWDup.value }, correction: 'ACCOUNTING_CORRECTION',
        note: 'run-linked events only (leases; model calls with run_id); runs without a maker outcome are left out, never counted as verified' },
      reviewer_no_verdict: { metric: metricRef('cost.reviewer_no_verdict'), value: nv.value, numerator_tokens: nv.n, denominator_tokens: nv.d, with_duplicate: nvDup.value, leases: nv.events,
        window: { value: nvW.value, numerator_tokens: nvW.n, denominator_tokens: nvW.d, with_duplicate: nvWDup.value, leases: nvW.events }, correction: 'ACCOUNTING_CORRECTION',
        note: 'reviewer leases failed, cancelled or insufficient_evidence; value = share of reviewer tokens, numerator_tokens = the spend (the maker mirror never touches reviewers)' },
    },
    by_consumer: [...consumers.values()].sort((a, b) => b.tokens - a.tokens || a.consumer.localeCompare(b.consumer)),
    usage: { events: events.length, by_source: bySource, mirrors_excluded: mirrors, shared_groups: groups.size, shared_events: events.filter((e) => e.shared).length,
      owners: owners.size, sum_over_owners: sumOwners, total_tokens: total, owners_sum_equals_total: sumOwners === total },
    tool_calls: toolCallLinkage(db, since, until),
    corrections: [{ metric: metricRef('efficiency.cloud_tokens', 2), from: metricRef('efficiency.cloud_tokens', 1), classification: 'ACCOUNTING_CORRECTION',
      reason: METRIC_DEFINITIONS.find((m) => m.id === 'efficiency.cloud_tokens' && m.version === 2)!.reason!, v1_cloud_tokens: v1, v2_cloud_tokens: v2, delta_tokens: v1 - v2,
      note: 'the duplicate was a counting error in the efficiency view; no token was saved, so it is not an efficiency improvement' }],
    operational_savings: { verified: [], note: 'no cost-reduction mechanism has a verified effect; accounting corrections are never listed here' },
    price_list: { entries: prices.length, as_of: dated.length ? dated[dated.length - 1] : null, note: 'USD only from dated, sourced list prices, labelled inferred' },
    notes: [
      'Read-only: derived from worker_leases, judgments, llm_model_calls, host_power_samples, merge settlements; no row is written or rewritten.',
      'Coverage = per source, events with provider-reported tokens ÷ events × the source window coverage (ledger start, lost windows); the weakest source wins. UNKNOWN is null, never 0.',
      'Opencode lease totals include cache reads/writes: tokens_provider_reported.other = total − prompt − completion (unsplit until maker token accounting).',
      'Population first (cost.population): numerators are everything the population consumed, failed and retried attempts included; successful_only is the survivorship-biased contrast, not the metric. Per-unit values under partial coverage are lower bounds.',
    ],
  };
}

/** GET /api/health/efficiency: the efficiency view plus the verified cost ledger over the same window. */
export function efficiencyWithCost(db: Database, now = Date.now(), env: NodeJS.ProcessEnv = process.env, windowDays = 7): EfficiencyView & { cost_per_verified: CostPerVerified } {
  return { ...efficiencyView(db, now, env, windowDays), cost_per_verified: costPerVerified(db, { now, windowDays }) };
}
