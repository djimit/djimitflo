import { createHash, randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

export type RiskClass = 'low' | 'medium' | 'high' | 'critical';
export type WorkItemStatus = 'candidate' | 'triaged' | 'planned' | 'leased' | 'blocked' | 'done' | 'discarded';

export interface WorkItemRecord {
  id: string;
  title: string;
  description: string;
  source: string;
  source_ref: string | null;
  risk_class: RiskClass;
  value_score: number;
  confidence: number;
  status: WorkItemStatus;
  recommended_loop: string | null;
  assigned_agent_id: string | null;
  assigned_runtime: string | null;
  parent_goal_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface WorkItemCreateInput {
  title: string;
  description: string;
  source?: string;
  source_ref?: string | null;
  risk_class?: RiskClass;
  value_score?: number;
  confidence?: number;
  status?: WorkItemStatus;
  recommended_loop?: string | null;
  assigned_agent_id?: string | null;
  assigned_runtime?: string | null;
  parent_goal_id?: string | null;
  metadata?: Record<string, unknown>;
}

export interface WorkItemUpdateInput {
  title?: string;
  description?: string;
  risk_class?: RiskClass;
  value_score?: number;
  confidence?: number;
  status?: WorkItemStatus;
  recommended_loop?: string | null;
  assigned_agent_id?: string | null;
  assigned_runtime?: string | null;
  parent_goal_id?: string | null;
  metadata?: Record<string, unknown>;
}

const VALID_RISKS: RiskClass[] = ['low', 'medium', 'high', 'critical'];
const VALID_STATUSES: WorkItemStatus[] = ['candidate', 'triaged', 'planned', 'leased', 'blocked', 'done', 'discarded'];
const RISK_RANK: Record<RiskClass, number> = { low: 0, medium: 1, high: 2, critical: 3 };
const VALID_CIA_IMPACTS = ['confidentiality', 'integrity', 'availability'] as const;

export const SECURITY_FINDING_SOURCE = 'security_finding';
export const BOARD_HANDOFF_AUTHORITY = Symbol('BOARD_HANDOFF_AUTHORITY');

export interface SecurityFindingContract extends Record<string, unknown> {
  target: string;
  source_identity: string;
  tool: string;
  rule_id: string;
  location: string;
  severity: RiskClass;
  cia_impact: Array<typeof VALID_CIA_IMPACTS[number]>;
  threat: string;
  attack_path: string[];
  evidence_refs: string[];
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function nonEmptyStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim())
    : [];
}

export function parseSecurityFindingContract(metadata: unknown): SecurityFindingContract {
  const security = objectValue(objectValue(metadata)?.security);
  const requiredStrings = ['target', 'source_identity', 'tool', 'rule_id', 'location', 'threat'] as const;
  const missing = requiredStrings.filter((field) => !nonEmptyString(security?.[field]));
  if (!security || missing.length) {
    throw new Error(`SECURITY_FINDING_CONTRACT_INCOMPLETE:${missing.length ? missing.join(',') : 'security'}`);
  }

  const severity = nonEmptyString(security.severity);
  if (!severity || !VALID_RISKS.includes(severity as RiskClass)) {
    throw new Error('SECURITY_FINDING_SEVERITY_INVALID');
  }
  const ciaImpact = nonEmptyStringList(security.cia_impact);
  if (!ciaImpact.length || ciaImpact.some((impact) => !VALID_CIA_IMPACTS.includes(impact as typeof VALID_CIA_IMPACTS[number]))) {
    throw new Error('SECURITY_FINDING_CIA_IMPACT_INVALID');
  }
  const attackPath = nonEmptyStringList(security.attack_path);
  const evidenceRefs = nonEmptyStringList(security.evidence_refs);
  const missingLists = [
    ...(!attackPath.length ? ['attack_path'] : []),
    ...(!evidenceRefs.length ? ['evidence_refs'] : []),
  ];
  if (missingLists.length) {
    throw new Error(`SECURITY_FINDING_CONTRACT_INCOMPLETE:${missingLists.join(',')}`);
  }

  return {
    ...security,
    target: nonEmptyString(security.target)!,
    source_identity: nonEmptyString(security.source_identity)!,
    tool: nonEmptyString(security.tool)!,
    rule_id: nonEmptyString(security.rule_id)!,
    location: nonEmptyString(security.location)!,
    severity: severity as RiskClass,
    cia_impact: [...new Set(ciaImpact)] as SecurityFindingContract['cia_impact'],
    threat: nonEmptyString(security.threat)!,
    attack_path: attackPath,
    evidence_refs: evidenceRefs,
  };
}

export function securityFindingFingerprint(finding: SecurityFindingContract): string {
  const identity = [finding.target, finding.tool.toLowerCase(), finding.rule_id, finding.location].join('\0');
  return `security:sha256:${createHash('sha256').update(identity).digest('hex')}`;
}

export class WorkItemService {
  constructor(private db: Database) {}

  create(input: WorkItemCreateInput): WorkItemRecord {
    const normalized = this.normalizeSource(input);
    if (normalized.source === 'agent_board') throw new Error('BOARD_HANDOFF_REVIEW_REQUIRED');
    return this.insert(normalized);
  }

  private insert(input: WorkItemCreateInput): WorkItemRecord {
    this.validateCreate(input);
    const now = new Date().toISOString();
    const id = randomUUID();
    const riskClass = input.risk_class || 'low';
    const valueScore = this.normalizedInteger(input.value_score, 50, 0, 100);
    const confidence = this.normalizedNumber(input.confidence, 0.5, 0, 1);
    const status = input.status || 'candidate';

    this.db.prepare(`
      INSERT INTO work_items (
        id, title, description, source, source_ref, risk_class, value_score,
        confidence, status, recommended_loop, assigned_agent_id, assigned_runtime,
        parent_goal_id, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.title.trim(),
      input.description.trim(),
      (input.source || 'manual').trim(),
      input.source_ref || null,
      riskClass,
      valueScore,
      confidence,
      status,
      input.recommended_loop || null,
      input.assigned_agent_id || null,
      input.assigned_runtime || null,
      input.parent_goal_id || null,
      JSON.stringify(input.metadata || {}),
      now,
      now
    );

    return this.get(id);
  }

  createIfMissingBySourceRef(
    input: WorkItemCreateInput,
    authority?: typeof BOARD_HANDOFF_AUTHORITY,
  ): { work_item: WorkItemRecord; created: boolean } {
    const normalized = this.normalizeSource(input);
    if (normalized.source === 'agent_board' && authority !== BOARD_HANDOFF_AUTHORITY) {
      throw new Error('BOARD_HANDOFF_REVIEW_REQUIRED');
    }
    if (normalized.source === 'agent_board'
      && (normalized.status !== 'blocked'
        || normalized.metadata?.approval_state !== 'REVIEW_REQUIRED'
        || normalized.metadata?.requires_human_approval !== true)) {
      throw new Error('BOARD_HANDOFF_REVIEW_REQUIRED');
    }
    if (normalized.source && normalized.source_ref) {
      const existing = this.db.prepare('SELECT * FROM work_items WHERE source = ? AND source_ref = ?').get(normalized.source, normalized.source_ref);
      if (existing) {
        return { work_item: this.parse(existing), created: false };
      }
    }
    return { work_item: this.insert(normalized), created: true };
  }

  private normalizeSource(input: WorkItemCreateInput): WorkItemCreateInput {
    return typeof input.source === 'string' ? { ...input, source: input.source.trim() } : input;
  }

  upsertBySourceRef(input: WorkItemCreateInput): { work_item: WorkItemRecord; created: boolean } {
    const normalized = this.normalizeSource(input);
    if (!normalized.source || !normalized.source_ref) {
      return { work_item: this.create(normalized), created: true };
    }
    const existing = this.db.prepare('SELECT * FROM work_items WHERE source = ? AND source_ref = ?').get(normalized.source, normalized.source_ref);
    if (!existing) {
      return { work_item: this.create(normalized), created: true };
    }
    const existingItem = this.parse(existing);
    const metadata = existingItem.source === SECURITY_FINDING_SOURCE
      && (existingItem.status === 'done' || existingItem.status === 'discarded')
      ? this.appendSecurityResolution(existingItem, input.metadata || {})
      : {
        ...existingItem.metadata,
        ...(normalized.metadata || {}),
        integration: {
          ...(objectValue(existingItem.metadata.integration) || {}),
          ...(objectValue(normalized.metadata?.integration) || {}),
        },
      };
    const rank = (risk: RiskClass): number => RISK_RANK[risk];
    const preservedOperatorState = existingItem.source === SECURITY_FINDING_SOURCE
      ? {}
      : {
        status: existingItem.status,
        assigned_agent_id: existingItem.assigned_agent_id,
        assigned_runtime: existingItem.assigned_runtime,
        parent_goal_id: existingItem.parent_goal_id,
        recommended_loop: existingItem.recommended_loop || normalized.recommended_loop,
      };
    return {
      work_item: this.update(existingItem.id, {
        title: normalized.title,
        description: normalized.description,
        risk_class: rank(normalized.risk_class || 'low') >= rank(existingItem.risk_class) ? normalized.risk_class : existingItem.risk_class,
        value_score: Math.max(existingItem.value_score, normalized.value_score || 0),
        confidence: Math.max(existingItem.confidence, normalized.confidence || 0),
        status: preservedOperatorState.status || normalized.status,
        recommended_loop: preservedOperatorState.recommended_loop,
        assigned_agent_id: preservedOperatorState.assigned_agent_id,
        assigned_runtime: preservedOperatorState.assigned_runtime,
        parent_goal_id: preservedOperatorState.parent_goal_id,
        metadata,
      }, { allowSecurityReopen: true }),
      created: false,
    };
  }

  list(filter: { status?: string; limit?: number } = {}): WorkItemRecord[] {
    const limit = Math.max(1, Math.min(Number(filter.limit || 100), 500));
    if (filter.status) {
      if (!VALID_STATUSES.includes(filter.status as WorkItemStatus)) {
        throw new Error('WORK_ITEM_STATUS_INVALID');
      }
      return (this.db.prepare('SELECT * FROM work_items WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(filter.status, limit) as any[])
        .map((row) => this.parse(row));
    }
    return (this.db.prepare('SELECT * FROM work_items ORDER BY created_at DESC LIMIT ?').all(limit) as any[])
      .map((row) => this.parse(row));
  }

  get(id: string): WorkItemRecord {
    const row = this.db.prepare('SELECT * FROM work_items WHERE id = ?').get(id);
    if (!row) {
      throw new Error('WORK_ITEM_NOT_FOUND');
    }
    return this.parse(row);
  }

  update(id: string, input: WorkItemUpdateInput, options: { allowSecurityReopen?: boolean } = {}): WorkItemRecord {
    const existing = this.get(id);
    if (existing.source === 'agent_board') throw new Error('BOARD_HANDOFF_REVIEW_REQUIRED');
    const next = {
      title: input.title ?? existing.title,
      description: input.description ?? existing.description,
      risk_class: input.risk_class ?? existing.risk_class,
      value_score: input.value_score ?? existing.value_score,
      confidence: input.confidence ?? existing.confidence,
      status: input.status ?? existing.status,
      recommended_loop: input.recommended_loop ?? existing.recommended_loop,
      assigned_agent_id: input.assigned_agent_id ?? existing.assigned_agent_id,
      assigned_runtime: input.assigned_runtime ?? existing.assigned_runtime,
      parent_goal_id: input.parent_goal_id ?? existing.parent_goal_id,
      metadata: input.metadata ?? existing.metadata,
    };
    this.validateUpdate(next);
    if (existing.source === SECURITY_FINDING_SOURCE) {
      const existingTerminal = existing.status === 'done' || existing.status === 'discarded';
      const nextTerminal = next.status === 'done' || next.status === 'discarded';
      if (existingTerminal && !nextTerminal && !options.allowSecurityReopen) {
        throw new Error('SECURITY_FINDING_REOPEN_IMPORT_REQUIRED');
      }
      if (RISK_RANK[next.risk_class] < RISK_RANK[existing.risk_class]) {
        throw new Error('SECURITY_FINDING_RISK_DOWNGRADE_FORBIDDEN');
      }
      const previousFinding = parseSecurityFindingContract(existing.metadata);
      const nextFinding = this.validateSecurityFindingState(
        existing.source_ref,
        next.risk_class,
        next.status,
        next.recommended_loop,
        next.parent_goal_id,
        next.metadata
      );
      if (['target', 'tool', 'rule_id', 'location'].some((field) => previousFinding[field] !== nextFinding[field])) {
        throw new Error('SECURITY_FINDING_IDENTITY_INVALID');
      }
      const previousHistory = Array.isArray(previousFinding.resolution_history) ? previousFinding.resolution_history : [];
      const nextHistory = Array.isArray(nextFinding.resolution_history) ? nextFinding.resolution_history : [];
      if (nextHistory.length < previousHistory.length
        || previousHistory.some((entry, index) => JSON.stringify(entry) !== JSON.stringify(nextHistory[index]))) {
        throw new Error('SECURITY_FINDING_HISTORY_IMMUTABLE');
      }
    }

    this.db.prepare(`
      UPDATE work_items
      SET title = ?, description = ?, risk_class = ?, value_score = ?, confidence = ?,
          status = ?, recommended_loop = ?, assigned_agent_id = ?, assigned_runtime = ?,
          parent_goal_id = ?, metadata = ?, updated_at = ?
      WHERE id = ?
    `).run(
      next.title.trim(),
      next.description.trim(),
      next.risk_class,
      this.normalizedInteger(next.value_score, existing.value_score, 0, 100),
      this.normalizedNumber(next.confidence, existing.confidence, 0, 1),
      next.status,
      next.recommended_loop || null,
      next.assigned_agent_id || null,
      next.assigned_runtime || null,
      next.parent_goal_id || null,
      JSON.stringify(next.metadata || {}),
      new Date().toISOString(),
      id
    );

    return this.get(id);
  }

  convertToGoal(id: string): { work_item: WorkItemRecord; goal_id: string } {
    return this.db.transaction(() => this.convertToGoalInTransaction(id))();
  }

  private convertToGoalInTransaction(id: string): { work_item: WorkItemRecord; goal_id: string } {
    const item = this.get(id);
    if (item.source === 'agent_board') throw new Error('BOARD_HANDOFF_REVIEW_REQUIRED');
    if (item.status === 'done' || item.status === 'discarded') {
      if (item.source === SECURITY_FINDING_SOURCE) throw new Error('SECURITY_FINDING_REOPEN_IMPORT_REQUIRED');
      throw new Error('WORK_ITEM_CONVERSION_INVALID_STATE');
    }
    // Repeated conversion is a read, never a new goal or a rewind of leased work.
    if (item.parent_goal_id) {
      if (!this.db.prepare('SELECT id FROM goals WHERE id = ?').get(item.parent_goal_id)) {
        throw new Error('WORK_ITEM_CONVERSION_GOAL_MISSING');
      }
      return { work_item: item, goal_id: item.parent_goal_id };
    }
    if (item.status !== 'candidate' && item.status !== 'triaged') {
      throw new Error('WORK_ITEM_CONVERSION_INVALID_STATE');
    }
    const now = new Date().toISOString();
    const goalId = randomUUID();
    const constraints = nonEmptyStringList(item.metadata.constraints);
    const acceptanceCriteria = nonEmptyStringList(item.metadata.acceptance_criteria);
    const falsificationTests = nonEmptyStringList(item.metadata.falsification_tests);
    const objective = nonEmptyString(item.metadata.objective) || item.title;
    this.db.prepare(`
      INSERT INTO goals (
        id, objective, constraints_json, acceptance_criteria_json, risk_class,
        budget_json, status, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      goalId,
      objective,
      JSON.stringify(constraints.length ? constraints : ['created_from_work_item']),
      JSON.stringify(acceptanceCriteria.length ? acceptanceCriteria : [item.description]),
      item.risk_class,
      JSON.stringify({ max_retries: 1, max_failure_count: 3 }),
      'created',
      JSON.stringify({
        ...item.metadata,
        source_work_item_id: item.id,
        source: item.source,
        source_ref: item.source_ref,
        recommended_loop: item.recommended_loop,
        falsification_tests: falsificationTests,
      }),
      now,
      now
    );

    const updated = this.update(id, {
      status: 'planned',
      parent_goal_id: goalId,
      metadata: { ...item.metadata, converted_to_goal_at: now },
    });
    return { work_item: updated, goal_id: goalId };
  }

  private validateCreate(input: WorkItemCreateInput): void {
    if (!input.title?.trim()) {
      throw new Error('WORK_ITEM_TITLE_REQUIRED');
    }
    if (!input.description?.trim()) {
      throw new Error('WORK_ITEM_DESCRIPTION_REQUIRED');
    }
    this.validateUpdate({
      title: input.title,
      description: input.description,
      risk_class: input.risk_class || 'low',
      value_score: input.value_score ?? 50,
      confidence: input.confidence ?? 0.5,
      status: input.status || 'candidate',
    });
    if ((input.source || 'manual').trim() === SECURITY_FINDING_SOURCE) {
      this.validateSecurityFindingState(
        input.source_ref || null,
        input.risk_class || 'low',
        input.status || 'candidate',
        input.recommended_loop || null,
        input.parent_goal_id || null,
        input.metadata || {}
      );
    }
  }

  private validateSecurityFindingState(
    sourceRef: string | null,
    riskClass: RiskClass,
    status: WorkItemStatus,
    recommendedLoop: string | null,
    parentGoalId: string | null,
    metadata: Record<string, unknown>
  ): SecurityFindingContract {
    const finding = parseSecurityFindingContract(metadata);
    const fingerprint = securityFindingFingerprint(finding);
    if (sourceRef !== fingerprint || finding.fingerprint !== fingerprint) {
      throw new Error('SECURITY_FINDING_IDENTITY_INVALID');
    }
    if (riskClass !== finding.severity) {
      throw new Error('SECURITY_FINDING_RISK_MISMATCH');
    }
    if (recommendedLoop !== 'security-regression-loop') {
      throw new Error('SECURITY_FINDING_LOOP_REQUIRED');
    }
    if (status === 'done') {
      this.validateSecurityFindingClosure(finding, riskClass, parentGoalId);
    }
    if (status === 'discarded') {
      this.validateSecurityFindingDisposition(finding, riskClass);
    }
    return finding;
  }

  private validateSecurityFindingClosure(finding: SecurityFindingContract, riskClass: RiskClass, parentGoalId: string | null): void {
    const closure = objectValue(finding.closure);
    const required = ['remediation_ref', 'rescan_ref', 'loop_ref'] as const;
    if (!closure || required.some((field) => !nonEmptyString(closure[field])) || !nonEmptyStringList(closure.regression_refs).length) {
      throw new Error('SECURITY_FINDING_CLOSURE_EVIDENCE_REQUIRED');
    }
    const loopRef = nonEmptyString(closure.loop_ref)!;
    const loopId = loopRef.startsWith('loop:') ? loopRef.slice('loop:'.length) : '';
    const loop = loopId ? this.db.prepare(`
      SELECT goal_id, loop_name, mode, status, gates_json, metadata
      FROM loop_runs WHERE id = ?
    `).get(loopId) as any | undefined : undefined;
    const gates = loop ? this.safeJsonArray(loop.gates_json) : [];
    const requiredGates = ['maker_checker_separation', 'checker_verdict', 'tests_lint_typecheck'];
    if (RISK_RANK[riskClass] >= RISK_RANK.high) requiredGates.push('security_checker_verdict');
    const allGatesPassed = requiredGates.every((name) => gates.some((gate) => objectValue(gate)?.name === name && objectValue(gate)?.status === 'pass'));
    const loopMetadata = loop ? objectValue(this.safeJson(loop.metadata, {})) : null;
    if (!loop
      || loop.goal_id !== parentGoalId
      || loop.loop_name !== 'security-regression-loop'
      || loop.mode !== 'closed'
      || loop.status !== 'completed'
      || !allGatesPassed
      || (RISK_RANK[riskClass] >= RISK_RANK.high && !nonEmptyString(loopMetadata?.human_approval_ref))) {
      throw new Error('SECURITY_FINDING_LOOP_EVIDENCE_REQUIRED');
    }
  }

  private appendSecurityResolution(existing: WorkItemRecord, metadata: Record<string, unknown>): Record<string, unknown> {
    const previous = parseSecurityFindingContract(existing.metadata);
    const incoming = parseSecurityFindingContract(metadata);
    const history = Array.isArray(previous.resolution_history) ? previous.resolution_history : [];
    const resolution = existing.status === 'done' ? previous.closure : previous.disposition;
    return {
      ...metadata,
      security: {
        ...incoming,
        resolution_history: [
          ...history,
          {
            status: existing.status,
            source_identity: previous.source_identity,
            resolved_at: existing.updated_at,
            evidence: resolution,
          },
        ],
      },
    };
  }

  private validateSecurityFindingDisposition(finding: SecurityFindingContract, riskClass: RiskClass): void {
    const disposition = objectValue(finding.disposition);
    const validTypes = ['false_positive', 'duplicate', 'out_of_scope', 'risk_accepted'];
    if (!disposition
      || !validTypes.includes(nonEmptyString(disposition.type) || '')
      || !nonEmptyString(disposition.reason)
      || !nonEmptyStringList(disposition.evidence_refs).length) {
      throw new Error('SECURITY_FINDING_DISPOSITION_EVIDENCE_REQUIRED');
    }
    if (RISK_RANK[riskClass] >= RISK_RANK.high
      && (!nonEmptyString(disposition.security_checker_ref) || !nonEmptyString(disposition.human_approval_ref))) {
      throw new Error('SECURITY_FINDING_INDEPENDENT_REVIEW_REQUIRED');
    }
  }

  private validateUpdate(input: WorkItemUpdateInput): void {
    if (input.title !== undefined && !input.title.trim()) {
      throw new Error('WORK_ITEM_TITLE_REQUIRED');
    }
    if (input.description !== undefined && !input.description.trim()) {
      throw new Error('WORK_ITEM_DESCRIPTION_REQUIRED');
    }
    if (input.risk_class && !VALID_RISKS.includes(input.risk_class)) {
      throw new Error('WORK_ITEM_RISK_INVALID');
    }
    if (input.status && !VALID_STATUSES.includes(input.status)) {
      throw new Error('WORK_ITEM_STATUS_INVALID');
    }
    if (input.value_score !== undefined) {
      this.normalizedInteger(input.value_score, 50, 0, 100);
    }
    if (input.confidence !== undefined) {
      this.normalizedNumber(input.confidence, 0.5, 0, 1);
    }
  }

  private normalizedInteger(input: unknown, fallback: number, min: number, max: number): number {
    const value = input === undefined ? fallback : Number(input);
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error('WORK_ITEM_NUMERIC_RANGE_INVALID');
    }
    return Math.floor(value);
  }

  private normalizedNumber(input: unknown, fallback: number, min: number, max: number): number {
    const value = input === undefined ? fallback : Number(input);
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error('WORK_ITEM_NUMERIC_RANGE_INVALID');
    }
    return value;
  }

  private safeJson(value: unknown, fallback: unknown): unknown {
    try {
      return typeof value === 'string' ? JSON.parse(value) : value;
    } catch {
      return fallback;
    }
  }

  private safeJsonArray(value: unknown): unknown[] {
    const parsed = this.safeJson(value, []);
    return Array.isArray(parsed) ? parsed : [];
  }

  private parse(row: any): WorkItemRecord {
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      source: row.source,
      source_ref: row.source_ref || null,
      risk_class: row.risk_class,
      value_score: row.value_score,
      confidence: row.confidence,
      status: row.status,
      recommended_loop: row.recommended_loop || null,
      assigned_agent_id: row.assigned_agent_id || null,
      assigned_runtime: row.assigned_runtime || null,
      parent_goal_id: row.parent_goal_id || null,
      metadata: JSON.parse(row.metadata || '{}'),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
