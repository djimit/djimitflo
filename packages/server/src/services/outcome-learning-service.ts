import { createHash } from 'crypto';
import type { Database } from 'better-sqlite3';
import { WorkItemService, type RiskClass } from './work-item-service';

export type OutcomeEvidenceStatus = 'SUPPORTED' | 'FALSIFIED' | 'UNDETERMINED';

export interface OutcomeLearningAssessment {
  id: string;
  candidate_id: string;
  capability_id: string;
  metric: string;
  direction: 'increase' | 'decrease' | 'maintain' | null;
  observation_window: string;
  status: OutcomeEvidenceStatus;
  signal_status: OutcomeEvidenceStatus;
  replications: number;
  mean_value: number | null;
  baseline_value: number | null;
  confidence_low: number | null;
  confidence_high: number | null;
  causal_support: boolean;
  event_ids: string[];
  evidence_refs: string[];
  result: Record<string, unknown>;
  work_item_id: string | null;
  created_at: string;
  updated_at: string;
}

interface OutcomeEvent {
  eventId: string;
  candidateId: string;
  capabilityId: string;
  skillId: string;
  skillVersion: string;
  skillHash: string;
  metric: string;
  direction: OutcomeLearningAssessment['direction'];
  observationWindow: string;
  value: unknown;
  baseline: unknown;
  minimumEffect: number;
  confidence: number;
  causalStatus: string;
  replicationId: string;
  evidenceRefs: string[];
  riskClass: RiskClass;
  exploratory: boolean;
  payload: Record<string, unknown>;
}

interface Evaluation {
  status: OutcomeEvidenceStatus;
  signalStatus: OutcomeEvidenceStatus;
  mean: number | null;
  baseline: number | null;
  low: number | null;
  high: number | null;
  causalSupport: boolean;
  reason: string;
}

const RISKS: RiskClass[] = ['low', 'medium', 'high', 'critical'];

export class OutcomeLearningService {
  private readonly workItems: WorkItemService;
  private readonly minimumReplications: number;
  private readonly minimumConfidence: number;
  private readonly containmentMinReplications: number;

  constructor(private readonly db: Database, options: { minimumReplications?: number; minimumConfidence?: number; containmentMinReplications?: number } = {}) {
    this.workItems = new WorkItemService(db);
    this.minimumReplications = Math.max(2, options.minimumReplications ?? (Number(process.env.OUTCOME_MIN_REPLICATIONS) || 3));
    this.minimumConfidence = Math.max(0, Math.min(1, options.minimumConfidence ?? (Number(process.env.OUTCOME_MIN_CONFIDENCE) || 0.7)));
    this.containmentMinReplications = Math.max(this.minimumReplications, options.containmentMinReplications ?? (Number(process.env.OUTCOME_CONTAINMENT_MIN_REPLICATIONS) || 30));
  }

