import { createHash } from 'crypto';
import type { Database } from 'better-sqlite3';

export type CampaignEvidenceStatus = 'SUPPORTED' | 'FALSIFIED' | 'UNDETERMINED';
export type CampaignStatus = 'RUNNING' | 'AWAITING_ASSURANCE' | CampaignEvidenceStatus;

interface CampaignState {
  schema: 'djimit.social-learning-campaign.v1';
  campaign_id: string;
  status: CampaignStatus;
  started_at: string;
  ends_at: string;
  minimum_pairs: number;
  manifest: Record<string, unknown>;
  latest_report_hash: string | null;
  updated_at: string;
}

interface SocialRow {
  id: string;
  from_agent: string;
  to_agent: string;
  status: string;
  timestamp: string;
  payload: Record<string, unknown>;
  params: Record<string, unknown>;
  answer: string;
  evidence: string[];
}

interface InternalPair {
  thread_id: string;
  agent_id: string;
  peer_agent_id: string;
  baseline: SocialRow;
  peer: SocialRow;
  learning: SocialRow;
  reflection_id: string | null;
  reflection_status: string | null;
  reflection_metadata: Record<string, unknown>;
  metrics: {
    peer_uptake_delta: number;
    content_novelty: number;
    evidence_retention: number;
    field_completeness: number;
    explicit_correction_signal: number;
    repetition_risk: number;
  };
}

interface MetricSummary {
  n: number;
  mean: number | null;
  median: number | null;
  variance: number | null;
  confidence_low: number | null;
  confidence_high: number | null;
}

interface WorldLabEvidence {
  schema: 'openmythos.worldlab.social-learning-replay.v1';
  campaign_id: string;
  status: 'PASS' | 'FAIL' | 'UNDETERMINED';
  source_commit: string;
  input_report_hash: string;
  trajectories: number;
  failures: string[];
  causal_claim_supported: boolean;
  interpretation: string;
  evidence_hash: string;
}

export interface CampaignReport {
  schema: 'djimit.social-learning-campaign.report.v1';
  campaign_id: string;
  generated_at: string;
  observation_window: { start: string; end: string; complete: boolean };
  status: CampaignStatus;
  pairs: Array<Record<string, unknown>>;
  metrics: Record<string, MetricSummary>;
  signals: {
    peer_learning: CampaignEvidenceStatus;
    operational_outcome_lift: CampaignEvidenceStatus;
    causal_support: boolean;
  };
  independent_checker: {
    status: 'PASS' | 'FAIL' | 'UNDETERMINED';
    scope: 'structural_only';
    content_truth: 'UNDETERMINED';
    violations: string[];
  };
  worldlab: WorldLabEvidence | null;
  outcome_evidence: { matched: number; causal: number; metric: MetricSummary };
  promotion: { allowed: false; reason: string };
  limitations: string[];
  evidence_hash: string;
  report_hash: string;
  goal_batch: Record<string, unknown> | null;
}

const ACTIVE_KEY = 'social_learning_campaign:active';
const CAUSAL_STATUSES = new Set(['causal', 'randomized', 'experimentally_supported', 'counterfactual_supported']);
const CORRECTION = /\b(correct(?:ed|ion)?|revis(?:e|ed|ion)|wrong|onjuist|corrige(?:er|erde|ren)|herzien)\b/iu;
const STOPWORDS = new Set(['the', 'and', 'for', 'that', 'with', 'this', 'from', 'een', 'het', 'de', 'van', 'voor', 'met', 'dat', 'die']);

export class SocialLearningCampaignService {
  constructor(private readonly db: Database) {}

