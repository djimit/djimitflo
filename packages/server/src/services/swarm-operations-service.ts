/**
 * SwarmOperationsService — capacity planning, runner manifests, governance evaluation.
 *
 * Extracted from SwarmIntelligenceService (~150 LOC) to isolate the
 * capacity planning, manifest management, and governance logic.
 */

import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { SwarmStatusService, type WorkerPoolPlanInput, type CapacityPlanV2Result } from './swarm-status-service';

type RiskClass = 'low' | 'medium' | 'high' | 'critical';
const RISK_CLASSES: RiskClass[] = ['low', 'medium', 'high', 'critical'];
type RunnerManifestAction = 'plan' | 'start' | 'skip' | 'fail' | 'stop' | 'kill' | 'complete';
const RUNNER_ACTIONS: RunnerManifestAction[] = ['plan', 'start', 'skip', 'fail', 'stop', 'kill', 'complete'];

export interface RunnerManifestRecord {
  id: string;
  decision_id: string;
  lease_id: string | null;
  loop_run_id: string | null;
  action: RunnerManifestAction;
  policy_version: string;
  runtime_contract: Record<string, unknown>;
  capacity_snapshot: Record<string, unknown>;
  budget_snapshot: Record<string, unknown>;
  gate_refs: string[];
  blocked_reasons: string[];
  metadata: Record<string, unknown>;
  created_at: string;
}

export class SwarmOperationsService {
  constructor(private db: Database) {}

  // ─── Capacity Planning ────────────────────────────────────────────

  planCapacityV2(input: WorkerPoolPlanInput = {}, existingStatusService?: SwarmStatusService): CapacityPlanV2Result {
    const statusService = existingStatusService || new SwarmStatusService(this.db);
    const plan = statusService.planWorkerPool(input);
    const queueClasses: Record<string, number> = {};
    for (const decision of plan.decisions) {
      const queueClass = this.queueClassFor(decision.role, decision.risk_class, decision.blocked_reasons);
      queueClasses[queueClass] = (queueClasses[queueClass] || 0) + 1;
    }
    const fairShareOrder = Object.entries(queueClasses)
      .sort(([left], [right]) => this.queueWeight(right) - this.queueWeight(left))
      .map(([queueClass]) => queueClass);
    return {
      ...plan,
      queue_classes: queueClasses,
      fair_share_order: fairShareOrder,
      audit_manifest_preview: plan.decisions.map((decision) => ({
        decision_id: `preview:${decision.lease_id}`,
        lease_id: decision.lease_id,
        action: decision.eligible ? 'start' : 'skip',
        policy_version: 'swarm-intelligence-v1',
        blocked_reasons: decision.blocked_reasons,
        queue_class: this.queueClassFor(decision.role, decision.risk_class, decision.blocked_reasons),
      })),
    };
  }

  // ─── Runner Manifests ─────────────────────────────────────────────

  createRunnerManifest(input: {
    decision_id?: string;
    lease_id?: string | null;
    loop_run_id?: string | null;
    action?: RunnerManifestAction;
    policy_version?: string;
    runtime_contract?: Record<string, unknown>;
    capacity_snapshot?: Record<string, unknown>;
    budget_snapshot?: Record<string, unknown>;
    gate_refs?: string[];
    blocked_reasons?: string[];
    metadata?: Record<string, unknown>;
  }): RunnerManifestRecord {
    if (!input.decision_id?.trim()) throw new Error('SWARM_RUNNER_DECISION_ID_REQUIRED');
    if (!input.action || !RUNNER_ACTIONS.includes(input.action)) throw new Error('SWARM_RUNNER_ACTION_INVALID');
    if (!input.policy_version?.trim()) throw new Error('SWARM_RUNNER_POLICY_VERSION_REQUIRED');
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO swarm_runner_manifests (
        id, decision_id, lease_id, loop_run_id, action, policy_version,
        runtime_contract_json, capacity_snapshot_json, budget_snapshot_json,
        gate_refs_json, blocked_reasons_json, metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.decision_id.trim(), input.lease_id || null, input.loop_run_id || null,
      input.action, input.policy_version.trim(),
      JSON.stringify(input.runtime_contract || {}),
      JSON.stringify(input.capacity_snapshot || {}),
      JSON.stringify(input.budget_snapshot || {}),
      JSON.stringify(this.stringArray(input.gate_refs)),
      JSON.stringify(this.stringArray(input.blocked_reasons)),
      JSON.stringify(input.metadata || {}),
      new Date().toISOString(),
    );
    return this.parseRunnerManifest(this.db.prepare('SELECT * FROM swarm_runner_manifests WHERE id = ?').get(id));
  }