  process(): { groups: number; assessments: number; work_items_created: number; supported: number; falsified: number; undetermined: number } {
    const grouped = new Map<string, OutcomeEvent[]>();
    const rows = this.db.prepare("SELECT id, payload FROM external_events WHERE event_type = 'outcome.observed' ORDER BY occurred_at, id")
      .all() as Array<{ id: string; payload: string }>;
    for (const row of rows) {
      const outcome = this.parse(row);
      if (!outcome) continue;
      const key = this.groupKey(outcome);
      const group = grouped.get(key) || [];
      if (!group.some((existing) => existing.replicationId === outcome.replicationId)) group.push(outcome);
      grouped.set(key, group);
    }

    let workItemsCreated = 0;
    const counts: Record<OutcomeEvidenceStatus, number> = { SUPPORTED: 0, FALSIFIED: 0, UNDETERMINED: 0 };
    const transaction = this.db.transaction(() => {
      for (const [key, outcomes] of grouped) {
        const evaluation = this.evaluate(outcomes);
        counts[evaluation.status] += 1;
        const first = outcomes[0];
        const id = `outcome-learning:sha256:${createHash('sha256').update(key).digest('hex')}`;
        const eventIds = outcomes.map((outcome) => outcome.eventId);
        const evidenceRefs = [...new Set(outcomes.flatMap((outcome) => outcome.evidenceRefs).concat(eventIds.map((eventId) => `external-event:${eventId}`)))];
        const result = {
          reason: evaluation.reason,
          minimum_replications: this.minimumReplications,
          minimum_confidence: this.minimumConfidence,
          average_confidence: this.mean(outcomes.map((outcome) => outcome.confidence)),
          causal_statuses: [...new Set(outcomes.map((outcome) => outcome.causalStatus))],
          evidence_authority: 'reported_observations',
          reported_causal_statuses: [...new Set(outcomes.map((outcome) => outcome.causalStatus))],
          interval_method: 'descriptive_normal_approximation_from_reported_values',
          experiment_ids: [...new Set(outcomes.map((outcome) => String(outcome.payload.experiment_id || '')).filter(Boolean))],
          trajectory_ids: [...new Set(outcomes.map((outcome) => String(outcome.payload.trajectory_id || '')).filter(Boolean))],
          finding_ids: [...new Set(outcomes.map((outcome) => String(outcome.payload.finding_id || '')).filter(Boolean))],
          skill_attribution: {
            skill_id: first.skillId,
            skill_version: first.skillVersion,
            skill_hash: first.skillHash,
            complete: Boolean(first.skillId && first.skillVersion && first.skillHash),
          },
          execution_attribution: {
            task_ids: [...new Set(outcomes.map((outcome) => String(outcome.payload.task_id || '')).filter(Boolean))],
            model_ids: [...new Set(outcomes.map((outcome) => String(outcome.payload.model_id || '')).filter(Boolean))],
            runtime_identities: [...new Set(outcomes.map((outcome) => String(outcome.payload.runtime_identity || '')).filter(Boolean))],
            cost_complete: outcomes.every((outcome) => typeof outcome.payload.cost_amount === 'number'
              && Boolean(outcome.payload.cost_currency) && Boolean(outcome.payload.cost_basis)),
            total_cost: outcomes.every((outcome) => typeof outcome.payload.cost_amount === 'number')
              ? outcomes.reduce((sum, outcome) => sum + Number(outcome.payload.cost_amount), 0) : null,
            cost_currencies: [...new Set(outcomes.map((outcome) => String(outcome.payload.cost_currency || '')).filter(Boolean))],
            cost_bases: [...new Set(outcomes.map((outcome) => String(outcome.payload.cost_basis || '')).filter(Boolean))],
          },
          exploratory: outcomes.some((outcome) => outcome.exploratory),
          promotion_eligible: false,
          required_next_gate: outcomes.some((outcome) => outcome.exploratory)
            ? 'confirmatory_replication'
            : !first.skillId || !first.skillVersion || !first.skillHash
              ? 'skill_attribution'
              : evaluation.causalSupport ? 'openmythos_targeted_retest' : 'controlled_or_counterfactual_evidence',
        };
        const now = new Date().toISOString();
        this.db.prepare(`
          INSERT INTO outcome_learning_assessments (
            id, candidate_id, capability_id, metric, direction, observation_window,
            status, signal_status, replications, mean_value, baseline_value,
            confidence_low, confidence_high, causal_support, event_ids_json,
            evidence_refs_json, result_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            status = excluded.status, signal_status = excluded.signal_status,
            replications = excluded.replications, mean_value = excluded.mean_value,
            baseline_value = excluded.baseline_value, confidence_low = excluded.confidence_low,
            confidence_high = excluded.confidence_high, causal_support = excluded.causal_support,
            event_ids_json = excluded.event_ids_json, evidence_refs_json = excluded.evidence_refs_json,
            result_json = excluded.result_json, updated_at = excluded.updated_at
        `).run(
          id, first.candidateId, first.capabilityId, first.metric, first.direction,
          first.observationWindow, evaluation.status, evaluation.signalStatus, outcomes.length,
          evaluation.mean, evaluation.baseline, evaluation.low, evaluation.high,
          evaluation.causalSupport ? 1 : 0, JSON.stringify(eventIds), JSON.stringify(evidenceRefs),
          JSON.stringify(result), now, now,
        );

        if (evaluation.status === 'FALSIFIED' && evaluation.causalSupport && outcomes.length >= this.containmentMinReplications) {
          this.applyContainment(first.capabilityId, id, evidenceRefs, evaluation.reason, now);
        }

        const existingRow = this.db.prepare('SELECT id FROM work_items WHERE source = ? AND source_ref = ?')
          .get('outcome_observed', id) as { id: string } | undefined;
        // An inconclusive update must refresh an existing projection, not leave a
        // stale positive signal. It does not qualify a new candidate for creation.
        if (!existingRow && (outcomes.length < this.minimumReplications || evaluation.signalStatus === 'UNDETERMINED')) continue;
        const riskClass = outcomes.reduce<RiskClass>((highest, outcome) => RISKS.indexOf(outcome.riskClass) > RISKS.indexOf(highest) ? outcome.riskClass : highest, 'low');
        const title = evaluation.status === 'SUPPORTED'
          ? `Validate supported outcome for ${first.capabilityId}`
          : evaluation.status === 'FALSIFIED'
            ? `Contain falsified outcome for ${first.capabilityId}`
            : `Establish causality for ${first.capabilityId}`;
        const description = `${outcomes.length} replicated ${first.metric} observations produced ${evaluation.signalStatus}; assurance status is ${evaluation.status}. ${evaluation.reason}`;
        const metadata = {
          objective: evaluation.status === 'FALSIFIED'
            ? `Contain ${first.capabilityId} until the falsified outcome is independently remediated`
            : `Validate and reproduce the ${first.metric} outcome for ${first.capabilityId}`,
          constraints: ['preserve ToolBroker mediation', 'no autonomous promotion'],
          acceptance_criteria: ['OpenMythos targeted retest passes', 'DjimitFlo proof run passes'],
          falsification_tests: ['replicated confidence interval no longer supports the claimed effect'],
          outcome_learning: {
            assessment_id: id,
            candidate_id: first.candidateId,
            capability_id: first.capabilityId,
            metric: first.metric,
            direction: first.direction,
            status: evaluation.status,
            signal_status: evaluation.signalStatus,
            replications: outcomes.length,
            evidence_refs: evidenceRefs,
            result,
          },
        };
        const existing = existingRow
          ? { created: false, work_item: this.workItems.get(existingRow.id) }
          : this.workItems.createIfMissingBySourceRef({
          title,
          description,
          source: 'outcome_observed',
          source_ref: id,
          risk_class: riskClass,
          value_score: evaluation.status === 'FALSIFIED' ? 90 : 75,
          confidence: this.mean(outcomes.map((outcome) => outcome.confidence)),
          status: 'candidate',
          recommended_loop: 'outcome-learning-loop',
          metadata,
        });
        if (existing.created) workItemsCreated += 1;
        else this.workItems.update(existing.work_item.id, {
          confidence: this.mean(outcomes.map((outcome) => outcome.confidence)),
          risk_class: RISKS.indexOf(riskClass) > RISKS.indexOf(existing.work_item.risk_class) ? riskClass : existing.work_item.risk_class,
          // Scope, lifecycle and operator annotations belong to the work item.
          // Only this service's derived namespace is replaced during replay.
          metadata: { ...existing.work_item.metadata, outcome_learning: metadata.outcome_learning },
        });
        this.db.prepare('UPDATE outcome_learning_assessments SET work_item_id = ?, updated_at = ? WHERE id = ?')
          .run(existing.work_item.id, now, id);
      }
    });
    transaction();
    return {
      groups: grouped.size,
      assessments: grouped.size,
      work_items_created: workItemsCreated,
      supported: counts.SUPPORTED,
      falsified: counts.FALSIFIED,
      undetermined: counts.UNDETERMINED,
    };
  }