  start(input: { campaign_id: string; started_at: string; days?: number; minimum_pairs?: number; runtime_commit: string; analyzer_commit: string }): { duplicate: boolean; state: CampaignState; manifest_hash: string } {
    const campaignId = this.required(input.campaign_id, 'SOCIAL_CAMPAIGN_ID_REQUIRED');
    if (!/^[a-z0-9][a-z0-9._:-]{2,127}$/i.test(campaignId)) throw new Error('SOCIAL_CAMPAIGN_ID_INVALID');
    const startedAt = this.timestamp(input.started_at);
    const days = this.integer(input.days ?? 7, 1, 31, 'SOCIAL_CAMPAIGN_DAYS_INVALID');
    const minimumPairs = this.integer(input.minimum_pairs ?? 30, 2, 10_000, 'SOCIAL_CAMPAIGN_MINIMUM_PAIRS_INVALID');
    const existing = this.state();
    if (existing?.campaign_id === campaignId) return { duplicate: true, state: existing, manifest_hash: this.hash(existing.manifest) };
    if (existing && ['RUNNING', 'AWAITING_ASSURANCE'].includes(existing.status)) throw new Error('SOCIAL_CAMPAIGN_ACTIVE');

    const endsAt = new Date(Date.parse(startedAt) + days * 86_400_000).toISOString();
    const pilot = this.db.prepare(`
      SELECT COUNT(DISTINCT json_extract(payload_json, '$.thread_id')) AS threads,
             SUM(CASE WHEN json_extract(payload_json, '$.action') = 'social.response' THEN 1 ELSE 0 END) AS responses,
             SUM(CASE WHEN json_extract(payload_json, '$.action') = 'social.learning' THEN 1 ELSE 0 END) AS learnings
      FROM agent_messages WHERE timestamp < ? AND json_extract(payload_json, '$.action') LIKE 'social.%'
    `).get(startedAt) as { threads?: number; responses?: number; learnings?: number };
    const manifest: Record<string, unknown> = {
      schema: 'djimit.social-learning-campaign.manifest.v1', campaign_id: campaignId, phase: 'CONFIRMATORY',
      research_question: 'Does evidence-linked peer feedback improve the quality and downstream outcomes of isolated agent learning?',
      hypothesis: 'Peer exposure increases evidence retention and peer uptake without increasing repetition risk, and supported learnings improve independently measured outcomes.',
      null_hypothesis: 'Peer exposure produces no operationally meaningful improvement over each agent\'s pre-feedback proposal.',
      started_at: startedAt, ends_at: endsAt, minimum_pairs: minimumPairs,
      unit_of_analysis: 'paired agent proposal and post-peer-feedback learning within one social thread',
      independent_variables: ['peer feedback exposure'],
      dependent_variables: ['peer uptake delta', 'content novelty', 'evidence retention', 'repetition risk', 'linked operational outcome lift'],
      controls: ['same thread', 'same agent', 'same topic', 'pre-feedback proposal'],
      confounders: ['fixed ordering', 'topic drift', 'model updates', 'runtime retries', 'mandatory response fields'],
      randomization: 'none; paired observational design with WorldLab counterfactual replay',
      stopping_condition: `seven days and at least ${minimumPairs} complete pairs`,
      falsification: 'peer-uptake 95% interval does not exceed +0.05, or linked causal outcome evidence does not improve',
      analysis_method: 'pre-registered paired vector metrics with deterministic bootstrap intervals; no aggregate score',
      promotion_policy: 'HOLD unless peer signal, causal outcome evidence, structural checker and WorldLab evidence are all supported',
      pilot_excluded_before: startedAt,
      pilot_snapshot: { threads: Number(pilot.threads || 0), responses: Number(pilot.responses || 0), learnings: Number(pilot.learnings || 0) },
      provenance: { runtime_commit: this.commit(input.runtime_commit, 'SOCIAL_CAMPAIGN_RUNTIME_COMMIT_REQUIRED'), analyzer_commit: this.commit(input.analyzer_commit, 'SOCIAL_CAMPAIGN_ANALYZER_COMMIT_REQUIRED') },
    };
    const now = new Date().toISOString();
    const state: CampaignState = { schema: 'djimit.social-learning-campaign.v1', campaign_id: campaignId, status: 'RUNNING', started_at: startedAt, ends_at: endsAt, minimum_pairs: minimumPairs, manifest, latest_report_hash: null, updated_at: now };
    const manifestHash = this.hash(manifest);
    this.db.transaction(() => {
      this.saveState(state);
      this.event(campaignId, 'social.campaign.started', startedAt, 1, { manifest_hash: manifestHash, minimum_pairs: minimumPairs, ends_at: endsAt });
    })();
    return { duplicate: false, state, manifest_hash: manifestHash };
  }

