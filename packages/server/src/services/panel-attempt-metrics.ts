import type { Database } from 'better-sqlite3';
import { wilson } from './evolution-estimators';
import { reviewFailureKind } from './self-improvement-agent-review-service';

/**
 * E4: attempt-level specialist-panel metrics — operational reliability kept apart from semantic quality. Read-only and
 * derived from stored rows only (never inferred):
 *  - seat attempts (panel store): one automated review with #784 provenance (attempt 1 / 2) or one quarantine row
 *    (validation error text, or 'generation failed: …' once a seat kept failing to generate). Carries model and
 *    prompt_sha256; provider is not recorded on these rows → UNKNOWN.
 *  - model calls (llm_model_calls, consumer 'panel_review'): one ask() incl. its re-ask, with model + provider; written only
 *    when MODEL_SELECTOR_MODE ≠ off, no prompt hash → prompt UNKNOWN, no panel link → no semantic scoring.
 * Model version is recorded nowhere → UNKNOWN. prompt_sha256 hashes the whole rendered prompt (one per panel × seat), so it
 * is not a template fingerprint: the template hash is not recorded (UNKNOWN) and the distinct prompt hashes are counted.
 * Pre-#784 coerced reviews ('Model response could not be parsed' / 'Review generation failed', confidence 0) are their own
 * legacy class and never enter a rate.
 */
export const ATTEMPT_STATES = ['VALID_FIRST_PASS', 'VALID_AFTER_RETRY', 'QUARANTINED', 'GENERATION_FAILED', 'PARSE_FAILED', 'SCHEMA_INVALID',
  'INFRA_FAILED', 'UNKNOWN_FAILURE'] as const;
export type AttemptState = (typeof ATTEMPT_STATES)[number];
/** combined class: ledger rows written before E4 recorded 'invalid' without saying whether parsing or the schema failed */
export const PARSE_OR_SCHEMA = 'PARSE_FAILED|SCHEMA_INVALID';
type StateKey = AttemptState | typeof PARSE_OR_SCHEMA;
const VALID = new Set<StateKey>(['VALID_FIRST_PASS', 'VALID_AFTER_RETRY']);
/** below this many semantically scored valid reviews a quality rate is INSUFFICIENT_EVIDENCE (null), never 0 */
export const MIN_SEMANTIC_N = 10;

type Rate = { value: number | null; ci: [number, number] | null };
export interface SemanticQuality {
  status: 'ok' | 'INSUFFICIENT_EVIDENCE'; value: number | null; ci: [number, number] | null; n_valid: number; n_semantically_scored: number;
  ground_truth: string; circular: boolean;
}
export interface AttemptGroup {
  model: string; model_version: 'UNKNOWN'; prompt_fingerprint: 'UNKNOWN'; prompt_instances: number | null; provider: string;
  n_attempt: number; n_valid: number; n_first_pass: number; n_after_retry: number; n_quarantined: number | null; n_shadow: number | null;
  states: Record<StateKey, number>;
  /** P(valid | model, prompt, provider) */
  reliability: Rate & { n_attempt: number; n_valid: number };
  /** P(valid on the first answer); the re-ask recoveries are n_after_retry, never folded into this */
  first_pass: Rate & { n_attempt: number; n_first_pass: number };
  /** P(correct | valid, …) against the proposal outcome (verified / regressed) — a label the panel does not produce */
  semantic_quality: SemanticQuality;
  /** agreement with the panel's own decision — circular: the decision is aggregated from these same reviews */
  panel_agreement: SemanticQuality;
}
export interface PanelAttemptMetrics {
  window_days: number;
  seat_attempts: { groups: AttemptGroup[]; totals: { n_attempt: number; n_valid: number; n_quarantined: number; states: Record<StateKey, number> } };
  model_calls: { recorded: boolean; groups: AttemptGroup[] };
  legacy: { coerced_unparseable: number; coerced_generation_failed: number; unprovenanced: number };
  /** sources whose query failed (missing table): their counts are unknown, not 0 */
  unreadable: string[];
  note: string;
}

const emptyStates = (): Record<StateKey, number> => Object.fromEntries([...ATTEMPT_STATES, PARSE_OR_SCHEMA].map((s) => [s, 0])) as Record<StateKey, number>;
const rate = (k: number, n: number): Rate => (n > 0 ? { value: +(k / n).toFixed(4), ci: wilson(k, n) } : { value: null, ci: null });
const quality = (correct: number, scored: number, nValid: number, groundTruth: string, circular: boolean): SemanticQuality => {
  const enough = scored >= MIN_SEMANTIC_N;
  return { status: enough ? 'ok' : 'INSUFFICIENT_EVIDENCE', ...(enough ? rate(correct, scored) : { value: null, ci: null }), n_valid: nValid,
    n_semantically_scored: scored, ground_truth: groundTruth, circular };
};