  list(limit = 100): OutcomeLearningAssessment[] {
    return (this.db.prepare('SELECT * FROM outcome_learning_assessments ORDER BY updated_at DESC LIMIT ?')
      .all(Math.max(1, Math.min(limit, 500))) as any[]).map((row) => ({
        id: row.id,
        candidate_id: row.candidate_id,
        capability_id: row.capability_id,
        metric: row.metric,
        direction: row.direction,
        observation_window: row.observation_window,
        status: row.status,
        signal_status: row.signal_status,
        replications: row.replications,
        mean_value: row.mean_value,
        baseline_value: row.baseline_value,
        confidence_low: row.confidence_low,
        confidence_high: row.confidence_high,
        causal_support: Boolean(row.causal_support),
        event_ids: this.stringArray(row.event_ids_json),
        evidence_refs: this.stringArray(row.evidence_refs_json),
        result: this.object(row.result_json),
        work_item_id: row.work_item_id || null,
        created_at: row.created_at,
        updated_at: row.updated_at,
      }));
  }

  releaseContainment(capabilityId: string, input: { evidence_refs?: string[]; released_by?: string }): void {
    const evidenceRefs = [...new Set((input.evidence_refs || []).map(String).filter(Boolean))];
    if (!input.released_by?.trim()) throw new Error('OUTCOME_CONTAINMENT_RELEASE_ACTOR_REQUIRED');
    this.assertReleaseEvidence(capabilityId, evidenceRefs);
    const row = this.db.prepare('SELECT metadata FROM swarm_capabilities WHERE id = ?').get(capabilityId) as { metadata: string } | undefined;
    if (!row) throw new Error('SWARM_CAPABILITY_NOT_FOUND');
    const metadata = this.object(row.metadata);
    if (!metadata.outcome_hold) throw new Error('OUTCOME_CONTAINMENT_NOT_ACTIVE');
    const history = Array.isArray(metadata.outcome_hold_history) ? metadata.outcome_hold_history : [];
    history.push({ ...metadata.outcome_hold as Record<string, unknown>, released_at: new Date().toISOString(), released_by: input.released_by.trim(), release_evidence_refs: evidenceRefs });
    delete metadata.outcome_hold;
    metadata.outcome_hold_history = history;
    this.db.prepare('UPDATE swarm_capabilities SET metadata = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(metadata), new Date().toISOString(), capabilityId);
  }

  private assertReleaseEvidence(capabilityId: string, evidenceRefs: string[]): void {
    const ref = (prefix: string) => evidenceRefs.find((candidate) => candidate.startsWith(prefix))?.slice(prefix.length) || '';
    const openMythosId = ref('openmythos:');
    const worldLabId = ref('worldlab:');
    const approvalId = ref('approval:');
    if (!openMythosId || !worldLabId || !approvalId) throw new Error('OUTCOME_CONTAINMENT_RELEASE_EVIDENCE_REQUIRED');

    const openMythos = this.db.prepare(`SELECT 1 FROM openmythos_attestations
      WHERE id = ? AND certification_eligible = 1 AND corpus_certification_ready = 1`).get(openMythosId);
    const worldLab = (this.db.prepare("SELECT metadata FROM goals WHERE json_type(metadata, '$.worldlab_retests') = 'array'").all() as Array<{ metadata: string }>)
      .some((row) => {
        const retests = this.object(row.metadata).worldlab_retests;
        return Array.isArray(retests) && retests.some((item) => {
          const record = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {};
          return record.id === worldLabId && record.decision === 'PROMOTION_CANDIDATE';
        });
      });
    const approval = this.db.prepare('SELECT status, requested_by, decided_by, metadata FROM approvals WHERE id = ?').get(approvalId) as {
      status: string; requested_by: string | null; decided_by: string | null; metadata: string | null;
    } | undefined;
    const approvalMetadata = this.object(approval?.metadata || '{}');
    const approvalValid = approval?.status === 'approved'
      && Boolean(approval.decided_by) && approval.decided_by !== approval.requested_by
      && approvalMetadata.capability_id === capabilityId
      && approvalMetadata.action === 'release_outcome_containment';
    if (!openMythos || !worldLab || !approvalValid) throw new Error('OUTCOME_CONTAINMENT_RELEASE_EVIDENCE_UNRESOLVED');
  }

  private parse(row: { id: string; payload: string }): OutcomeEvent | null {
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(row.payload) as Record<string, unknown>; } catch { return null; }
    const required = ['candidate_id', 'capability_id', 'metric', 'observation_window'];
    if (required.some((key) => typeof payload[key] !== 'string' || !String(payload[key]).trim())) return null;
    const direction = ['increase', 'decrease', 'maintain'].includes(String(payload.direction))
      ? String(payload.direction) as OutcomeEvent['direction'] : null;
    const risk = RISKS.includes(String(payload.risk_class) as RiskClass) ? String(payload.risk_class) as RiskClass : 'medium';
    return {
      eventId: row.id,
      candidateId: String(payload.candidate_id),
      capabilityId: String(payload.capability_id),
      skillId: String(payload.skill_id || '').trim(),
      skillVersion: String(payload.skill_version || '').trim(),
      skillHash: String(payload.skill_hash || '').trim(),
      metric: String(payload.metric),
      direction,
      observationWindow: String(payload.observation_window),
      value: payload.value,
      baseline: payload.baseline,
      minimumEffect: Math.max(0, Number(payload.minimum_effect) || 0),
      confidence: Math.max(0, Math.min(1, Number(payload.confidence) || 0)),
      causalStatus: String(payload.causal_status || 'unknown'),
      replicationId: String(payload.replication_id || payload.outcome_id || row.id),
      evidenceRefs: Array.isArray(payload.evidence_refs) ? payload.evidence_refs.map(String).filter(Boolean) : [],
      riskClass: risk,
      exploratory: payload.exploratory === true,
      payload,
    };
  }