  tick(input: { observed_at: string; worldlab?: unknown }): CampaignReport {
    const state = this.state();
    if (!state) throw new Error('SOCIAL_CAMPAIGN_NOT_STARTED');
    const observedAt = this.timestamp(input.observed_at);
    if (Date.parse(observedAt) < Date.parse(state.started_at)) throw new Error('SOCIAL_CAMPAIGN_OBSERVATION_BEFORE_START');
    const complete = Date.parse(observedAt) >= Date.parse(state.ends_at);
    const windowEnd = complete ? state.ends_at : observedAt;
    const pairs = this.pairs(state.started_at, windowEnd);
    this.addRepetitionRisk(pairs);
    const metrics = Object.fromEntries((['peer_uptake_delta', 'content_novelty', 'evidence_retention', 'field_completeness', 'explicit_correction_signal', 'repetition_risk'] as const)
      .map(metric => [metric, this.summarize(pairs.map(pair => pair.metrics[metric]), `${state.campaign_id}:${metric}`)]));
    const peerSignal = this.classify(metrics.peer_uptake_delta, state.minimum_pairs, 0.05);
    const checker = this.check(pairs);
    const outcome = this.outcomeEvidence(pairs, state.started_at, windowEnd, state.minimum_pairs);
    const worldlab = this.worldlab(input.worldlab, state.campaign_id, state.latest_report_hash);
    let status: CampaignStatus = 'RUNNING';
    if (complete && !worldlab) status = 'AWAITING_ASSURANCE';
    else if (complete) {
      status = peerSignal === 'FALSIFIED' || outcome.status === 'FALSIFIED' || checker.status === 'FAIL' || worldlab?.status === 'FAIL'
        ? 'FALSIFIED'
        : peerSignal === 'SUPPORTED' && outcome.status === 'SUPPORTED' && checker.status === 'PASS' && worldlab?.status === 'PASS' && worldlab.causal_claim_supported
          ? 'SUPPORTED' : 'UNDETERMINED';
    }
    const publicPairs = pairs.map(pair => this.publicPair(pair));
    const evidenceHash = `sha256:${this.hash({ campaign_id: state.campaign_id, observation_window: { start: state.started_at, end: windowEnd }, pairs: publicPairs, metrics, peerSignal, checker, outcome, worldlab })}`;
    const goalBatch = status === 'SUPPORTED' ? this.goalBatch(state, evidenceHash, metrics, outcome, worldlab!) : null;
    const generatedAt = complete ? state.ends_at : observedAt;
    const core = {
      schema: 'djimit.social-learning-campaign.report.v1' as const, campaign_id: state.campaign_id, generated_at: generatedAt,
      observation_window: { start: state.started_at, end: windowEnd, complete }, status,
      pairs: publicPairs, metrics,
      signals: { peer_learning: peerSignal, operational_outcome_lift: outcome.status, causal_support: outcome.causal },
      independent_checker: checker, worldlab,
      outcome_evidence: { matched: outcome.matched, causal: outcome.causalCount, metric: outcome.metric },
      promotion: { allowed: false as const, reason: status === 'SUPPORTED' ? 'supported evidence may create a review-gated goal batch; promotion still requires approval' : 'evidence is not fully supported' },
      limitations: ['Paired ordering is observational, not randomized.', 'Text-overlap metrics diagnose uptake and repetition but do not establish truth.', 'Structural checker independence does not establish content correctness.', 'No operational claim is supported without linked causal outcome events.'],
      evidence_hash: evidenceHash, goal_batch: goalBatch,
    };
    const report: CampaignReport = { ...core, report_hash: `sha256:${this.hash(core)}` };
    const nextState: CampaignState = { ...state, status, latest_report_hash: report.report_hash, updated_at: observedAt };
    const day = Math.max(0, Math.floor((Date.parse(windowEnd) - Date.parse(state.started_at)) / 86_400_000));
    this.db.transaction(() => {
      this.saveState(nextState);
      this.event(state.campaign_id, complete && worldlab ? 'social.campaign.finalized' : 'social.campaign.observed', observedAt,
        complete && worldlab ? 10_000 : day + 2,
        { report_hash: report.report_hash, status, pairs: pairs.length, peer_signal: peerSignal, outcome_signal: outcome.status, checker: checker.status, worldlab: worldlab?.status || 'UNDETERMINED' });
    })();
    return report;
  }

  getState(): CampaignState | null { return this.state(); }