/** The cause of one quarantine row, from the error text the writer stored. Unrecognised text = QUARANTINED (cause unknown). */
export function quarantineState(error: string): AttemptState {
  if (error.startsWith('generation failed: ')) {
    // an empty answer is a generation failure; any other failure to generate is the model call itself throwing (transport/provider)
    return /^generation failed: empty model response/.test(error) ? 'GENERATION_FAILED' : 'INFRA_FAILED';
  }
  const kind = reviewFailureKind(error);
  return kind === 'parse' ? 'PARSE_FAILED' : kind === 'schema' ? 'SCHEMA_INVALID' : 'QUARANTINED';
}

/** One llm_model_calls status of consumer 'panel_review' (see SelfImprovementAgentReviewService.ask). */
export function ledgerState(status: string | null): StateKey {
  switch (status) {
    case 'ok': return 'VALID_FIRST_PASS';
    case 'repaired': return 'VALID_AFTER_RETRY';
    case 'invalid_parse': return 'PARSE_FAILED';
    case 'invalid_schema': return 'SCHEMA_INVALID';
    case 'invalid': return PARSE_OR_SCHEMA;
    case 'empty': return 'GENERATION_FAILED';
    case 'error': return 'INFRA_FAILED';
    default: return 'UNKNOWN_FAILURE';
  }
}

interface Acc { states: Record<StateKey, number>; prompts: Set<string>; quarantined: number; shadow: number;
  outcome: { correct: number; scored: number }; decision: { correct: number; scored: number } }
const acc = (): Acc => ({ states: emptyStates(), prompts: new Set(), quarantined: 0, shadow: 0, outcome: { correct: 0, scored: 0 }, decision: { correct: 0, scored: 0 } });

function group(model: string, provider: string, a: Acc, seat: boolean): AttemptGroup {
  const n = Object.values(a.states).reduce((x, y) => x + y, 0);
  const first = a.states.VALID_FIRST_PASS; const retry = a.states.VALID_AFTER_RETRY;
  const valid = [...VALID].reduce((x, s) => x + a.states[s], 0);
  const noLink = 'no ground truth: ledger rows carry no panel link';
  return {
    model, model_version: 'UNKNOWN', prompt_fingerprint: 'UNKNOWN', prompt_instances: seat ? a.prompts.size : null, provider,
    n_attempt: n, n_valid: valid, n_first_pass: first, n_after_retry: retry, n_quarantined: seat ? a.quarantined : null, n_shadow: seat ? null : a.shadow,
    states: a.states,
    reliability: { ...rate(valid, n), n_attempt: n, n_valid: valid },
    first_pass: { ...rate(first, n), n_attempt: n, n_first_pass: first },
    semantic_quality: quality(a.outcome.correct, a.outcome.scored, valid, seat ? 'proposal_outcome (verified / regressed)' : noLink, false),
    panel_agreement: quality(a.decision.correct, a.decision.scored, valid, seat ? 'panel_decision' : noLink, true),
  };
}