  private groupKey(outcome: OutcomeEvent): string {
    return JSON.stringify([
      outcome.candidateId, outcome.capabilityId, outcome.metric, outcome.direction,
      outcome.observationWindow, outcome.minimumEffect,
      String(outcome.payload.condition || ''), String(outcome.payload.experiment_id || ''),
      outcome.skillId, outcome.skillVersion, outcome.skillHash,
    ]);
  }

  private applyContainment(capabilityId: string, assessmentId: string, evidenceRefs: string[], reason: string, now: string): void {
    const row = this.db.prepare('SELECT metadata FROM swarm_capabilities WHERE id = ?').get(capabilityId) as { metadata: string } | undefined;
    if (!row) return;
    const metadata = this.object(row.metadata);
    const current = metadata.outcome_hold as Record<string, unknown> | undefined;
    if (current?.assessment_id === assessmentId) return;
    metadata.outcome_hold = { assessment_id: assessmentId, evidence_refs: evidenceRefs, reason, applied_at: now };
    this.db.prepare('UPDATE swarm_capabilities SET metadata = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(metadata), now, capabilityId);
  }

  private evaluate(outcomes: OutcomeEvent[]): Evaluation {
    const values = outcomes.map((outcome) => typeof outcome.value === 'number' ? outcome.value : Number.NaN);
    const baselines = outcomes.map((outcome) => typeof outcome.baseline === 'number' ? outcome.baseline : Number.NaN);
    const exploratory = outcomes.some((outcome) => outcome.exploratory);
    // main-beveiliging (Kilo-reviewed): sender-supplied causal labels zijn
    // observaties, geen experimental authority — promotion/containment vereist
    // een exact verified experiment binding die deze service nog niet heeft.
    const causalSupport = false;
    if (!outcomes[0].direction) return { status: 'UNDETERMINED', signalStatus: 'UNDETERMINED', mean: null, baseline: null, low: null, high: null, causalSupport, reason: 'direction is required for outcome interpretation' };
    if (values.some((value) => !Number.isFinite(value)) || baselines.some((value) => !Number.isFinite(value))) {
      return { status: 'UNDETERMINED', signalStatus: 'UNDETERMINED', mean: null, baseline: null, low: null, high: null, causalSupport, reason: 'numeric value and baseline are required for statistical assessment' };
    }
    const mean = this.mean(values);
    const baseline = this.mean(baselines);
    const variance = values.length > 1 ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1) : 0;
    const margin = 1.96 * Math.sqrt(variance / Math.max(1, values.length));
    const low = mean - margin;
    const high = mean + margin;
    const minimumEffect = Math.max(...outcomes.map((outcome) => outcome.minimumEffect));
    let signalStatus: OutcomeEvidenceStatus = 'UNDETERMINED';
    if (outcomes.length >= this.minimumReplications && this.mean(outcomes.map((outcome) => outcome.confidence)) >= this.minimumConfidence) {
      if (outcomes[0].direction === 'increase') {
        if (low > baseline + minimumEffect) signalStatus = 'SUPPORTED';
        else if (high <= baseline + minimumEffect) signalStatus = 'FALSIFIED';
      } else if (outcomes[0].direction === 'decrease') {
        if (high < baseline - minimumEffect) signalStatus = 'SUPPORTED';
        else if (low >= baseline - minimumEffect) signalStatus = 'FALSIFIED';
      } else {
        if (low >= baseline - minimumEffect && high <= baseline + minimumEffect) signalStatus = 'SUPPORTED';
        else if (high < baseline - minimumEffect || low > baseline + minimumEffect) signalStatus = 'FALSIFIED';
      }
    }
    const status = causalSupport ? signalStatus : 'UNDETERMINED';
    const reason = outcomes.length < this.minimumReplications
      ? `replication gate not met: ${outcomes.length}/${this.minimumReplications}`
      : this.mean(outcomes.map((outcome) => outcome.confidence)) < this.minimumConfidence
        ? 'confidence gate not met'
        : signalStatus === 'UNDETERMINED'
          ? 'confidence interval crosses the operational threshold'
          : exploratory
            ? `${signalStatus} exploratory signal requires confirmatory replication`
          : !causalSupport
            ? `${signalStatus} signal is correlated but lacks causal support`
            : `${signalStatus} signal has replicated causal support`;
    return { status, signalStatus, mean, baseline, low, high, causalSupport, reason };
  }

  private mean(values: number[]): number {
    return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  }

  private stringArray(value: string): string[] {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return []; }
  }

  private object(value: string): Record<string, unknown> {
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; }
  }
}