  private pairs(start: string, end: string): InternalPair[] {
    const rows = (this.db.prepare(`
      SELECT id, from_agent, to_agent, status, timestamp, payload_json FROM agent_messages
      WHERE timestamp >= ? AND timestamp <= ?
        AND json_extract(payload_json, '$.action') IN ('social.response', 'social.learning')
      ORDER BY timestamp, id
    `).all(start, end) as Array<Record<string, unknown>>).map(row => this.socialRow(row));
    const responses = rows.filter(row => row.payload.action === 'social.response');
    const learnings = rows.filter(row => row.payload.action === 'social.learning');
    const reflections = new Map((this.db.prepare("SELECT id, source_ref, status, metadata FROM reflection_candidates WHERE source_type = 'trace' AND source_ref LIKE 'message:%'").all() as Array<Record<string, unknown>>)
      .map(row => [String(row.source_ref).slice(8), { id: String(row.id), status: String(row.status), metadata: this.object(row.metadata) }]));
    const result: InternalPair[] = [];
    for (const learning of learnings) {
      const threadId = this.string(learning.payload.thread_id);
      if (!threadId) continue;
      const baseline = responses.find(row => row.from_agent === learning.from_agent && row.payload.thread_id === threadId);
      const peer = responses.find(row => row.from_agent === learning.to_agent && row.payload.thread_id === threadId);
      if (!baseline || !peer) continue;
      const reflection = reflections.get(learning.id);
      const inputEvidence = new Set(peer.evidence);
      const retained = learning.evidence.filter(ref => inputEvidence.has(ref)).length;
      const fields = ['uncertainty', 'falsifiable_next_step', 'creative_alternative', 'stop_condition'];
      result.push({
        thread_id: threadId, agent_id: learning.from_agent, peer_agent_id: learning.to_agent,
        baseline, peer, learning, reflection_id: reflection?.id || null, reflection_status: reflection?.status || null,
        reflection_metadata: reflection?.metadata || {},
        metrics: {
          peer_uptake_delta: this.jaccard(learning.answer, peer.answer) - this.jaccard(baseline.answer, peer.answer),
          content_novelty: 1 - this.jaccard(learning.answer, baseline.answer),
          evidence_retention: inputEvidence.size ? retained / inputEvidence.size : 0,
          field_completeness: fields.filter(field => this.string(learning.params[field])).length / fields.length,
          explicit_correction_signal: CORRECTION.test(learning.answer) ? 1 : 0,
          repetition_risk: 0,
        },
      });
    }
    return result;
  }

  private addRepetitionRisk(pairs: InternalPair[]): void {
    for (let index = 0; index < pairs.length; index += 1) {
      const previous = pairs.slice(0, index).filter(pair => pair.agent_id === pairs[index].agent_id);
      pairs[index].metrics.repetition_risk = previous.length ? Math.max(...previous.map(pair => this.jaccard(pairs[index].learning.answer, pair.learning.answer))) : 0;
    }
  }

  private check(pairs: InternalPair[]): CampaignReport['independent_checker'] {
    const violations: string[] = [];
    for (const pair of pairs) {
      const prefix = `${pair.thread_id}:${pair.agent_id}`;
      if (pair.agent_id === pair.peer_agent_id) violations.push(`${prefix}:self_peer`);
      if (pair.baseline.status !== 'read' || pair.learning.status !== 'read') violations.push(`${prefix}:message_not_read`);
      if (pair.learning.params.effect_scope !== 'isolated' || pair.learning.params.external_side_effects !== false) violations.push(`${prefix}:containment_failed`);
      if (!this.string(pair.learning.params.runtime) || !this.string(pair.learning.params.model_id)) violations.push(`${prefix}:runtime_provenance_missing`);
      if (!pair.reflection_id) violations.push(`${prefix}:reflection_missing`);
      if (pair.reflection_metadata.promotion_allowed !== false || pair.reflection_metadata.empirical_status !== 'UNDETERMINED') violations.push(`${prefix}:promotion_hold_failed`);
    }
    return { status: pairs.length === 0 ? 'UNDETERMINED' : violations.length ? 'FAIL' : 'PASS', scope: 'structural_only', content_truth: 'UNDETERMINED', violations };
  }

  private outcomeEvidence(pairs: InternalPair[], start: string, end: string, minimum: number): { matched: number; causalCount: number; causal: boolean; status: CampaignEvidenceStatus; metric: MetricSummary } {
    const candidates = new Set(pairs.map(pair => pair.reflection_id).filter((value): value is string => Boolean(value)));
    const deltas: number[] = [];
    let causalCount = 0;
    const rows = this.db.prepare("SELECT payload FROM external_events WHERE event_type = 'outcome.observed' AND occurred_at >= ? AND occurred_at <= ?").all(start, end) as Array<{ payload: string }>;
    for (const row of rows) {
      const payload = this.object(row.payload);
      if (!candidates.has(this.string(payload.candidate_id)) && !candidates.has(this.string(payload.subject_id))) continue;
      const value = Number(payload.value); const baseline = Number(payload.baseline);
      if (!Number.isFinite(value) || !Number.isFinite(baseline)) continue;
      const direction = this.string(payload.direction);
      deltas.push(direction === 'decrease' ? baseline - value : direction === 'maintain' ? -Math.abs(value - baseline) : value - baseline);
      if (CAUSAL_STATUSES.has(this.string(payload.causal_status))) causalCount += 1;
    }
    const metric = this.summarize(deltas, `outcome:${start}:${end}`);
    const causal = deltas.length > 0 && causalCount === deltas.length;
    const status = !causal ? 'UNDETERMINED' : this.classify(metric, minimum, 0);
    return { matched: deltas.length, causalCount, causal, status, metric };
  }