export function panelAttemptMetrics(db: Database, opts: { days?: number; now?: number } = {}): PanelAttemptMetrics {
  const days = opts.days ?? 30;
  const since = new Date((opts.now ?? Date.now()) - days * 86_400_000).toISOString();
  const seats = new Map<string, Acc>();
  const seat = (model: string | null) => { const k = model ?? 'UNKNOWN'; if (!seats.has(k)) seats.set(k, acc()); return seats.get(k) as Acc; };
  const legacy = { coerced_unparseable: 0, coerced_generation_failed: 0, unprovenanced: 0 };
  // a source that cannot be read is named, so its absence never reads as 0 attempts
  const unreadable: string[] = [];
  const safe = <T>(source: string, f: () => T[]): T[] => { try { return f(); } catch { unreadable.push(source); return []; } };

  const reviews = safe('specialist_reviews', () => db.prepare(`SELECT r.model, r.prompt_sha256, r.attempt, r.stance, r.confidence, r.findings_json,
      p.consensus_json, (SELECT s.status FROM self_improvements s WHERE s.panel_id = r.panel_id AND s.status IN ('verified', 'regressed') LIMIT 1) AS outcome
    FROM specialist_reviews r LEFT JOIN specialist_panels p ON p.id = r.panel_id WHERE r.created_at >= ?`).all(since) as Array<{
      model: string | null; prompt_sha256: string | null; attempt: number | null; stance: string; confidence: number; findings_json: string;
      consensus_json: string | null; outcome: string | null }>);
  for (const r of reviews) {
    if (r.attempt !== 1 && r.attempt !== 2) {
      // no #784 provenance: a pre-#784 automated review (coerced failures named apart) or a human review — not an attempt
      if (r.confidence === 0 && r.findings_json.includes('Model response could not be parsed')) legacy.coerced_unparseable++;
      else if (r.confidence === 0 && r.findings_json.includes('Review generation failed')) legacy.coerced_generation_failed++;
      else legacy.unprovenanced++;
      continue;
    }
    const a = seat(r.model);
    a.states[r.attempt === 1 ? 'VALID_FIRST_PASS' : 'VALID_AFTER_RETRY']++;
    if (r.prompt_sha256) a.prompts.add(r.prompt_sha256);
    // only a committed stance can be right or wrong; uncertain / needs_evidence are valid but not scored
    if (r.stance !== 'support' && r.stance !== 'oppose') continue;
    if (r.outcome) { a.outcome.scored++; if ((r.stance === 'support') === (r.outcome === 'verified')) a.outcome.correct++; }
    let decision: unknown = null;
    try { decision = (JSON.parse(r.consensus_json ?? '{}') as { decision?: unknown }).decision; } catch { /* unreadable consensus = unscored */ }
    if (decision === 'goal' || decision === 'backlog' || decision === 'blocked') {
      a.decision.scored++; if ((r.stance === 'support') === (decision !== 'blocked')) a.decision.correct++;
    }
  }
  for (const q of safe('specialist_review_quarantine', () => db.prepare('SELECT model, prompt_sha256, error FROM specialist_review_quarantine WHERE created_at >= ?').all(since) as
    Array<{ model: string | null; prompt_sha256: string | null; error: string }>)) {
    const a = seat(q.model);
    a.states[quarantineState(q.error)]++; a.quarantined++;
    if (q.prompt_sha256) a.prompts.add(q.prompt_sha256);
  }

  const calls = new Map<string, Acc & { model: string; provider: string }>();
  const ledger = safe('llm_model_calls', () => db.prepare(`SELECT model, provider, status, shadow, COUNT(*) AS n FROM llm_model_calls
    WHERE consumer = 'panel_review' AND created_at >= ? GROUP BY 1, 2, 3, 4`).all(since) as Array<{ model: string; provider: string | null; status: string | null; shadow: number; n: number }>);
  for (const l of ledger) {
    const provider = l.provider ?? 'UNKNOWN'; const k = `${l.model}\u0000${provider}`;
    if (!calls.has(k)) calls.set(k, { ...acc(), model: l.model, provider });
    const a = calls.get(k) as Acc;
    a.states[ledgerState(l.status)] += l.n;
    if (l.shadow) a.shadow += l.n;
  }

  const seatGroups = [...seats].map(([model, a]) => group(model, 'UNKNOWN', a, true)).sort((x, y) => y.n_attempt - x.n_attempt);
  const totals = { n_attempt: 0, n_valid: 0, n_quarantined: 0, states: emptyStates() };
  for (const g of seatGroups) {
    totals.n_attempt += g.n_attempt; totals.n_valid += g.n_valid; totals.n_quarantined += g.n_quarantined ?? 0;
    for (const s of Object.keys(g.states) as StateKey[]) totals.states[s] += g.states[s];
  }
  return {
    window_days: days,
    seat_attempts: { groups: seatGroups, totals },
    model_calls: { recorded: ledger.length > 0, groups: [...calls.values()].map((a) => group(a.model, a.provider, a, false)).sort((x, y) => y.n_attempt - x.n_attempt) },
    legacy, unreadable,
    note: 'Reliability = n_valid / n_attempt (Wilson 95 %); first pass and after-retry are counted apart. Seat attempts: provider not recorded (UNKNOWN). '
      + 'Model calls: only with MODEL_SELECTOR_MODE ≠ off; prompt not recorded; error = INFRA_FAILED (the call threw), empty = GENERATION_FAILED; '
      + `'${PARSE_OR_SCHEMA}' = ledger rows from before E4. Model version and prompt template hash are not recorded (UNKNOWN). `
      + `Semantic quality needs ≥ ${MIN_SEMANTIC_N} committed stances (support / oppose) on proposals with a verified / regressed outcome, else INSUFFICIENT_EVIDENCE (null, never 0); `
      + 'proposal outcomes exist only for authorized proposals (selection-biased). panel_agreement is circular. Legacy coerced reviews (pre-#784) are counted apart, never in a rate.',
  };
}
