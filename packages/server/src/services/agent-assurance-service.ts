import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

type TraceSpanType = 'goal' | 'loop' | 'worker' | 'tool' | 'memory' | 'eval' | 'capability' | 'checkpoint' | 'reflection';
type TraceSpanStatus = 'ok' | 'error' | 'running' | 'skipped' | 'blocked';
type TargetType = 'memory' | 'skill' | 'swarm' | 'loop' | 'capability';
type EvalStatus = 'passed' | 'failed' | 'needs_review';
type RiskClass = 'low' | 'medium' | 'high' | 'critical';
type CapabilityStatus = 'active' | 'pending_approval' | 'revoked' | 'expired';
type ReflectionSourceType = 'trace' | 'eval' | 'loop' | 'memory' | 'skill' | 'panel';

export interface TraceSpanRecord {
  id: string;
  trace_id: string;
  parent_span_id: string | null;
  loop_run_id: string | null;
  work_item_id: string | null;
  span_type: TraceSpanType;
  name: string;
  status: TraceSpanStatus;
  evidence_ref: string | null;
  started_at: string | null;
  ended_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface CheckpointRecord {
  id: string;
  loop_run_id: string;
  label: string;
  state: Record<string, unknown>;
  gates: unknown[];
  findings: unknown[];
  leases: Array<Record<string, unknown>>;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface EvalRunRecord {
  id: string;
  suite_name: string;
  target_type: TargetType;
  target_ref: string | null;
  status: EvalStatus;
  score: number;
  scorecard: Record<string, unknown>;
  findings: unknown[];
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface CapabilityTokenRecord {
  id: string;
  token_ref: string;
  subject_agent_id: string | null;
  scopes: string[];
  allowed_actions: string[];
  denied_actions: string[];
  risk_class: RiskClass;
  status: CapabilityStatus;
  approved_by: string | null;
  expires_at: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ReflectionCandidateRecord {
  id: string;
  source_type: ReflectionSourceType;
  source_ref: string;
  lesson: string;
  status: 'candidate' | 'review_required' | 'rejected' | 'promoted';
  sensitivity: 'normal' | 'security_sensitive';
  human_required: boolean;
  evidence_refs: string[];
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

const SPAN_TYPES: TraceSpanType[] = ['goal', 'loop', 'worker', 'tool', 'memory', 'eval', 'capability', 'checkpoint', 'reflection'];
const SPAN_STATUSES: TraceSpanStatus[] = ['ok', 'error', 'running', 'skipped', 'blocked'];
const TARGET_TYPES: TargetType[] = ['memory', 'skill', 'swarm', 'loop', 'capability'];
const RISK_CLASSES: RiskClass[] = ['low', 'medium', 'high', 'critical'];
const REFLECTION_SOURCE_TYPES: ReflectionSourceType[] = ['trace', 'eval', 'loop', 'memory', 'skill', 'panel'];

export class AgentAssuranceService {
  constructor(private db: Database) {}

  createTraceSpan(input: {
    trace_id?: string;
    parent_span_id?: string | null;
    loop_run_id?: string | null;
    work_item_id?: string | null;
    span_type?: TraceSpanType;
    name?: string;
    status?: TraceSpanStatus;
    evidence_ref?: string | null;
    started_at?: string | null;
    ended_at?: string | null;
    metadata?: Record<string, unknown>;
  }): TraceSpanRecord {
    if (!input.trace_id?.trim()) throw new Error('ASSURANCE_TRACE_REQUIRED');
    if (!input.name?.trim()) throw new Error('ASSURANCE_SPAN_NAME_REQUIRED');
    if (!input.span_type || !SPAN_TYPES.includes(input.span_type)) throw new Error('ASSURANCE_SPAN_TYPE_INVALID');
    if (!input.status || !SPAN_STATUSES.includes(input.status)) throw new Error('ASSURANCE_SPAN_STATUS_INVALID');
    this.rejectSecretLike(input.evidence_ref, input.metadata);

    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO agent_trace_spans (
        id, trace_id, parent_span_id, loop_run_id, work_item_id, span_type, name, status,
        evidence_ref, started_at, ended_at, metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.trace_id.trim(),
      input.parent_span_id || null,
      input.loop_run_id || null,
      input.work_item_id || null,
      input.span_type,
      input.name.trim(),
      input.status,
      input.evidence_ref || null,
      input.started_at || now,
      input.ended_at || null,
      JSON.stringify(input.metadata || {}),
      now
    );

    return this.parseTraceSpan(this.db.prepare('SELECT * FROM agent_trace_spans WHERE id = ?').get(id));
  }

  getTrace(traceId: string): { trace_id: string; spans: TraceSpanRecord[]; edges: Array<{ from: string; to: string }>; roots: TraceSpanRecord[] } {
    const spans = (this.db.prepare(`
      SELECT * FROM agent_trace_spans
      WHERE trace_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(traceId) as any[]).map((row) => this.parseTraceSpan(row));
    return {
      trace_id: traceId,
      spans,
      edges: spans
        .filter((span) => span.parent_span_id)
        .map((span) => ({ from: span.parent_span_id as string, to: span.id })),
      roots: spans.filter((span) => !span.parent_span_id),
    };
  }

  createCheckpoint(input: { loop_run_id?: string; label?: string; metadata?: Record<string, unknown> }): CheckpointRecord {
    if (!input.loop_run_id?.trim()) throw new Error('ASSURANCE_LOOP_RUN_REQUIRED');
    if (!input.label?.trim()) throw new Error('ASSURANCE_CHECKPOINT_LABEL_REQUIRED');
    this.rejectSecretLike(input.metadata);

    const run = this.db.prepare('SELECT * FROM loop_runs WHERE id = ?').get(input.loop_run_id);
    if (!run) throw new Error('ASSURANCE_LOOP_RUN_NOT_FOUND');
    const leases = this.db.prepare('SELECT * FROM worker_leases WHERE loop_run_id = ? ORDER BY created_at ASC').all(input.loop_run_id) as any[];
    const id = randomUUID();
    const now = new Date().toISOString();
    const state = this.snapshotLoopRun(run);

    this.db.prepare(`
      INSERT INTO loop_checkpoints (
        id, loop_run_id, label, state_json, gates_json, findings_json, leases_json, metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.loop_run_id,
      input.label.trim(),
      JSON.stringify(state),
      (run as any).gates_json || '[]',
      (run as any).findings_json || '[]',
      JSON.stringify(leases.map((lease) => this.parseWorkerLease(lease))),
      JSON.stringify({
        ...(input.metadata || {}),
        replay_safe: true,
        copied_worker_leases: 0,
      }),
      now
    );

    return this.getCheckpoint(id);
  }

  branchCheckpoint(id: string, input: { reason?: string; metadata?: Record<string, unknown> } = {}): { checkpoint: CheckpointRecord; run: Record<string, unknown> } {
    const checkpoint = this.getCheckpoint(id);
    this.rejectSecretLike(input.reason, input.metadata);
    const source = checkpoint.state as any;
    const runId = randomUUID();
    const now = new Date().toISOString();
    const metadata = {
      ...(source.metadata || {}),
      ...(input.metadata || {}),
      branched_from_checkpoint_id: id,
      branched_from_loop_run_id: checkpoint.loop_run_id,
      branch_reason: input.reason || null,
      copied_worker_leases: 0,
      replay_mode: true,
    };

    this.db.prepare(`
      INSERT INTO loop_runs (
        id, goal_id, loop_name, mode, status, repository_path, state_file,
        findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId,
      source.goal_id || null,
      source.loop_name,
      source.mode || 'closed',
      'created',
      source.repository_path || null,
      source.state_file || null,
      JSON.stringify(source.findings || []),
      JSON.stringify(source.plan || {}),
      JSON.stringify(source.gates || []),
      JSON.stringify(source.next_actions || []),
      JSON.stringify(metadata),
      now,
      now,
      null
    );

    return {
      checkpoint,
      run: this.snapshotLoopRun(this.db.prepare('SELECT * FROM loop_runs WHERE id = ?').get(runId)),
    };
  }

  runEval(input: { suite_name?: string; target_type?: TargetType; target_ref?: string | null; metadata?: Record<string, unknown> }): EvalRunRecord {
    if (!input.suite_name?.trim()) throw new Error('ASSURANCE_EVAL_SUITE_REQUIRED');
    if (!input.target_type || !TARGET_TYPES.includes(input.target_type)) throw new Error('ASSURANCE_EVAL_TARGET_INVALID');
    this.rejectSecretLike(input.target_ref, input.metadata);

    const { score, scorecard, findings } = this.scoreEval(input.suite_name, input.target_type);
    const status: EvalStatus = score >= 0.75 ? 'passed' : score >= 0.5 ? 'needs_review' : 'failed';
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO agent_eval_runs (
        id, suite_name, target_type, target_ref, status, score, scorecard_json, findings_json, metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.suite_name.trim(),
      input.target_type,
      input.target_ref || null,
      status,
      score,
      JSON.stringify(scorecard),
      JSON.stringify(findings),
      JSON.stringify({
        ...(input.metadata || {}),
        deterministic: true,
        external_writes: 0,
      }),
      now
    );

    return this.parseEvalRun(this.db.prepare('SELECT * FROM agent_eval_runs WHERE id = ?').get(id));
  }

  issueCapabilityToken(input: {
    subject_agent_id?: string | null;
    scopes?: string[];
    allowed_actions?: string[];
    denied_actions?: string[];
    risk_class?: RiskClass;
    approved_by?: string | null;
    expires_at?: string | null;
    metadata?: Record<string, unknown>;
  }): CapabilityTokenRecord {
    const scopes = input.scopes || [];
    if (!scopes.length || scopes.some((scope) => !this.isValidScope(scope))) throw new Error('ASSURANCE_SCOPE_INVALID');
    const riskClass = input.risk_class || 'low';
    if (!RISK_CLASSES.includes(riskClass)) throw new Error('ASSURANCE_RISK_INVALID');
    if (['high', 'critical'].includes(riskClass) && !input.approved_by) {
      throw new Error('ASSURANCE_CAPABILITY_APPROVAL_REQUIRED');
    }
    this.rejectSecretLike(input.subject_agent_id, scopes, input.allowed_actions, input.denied_actions, input.approved_by, input.metadata);
    const allowedActions = (input.allowed_actions || []).map((action) => this.sanitizeCapabilityLabel(action));
    const deniedActions = (input.denied_actions || []).map((action) => this.sanitizeCapabilityLabel(action));

    const id = randomUUID();
    const now = new Date().toISOString();
    const expiresAt = input.expires_at || new Date(Date.now() + 60 * 60 * 1000).toISOString();
    this.db.prepare(`
      INSERT INTO capability_tokens (
        id, token_ref, subject_agent_id, scopes_json, allowed_actions_json, denied_actions_json,
        risk_class, status, approved_by, expires_at, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      `cap_${randomUUID()}`,
      input.subject_agent_id || null,
      JSON.stringify(scopes),
      JSON.stringify(allowedActions),
      JSON.stringify(deniedActions),
      riskClass,
      'active',
      input.approved_by || null,
      expiresAt,
      JSON.stringify({
        ...(input.metadata || {}),
        sensitive_material_stored: false,
        least_privilege_required: true,
      }),
      now,
      now
    );

    return this.parseCapabilityToken(this.db.prepare('SELECT * FROM capability_tokens WHERE id = ?').get(id));
  }

  listCapabilityTokens(limit = 50): CapabilityTokenRecord[] {
    return (this.db.prepare('SELECT * FROM capability_tokens ORDER BY created_at DESC LIMIT ?').all(Math.max(1, Math.min(limit, 200))) as any[])
      .map((row) => this.parseCapabilityToken(row));
  }

  createReflection(input: {
    source_type?: ReflectionSourceType;
    source_ref?: string;
    lesson?: string;
    evidence_refs?: string[];
    metadata?: Record<string, unknown>;
  }): ReflectionCandidateRecord {
    if (!input.source_type || !REFLECTION_SOURCE_TYPES.includes(input.source_type)) throw new Error('ASSURANCE_REFLECTION_SOURCE_INVALID');
    if (!input.source_ref?.trim()) throw new Error('ASSURANCE_REFLECTION_SOURCE_REQUIRED');
    if (!input.lesson?.trim()) throw new Error('ASSURANCE_REFLECTION_LESSON_REQUIRED');
    this.rejectSecretLike(input.source_ref, input.lesson, input.evidence_refs, input.metadata);

    const sensitive = /(policy|approval|auth|secret|token|deploy|production|permission|capability)/i.test(input.lesson);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO reflection_candidates (
        id, source_type, source_ref, lesson, status, sensitivity, human_required,
        evidence_refs_json, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.source_type,
      input.source_ref.trim(),
      input.lesson.trim(),
      sensitive ? 'review_required' : 'candidate',
      sensitive ? 'security_sensitive' : 'normal',
      sensitive ? 1 : 0,
      JSON.stringify(input.evidence_refs || []),
      JSON.stringify({
        ...(input.metadata || {}),
        candidate_only: true,
        promotion_requires_review: sensitive,
      }),
      now,
      now
    );

    return this.parseReflection(this.db.prepare('SELECT * FROM reflection_candidates WHERE id = ?').get(id));
  }

  listReflections(limit = 50): ReflectionCandidateRecord[] {
    return (this.db.prepare('SELECT * FROM reflection_candidates ORDER BY created_at DESC LIMIT ?').all(Math.max(1, Math.min(limit, 200))) as any[])
      .map((row) => this.parseReflection(row));
  }

  summary(): Record<string, unknown> {
    const now = new Date().toISOString();
    const latestEvalRows = this.db.prepare('SELECT * FROM agent_eval_runs ORDER BY created_at DESC LIMIT 5').all() as any[];
    return {
      trace_count: this.count('SELECT COUNT(DISTINCT trace_id) as count FROM agent_trace_spans'),
      trace_span_count: this.count('SELECT COUNT(*) as count FROM agent_trace_spans'),
      checkpoint_count: this.count('SELECT COUNT(*) as count FROM loop_checkpoints'),
      eval_run_count: this.count('SELECT COUNT(*) as count FROM agent_eval_runs'),
      active_capability_count: this.count('SELECT COUNT(*) as count FROM capability_tokens WHERE status = ? AND expires_at > ?', ['active', now]),
      pending_capability_count: this.count("SELECT COUNT(*) as count FROM capability_tokens WHERE status = 'pending_approval'"),
      reflection_review_required_count: this.count("SELECT COUNT(*) as count FROM reflection_candidates WHERE status = 'review_required'"),
      latest_evals: latestEvalRows.map((row) => this.parseEvalRun(row)),
      guardrails: {
        external_writes_from_evals: 0,
        capability_sensitive_material_stored: false,
        replay_copies_worker_leases: false,
      },
    };
  }

  /**
   * Run a governance evaluation for an agent using OpenMythos benchmark.
   * Stores result in agent_eval_runs with source='openmythos_benchmark'.
   */
  async runGovernanceEval(agentId: string, categories?: string[], model?: string): Promise<{
    evalId: string;
    overallScore: number;
    categoryScores: Record<string, number>;
    status: 'passed' | 'failed' | 'needs_review';
  }> {
    const { OpenMythosEvalService } = await import('./openmythos-eval-service');
    const evalService = new OpenMythosEvalService(this.db);
    const result = await evalService.runEval(agentId, categories, model);

    // Convert 0-5 scale to 0-1 scale for internal consistency
    const normalizedScore = result.overallScore / 5;
    const status: EvalStatus = normalizedScore >= 0.75 ? 'passed' : normalizedScore >= 0.5 ? 'needs_review' : 'failed';

    const evalId = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO agent_eval_runs (
        id, suite_name, target_type, target_ref, status, score,
        scorecard_json, findings_json, source, benchmark_version, judge_model, metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'openmythos_benchmark', '1.0', ?, ?, ?)
    `).run(
      evalId,
      'openmythos-governance',
      'capability',
      agentId,
      status,
      normalizedScore,
      JSON.stringify(result.categoryScores),
      JSON.stringify([]),
      'qwen2.5:14b-instruct-q4_K_M',
      JSON.stringify({ total_cases: result.totalCases, completed_cases: result.completedCases }),
      now
    );

    return {
      evalId,
      overallScore: result.overallScore,
      categoryScores: result.categoryScores,
      status,
    };
  }

  /**
   * Get governance trend for an agent over time.
   */
  getGovernanceTrend(agentId: string, limit = 10): Array<{
    date: string;
    score: number;
    status: string;
  }> {
    const rows = this.db.prepare(`
      SELECT created_at, score, status
      FROM agent_eval_runs
      WHERE target_ref = ? AND source = 'openmythos_benchmark'
      ORDER BY created_at DESC
      LIMIT ?
    `).all(agentId, limit) as Array<{ created_at: string; score: number; status: string }>;

    return rows.map((r) => ({
      date: r.created_at,
      score: r.score * 5, // Convert back to 0-5 scale
      status: r.status,
    })).reverse();
  }

  /**
   * Check for governance degradation between consecutive runs.
   * Returns true if score dropped by more than 0.5 (on 0-5 scale).
   */
  checkGovernanceDegradation(agentId: string, threshold = 0.5): {
    degraded: boolean;
    previousScore: number;
    currentScore: number;
    drop: number;
  } {
    const rows = this.db.prepare(`
      SELECT score FROM agent_eval_runs
      WHERE target_ref = ? AND source = 'openmythos_benchmark'
      ORDER BY created_at DESC
      LIMIT 2
    `).all(agentId) as Array<{ score: number }>;

    if (rows.length < 2) {
      return { degraded: false, previousScore: 0, currentScore: 0, drop: 0 };
    }

    const currentScore = rows[0].score * 5;
    const previousScore = rows[1].score * 5;
    const drop = previousScore - currentScore;

    return { degraded: drop > threshold, previousScore, currentScore, drop };
  }

  /**
   * Generate a governance report for an agent.
   */
  async generateGovernanceReport(agentId: string): Promise<{
    agentId: string;
    overallScore: number;
    categoryScores: Record<string, number>;
    trend: 'improving' | 'stable' | 'declining';
    status: 'pass' | 'warn' | 'fail';
    recommendations: string[];
    lastEvalAt: string;
  }> {
    const { OpenMythosEvalService } = await import('./openmythos-eval-service');
    const evalService = new OpenMythosEvalService(this.db);
    const report = evalService.generateReport(agentId);

    // Determine status based on score
    let status: 'pass' | 'warn' | 'fail' = 'pass';
    if (report.overallScore < 3.0) status = 'fail';
    else if (report.overallScore < 4.0) status = 'warn';

    return {
      agentId,
      overallScore: report.overallScore,
      categoryScores: report.categoryScores,
      trend: report.trend,
      status,
      recommendations: report.recommendations,
      lastEvalAt: report.lastEvalAt,
    };
  }

  private scoreEval(suiteName: string, targetType: TargetType): { score: number; scorecard: Record<string, unknown>; findings: string[] } {
    if (suiteName === 'memory-quality' && targetType === 'memory') {
      const promoted = this.count("SELECT COUNT(*) as count FROM memory_candidates WHERE status = 'promoted'");
      const reviewRequired = this.count("SELECT COUNT(*) as count FROM memory_candidates WHERE status = 'review_required'");
      const rejected = this.count("SELECT COUNT(*) as count FROM memory_candidates WHERE status = 'rejected'");
      const score = Math.max(0, Math.min(1, (promoted > 0 ? 0.85 : 0.45) - Math.min(reviewRequired, 3) * 0.03 - Math.min(rejected, 2) * 0.05));
      return {
        score,
        scorecard: {
          promoted_memory_count: promoted,
          review_required_count: reviewRequired,
          rejected_count: rejected,
          external_writes: 0,
          deterministic: true,
        },
        findings: promoted > 0 ? ['Promoted memory exists and can be evaluated locally.'] : ['No promoted memory candidates exist yet.'],
      };
    }

    const tableCounts: Record<string, number> = {
      'skill-harness': this.count('SELECT COUNT(*) as count FROM agent_eval_runs WHERE suite_name = ?', ['skill-harness']),
      'swarm-coordination': this.count('SELECT COUNT(*) as count FROM worker_leases'),
      'capability-governance': this.count('SELECT COUNT(*) as count FROM capability_tokens'),
    };
    const signal = tableCounts[suiteName] ?? 0;
    return {
      score: signal > 0 ? 0.7 : 0.55,
      scorecard: {
        local_signal_count: signal,
        external_writes: 0,
        deterministic: true,
      },
      findings: ['Generic assurance suite used local database signals only.'],
    };
  }

  private snapshotLoopRun(row: any): Record<string, unknown> {
    if (!row) throw new Error('ASSURANCE_LOOP_RUN_NOT_FOUND');
    return {
      id: row.id,
      goal_id: row.goal_id || null,
      loop_name: row.loop_name,
      mode: row.mode,
      status: row.status,
      repository_path: row.repository_path || null,
      state_file: row.state_file || null,
      findings: this.safeJson(row.findings_json, []),
      plan: this.safeJson(row.plan_json, {}),
      gates: this.safeJson(row.gates_json, []),
      next_actions: this.safeJson(row.next_actions_json, []),
      metadata: this.safeJson(row.metadata, {}),
      created_at: row.created_at,
      updated_at: row.updated_at,
      completed_at: row.completed_at || null,
    };
  }

  private getCheckpoint(id: string): CheckpointRecord {
    const row = this.db.prepare('SELECT * FROM loop_checkpoints WHERE id = ?').get(id);
    if (!row) throw new Error('ASSURANCE_CHECKPOINT_NOT_FOUND');
    return this.parseCheckpoint(row);
  }

  private parseTraceSpan(row: any): TraceSpanRecord {
    return {
      id: row.id,
      trace_id: row.trace_id,
      parent_span_id: row.parent_span_id || null,
      loop_run_id: row.loop_run_id || null,
      work_item_id: row.work_item_id || null,
      span_type: row.span_type,
      name: row.name,
      status: row.status,
      evidence_ref: row.evidence_ref || null,
      started_at: row.started_at || null,
      ended_at: row.ended_at || null,
      metadata: this.safeJson(row.metadata, {}),
      created_at: row.created_at,
    };
  }

  private parseCheckpoint(row: any): CheckpointRecord {
    return {
      id: row.id,
      loop_run_id: row.loop_run_id,
      label: row.label,
      state: this.safeJson(row.state_json, {}),
      gates: this.safeJson(row.gates_json, []),
      findings: this.safeJson(row.findings_json, []),
      leases: this.safeJson(row.leases_json, []),
      metadata: this.safeJson(row.metadata, {}),
      created_at: row.created_at,
    };
  }

  private parseEvalRun(row: any): EvalRunRecord {
    return {
      id: row.id,
      suite_name: row.suite_name,
      target_type: row.target_type,
      target_ref: row.target_ref || null,
      status: row.status,
      score: row.score,
      scorecard: this.safeJson(row.scorecard_json, {}),
      findings: this.safeJson(row.findings_json, []),
      metadata: this.safeJson(row.metadata, {}),
      created_at: row.created_at,
    };
  }

  private parseCapabilityToken(row: any): CapabilityTokenRecord {
    return {
      id: row.id,
      token_ref: row.token_ref,
      subject_agent_id: row.subject_agent_id || null,
      scopes: this.safeJson(row.scopes_json, []),
      allowed_actions: this.safeJson(row.allowed_actions_json, []),
      denied_actions: this.safeJson(row.denied_actions_json, []),
      risk_class: row.risk_class,
      status: row.status,
      approved_by: row.approved_by || null,
      expires_at: row.expires_at,
      metadata: this.safeJson(row.metadata, {}),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private parseReflection(row: any): ReflectionCandidateRecord {
    return {
      id: row.id,
      source_type: row.source_type,
      source_ref: row.source_ref,
      lesson: row.lesson,
      status: row.status,
      sensitivity: row.sensitivity,
      human_required: Boolean(row.human_required),
      evidence_refs: this.safeJson(row.evidence_refs_json, []),
      metadata: this.safeJson(row.metadata, {}),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private parseWorkerLease(row: any): Record<string, unknown> {
    return {
      id: row.id,
      loop_run_id: row.loop_run_id,
      role: row.role,
      runtime: row.runtime,
      status: row.status,
      finding_id: row.finding_id || null,
      worktree_path: row.worktree_path || null,
      branch_name: row.branch_name || null,
      budget: this.safeJson(row.budget_json, {}),
      metadata: this.safeJson(row.metadata, {}),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private isValidScope(scope: string): boolean {
    return /^(loop|memory|repo|tool|swarm|eval|trace|checkpoint|skill):[a-z0-9_.:-]+$/i.test(scope)
      && !scope.includes('*')
      && !/:(all|admin|root)$/i.test(scope);
  }

  private sanitizeCapabilityLabel(label: string): string {
    if (/(secret|token|password|credential|api[_-]?key)/i.test(label)) {
      return 'sensitive_material_access';
    }
    return label;
  }

  private rejectSecretLike(...values: unknown[]) {
    const text = values
      .filter((value) => value !== undefined && value !== null)
      .map((value) => typeof value === 'string' ? value : JSON.stringify(value))
      .join('\n');
    if (this.containsSecret(text)) throw new Error('ASSURANCE_SECRET_DETECTED');
  }

  private containsSecret(content: string): boolean {
    return /(api[_-]?key|secret|token|password)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{12,}/i.test(content)
      || /\bsk-[A-Za-z0-9_\-]{10,}\b/.test(content)
      || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(content);
  }

  private safeJson<T>(value: string | null | undefined, fallback: T): T {
    if (!value) return fallback;
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }

  private count(query: string, params: unknown[] = []): number {
    return ((this.db.prepare(query).get(...params) as any)?.count || 0) as number;
  }
}