  private classify(metric: MetricSummary, minimum: number, effect: number): CampaignEvidenceStatus {
    if (metric.n < minimum || metric.confidence_low === null || metric.confidence_high === null) return 'UNDETERMINED';
    if (metric.confidence_low > effect) return 'SUPPORTED';
    if (metric.confidence_high <= effect) return 'FALSIFIED';
    return 'UNDETERMINED';
  }

  private summarize(values: number[], seed: string): MetricSummary {
    if (!values.length) return { n: 0, mean: null, median: null, variance: null, confidence_low: null, confidence_high: null };
    const sorted = [...values].sort((a, b) => a - b);
    const mean = this.mean(values);
    const variance = values.length > 1 ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1) : 0;
    if (values.length === 1) return { n: 1, mean, median: values[0], variance, confidence_low: values[0], confidence_high: values[0] };
    let state = Number.parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16) >>> 0;
    const random = (): number => { state = (1664525 * state + 1013904223) >>> 0; return state / 0x1_0000_0000; };
    const samples = Array.from({ length: 2_000 }, () => this.mean(Array.from({ length: values.length }, () => values[Math.floor(random() * values.length)]))).sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    return { n: values.length, mean, median, variance, confidence_low: samples[Math.floor(samples.length * 0.025)], confidence_high: samples[Math.floor(samples.length * 0.975)] };
  }

  private publicPair(pair: InternalPair): Record<string, unknown> {
    return {
      thread_id: pair.thread_id, agent_id: pair.agent_id, peer_agent_id: pair.peer_agent_id,
      baseline_message_id: pair.baseline.id, peer_message_id: pair.peer.id, learning_message_id: pair.learning.id,
      reflection_id: pair.reflection_id,
      baseline_hash: `sha256:${this.hash(pair.baseline.answer)}`, peer_hash: `sha256:${this.hash(pair.peer.answer)}`, learning_hash: `sha256:${this.hash(pair.learning.answer)}`,
      runtime: this.string(pair.learning.params.runtime), model_id: this.string(pair.learning.params.model_id),
      effect_scope: this.string(pair.learning.params.effect_scope), metrics: pair.metrics,
    };
  }

  private goalBatch(state: CampaignState, evidenceHash: string, metrics: Record<string, MetricSummary>, outcome: { metric: MetricSummary }, worldlab: WorldLabEvidence): Record<string, unknown> {
    return {
      schema: 'djimit.openmythos.worldlab.goal.v1', campaign_id: state.campaign_id,
      source: { experiment_id: state.campaign_id, evidence_hash: evidenceHash, worldlab_evidence_hash: worldlab.evidence_hash },
      finding: { failure_mode: 'social_learning_outcome_lift', severity: 'medium', confidence: 0.95, status: 'SUPPORTED' },
      waves: [{ wave_id: 'review-supported-social-learning', ordered_goals: [{ key: `review-${state.campaign_id}`, objective: 'Review the supported social-learning intervention without automatic promotion', risk_class: 'medium', constraints: ['preserve ToolBroker mediation', 'no automatic learning promotion'], acceptance_criteria: ['independent human review', 'targeted WorldLab regression', 'static OpenMythos gates'], falsification_tests: ['peer-learning lower bound <= 0.05', 'causal outcome lower bound <= 0'], recommended_loop: 'maker-checker-approver', metadata: { promotion_eligible: false, peer_metric: metrics.peer_uptake_delta, outcome_metric: outcome.metric } }] }],
    };
  }

  private worldlab(value: unknown, campaignId: string, expectedInputHash: string | null): WorldLabEvidence | null {
    if (value === undefined || value === null) return null;
    const input = value as Partial<WorldLabEvidence>;
    const valid = input.schema === 'openmythos.worldlab.social-learning-replay.v1'
      && input.campaign_id === campaignId
      && ['PASS', 'FAIL', 'UNDETERMINED'].includes(String(input.status))
      && /^[0-9a-f]{40}$/i.test(this.string(input.source_commit))
      && /^sha256:[0-9a-f]{64}$/i.test(this.string(input.evidence_hash))
      && (!expectedInputHash || input.input_report_hash === expectedInputHash)
      && Number.isInteger(input.trajectories) && Number(input.trajectories) >= 0
      && Array.isArray(input.failures) && input.failures.every(value => typeof value === 'string')
      && typeof input.causal_claim_supported === 'boolean' && Boolean(this.string(input.interpretation));
    if (!valid) throw new Error('SOCIAL_CAMPAIGN_WORLDLAB_EVIDENCE_INVALID');
    const core = { schema: input.schema, campaign_id: input.campaign_id, status: input.status, source_commit: input.source_commit, input_report_hash: input.input_report_hash, trajectories: input.trajectories, failures: input.failures, causal_claim_supported: input.causal_claim_supported, interpretation: input.interpretation };
    if (input.evidence_hash !== `sha256:${this.hash(core)}`) throw new Error('SOCIAL_CAMPAIGN_WORLDLAB_EVIDENCE_HASH_INVALID');
    return input as WorldLabEvidence;
  }

  private socialRow(row: Record<string, unknown>): SocialRow {
    const payload = this.object(row.payload_json); const params = this.object(payload.params);
    return { id: String(row.id), from_agent: String(row.from_agent), to_agent: String(row.to_agent), status: String(row.status), timestamp: String(row.timestamp), payload, params, answer: this.string(params.answer), evidence: this.strings(payload.evidence) };
  }

  private event(campaignId: string, eventType: string, occurredAt: string, version: number, details: Record<string, unknown>): void {
    const id = `${campaignId}:${eventType}:${version}`;
    this.db.prepare(`INSERT OR IGNORE INTO external_events (id, event_type, source, correlation_id, aggregate_id, aggregate_version, dedupe_key, occurred_at, payload) VALUES (?, ?, 'djimitflo-social-campaign', ?, ?, ?, ?, ?, ?)`)
      .run(id, eventType, campaignId, campaignId, version, id, occurredAt, JSON.stringify({ schema: 'djimit.social-learning-campaign.event.v1', campaign_id: campaignId, subject_type: 'social_learning_campaign', subject_id: campaignId, exploratory: true, effect_scope: 'isolated', promotion_allowed: false, ...details }));
  }

  private state(): CampaignState | null {
    const row = this.db.prepare('SELECT value FROM system_state WHERE key = ?').get(ACTIVE_KEY) as { value?: string } | undefined;
    return row?.value ? JSON.parse(row.value) as CampaignState : null;
  }

  private saveState(state: CampaignState): void {
    this.db.prepare("INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(ACTIVE_KEY, JSON.stringify(state), state.updated_at);
  }

  private tokens(value: string): Set<string> { return new Set((value.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) || []).filter(token => token.length > 2 && !STOPWORDS.has(token))); }
  private jaccard(left: string, right: string): number { const a = this.tokens(left); const b = this.tokens(right); const union = new Set([...a, ...b]); return union.size ? [...a].filter(value => b.has(value)).length / union.size : 0; }
  private mean(values: number[]): number { return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length); }
  private hash(value: unknown): string { return createHash('sha256').update(typeof value === 'string' ? value : this.canonical(value)).digest('hex'); }
  private canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(item => this.canonical(item)).join(',')}]`; if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${this.canonical(item)}`).join(',')}}`; return JSON.stringify(value); }
  private object(value: unknown): Record<string, unknown> { if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return {}; } } return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
  private strings(value: unknown): string[] { return Array.isArray(value) ? value.map(item => this.string(item)).filter(Boolean) : []; }
  private string(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
  private required(value: unknown, error: string): string { const result = this.string(value); if (!result) throw new Error(error); return result; }
  private commit(value: unknown, error: string): string { const result = this.required(value, error); if (!/^[0-9a-f]{40}$/i.test(result)) throw new Error(error); return result; }
  private timestamp(value: string): string { const date = new Date(value); if (!Number.isFinite(date.valueOf())) throw new Error('SOCIAL_CAMPAIGN_TIMESTAMP_INVALID'); return date.toISOString(); }
  private integer(value: number, minimum: number, maximum: number, error: string): number { if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(error); return value; }
}