  listRunnerManifests(limit = 50): RunnerManifestRecord[] {
    return (this.db.prepare('SELECT * FROM swarm_runner_manifests ORDER BY created_at DESC LIMIT ?').all(this.limit(limit)) as any[])
      .map((row) => this.parseRunnerManifest(row));
  }

  // ─── Governance Evaluation ────────────────────────────────────────

  evaluateGovernance(input: {
    risk_class?: RiskClass;
    mutating?: boolean;
    maker_pass?: boolean;
    checker_pass?: boolean;
    security_checker_pass?: boolean;
    quorum_count?: number;
    quorum_required?: number;
    runtime_warnings?: string[];
    human_approval_ref?: string | null;
    ready_for_human_merge?: boolean;
  }) {
    const riskClass = input.risk_class || 'low';
    if (!RISK_CLASSES.includes(riskClass)) throw new Error('SWARM_GOVERNANCE_RISK_INVALID');
    const blocked: string[] = [];
    const warnings = this.stringArray(input.runtime_warnings);
    const quorumRequired = Math.max(0, Number(input.quorum_required || (['high', 'critical'].includes(riskClass) ? 2 : 0)));
    const quorumCount = Math.max(0, Number(input.quorum_count || 0));

    if (!input.maker_pass) blocked.push('maker_required');
    if (!input.checker_pass) blocked.push('checker_required');
    if (['high', 'critical'].includes(riskClass) && !input.security_checker_pass) blocked.push('security_checker_required');
    if (quorumCount < quorumRequired) blocked.push('evaluator_quorum_missing');
    if (['high', 'critical'].includes(riskClass) && warnings.some((warning) => /(trust|contract|auth|secret|token|permission)/i.test(warning))) {
      blocked.push('runtime_warning_gate_failed');
    }
    if (input.mutating && input.ready_for_human_merge && !input.human_approval_ref) {
      blocked.push('human_approval_required_for_completion');
    }

    return {
      status: blocked.length > 0 ? 'blocked' : 'eligible',
      blocked_reasons: [...new Set(blocked)],
      gates: {
        maker: input.maker_pass ? 'pass' : 'fail',
        checker: input.checker_pass ? 'pass' : 'fail',
        security_checker: ['high', 'critical'].includes(riskClass) ? (input.security_checker_pass ? 'pass' : 'fail') : 'skipped',
        evaluator_quorum: quorumCount >= quorumRequired ? 'pass' : 'fail',
        runtime_warning_gate: blocked.includes('runtime_warning_gate_failed') ? 'fail' : warnings.length ? 'advisory' : 'pass',
        human_completion_gate: input.mutating && input.ready_for_human_merge ? (input.human_approval_ref ? 'pass' : 'fail') : 'skipped',
      },
      completion_state: input.ready_for_human_merge && input.mutating && !input.human_approval_ref
        ? 'ready_for_human_merge'
        : blocked.length > 0 ? 'blocked' : 'completed_eligible',
    };
  }

  // ─── Queue Classification ─────────────────────────────────────────

  private queueClassFor(role: string, riskClass: string, blockedReasons: string[]): string {
    if (blockedReasons.some((reason) => reason.includes('security') || reason.includes('high_risk'))) return 'security_review';
    if (role === 'checker' || role === 'security_checker') return 'review_gate';
    if (['high', 'critical'].includes(riskClass)) return 'policy_review';
    return 'small_code_fix';
  }

  private queueWeight(queueClass: string): number {
    const weights: Record<string, number> = { security_review: 5, policy_review: 4, review_gate: 3, small_code_fix: 2 };
    return weights[queueClass] || 0;
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  private stringArray(input?: string[] | unknown): string[] {
    if (Array.isArray(input)) return input.filter(Boolean).map(String);
    if (typeof input === 'string') try { const parsed = JSON.parse(input); return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return []; }
    return [];
  }

  private limit(value: number): number {
    return Math.max(1, Math.min(Math.round(value), 1000));
  }

  private parseRunnerManifest(row: any): RunnerManifestRecord {
    return {
      id: row.id, decision_id: row.decision_id, lease_id: row.lease_id,
      loop_run_id: row.loop_run_id, action: row.action, policy_version: row.policy_version,
      runtime_contract: JSON.parse(row.runtime_contract_json || '{}'),
      capacity_snapshot: JSON.parse(row.capacity_snapshot_json || '{}'),
      budget_snapshot: JSON.parse(row.budget_snapshot_json || '{}'),
      gate_refs: JSON.parse(row.gate_refs_json || '[]'),
      blocked_reasons: JSON.parse(row.blocked_reasons_json || '[]'),
      metadata: JSON.parse(row.metadata || '{}'),
      created_at: row.created_at,
    };
  }
}
