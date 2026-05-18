/**
 * Evidence, observability, and review-readiness types
 */

import { ID, Timestamps, RiskLevel, PolicyDecision } from './common';

export enum EvidenceType {
  EXECUTION_SUMMARY = 'execution_summary',
  RISK_ASSESSMENT = 'risk_assessment',
  POLICY_DECISION = 'policy_decision',
  APPROVAL_DECISION = 'approval_decision',
  COMMAND_OUTPUT = 'command_output',
  TEST_RESULT = 'test_result',
  FILE_CHANGE = 'file_change',
  DIFF = 'diff',
  ARTIFACT = 'artifact',
  ERROR = 'error',
  AUDIT_EVENT = 'audit_event',
}

export enum EvidenceSeverity {
  INFO = 'info',
  WARNING = 'warning',
  ERROR = 'error',
  CRITICAL = 'critical',
}

export type EvidenceSource = 'system' | 'executor' | 'policy' | 'approval' | 'user' | 'mcp';

export interface ExecutionEvidence extends Timestamps {
  id: ID;
  task_id: ID;
  execution_event_id: ID | null;
  approval_id: ID | null;
  evidence_type: EvidenceType;
  severity: EvidenceSeverity;
  title: string;
  summary: string;
  details: Record<string, unknown> | null;
  source: EvidenceSource;
  captured_at: string;
  metadata: Record<string, unknown>;
}

export interface ExecutionSummary extends Timestamps {
  id: ID;
  task_id: ID;
  executor_kind: string;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  final_status: 'completed' | 'failed' | 'cancelled' | 'denied';
  risk_level: RiskLevel;
  policy_decision: PolicyDecision;
  approval_required: boolean;
  approval_granted: boolean | null;
  event_count: number;
  error_count: number;
  warning_count: number;
  evidence_count: number;
  tool_call_count: number;
  files_changed: string[];
  commands_executed: string[];
  artifacts_created: string[];
  token_usage: number | null;
  metadata: Record<string, unknown>;
}

export interface FileChange extends Timestamps {
  id: ID;
  task_id: ID;
  execution_event_id: ID | null;
  file_path: string;
  change_type: 'created' | 'modified' | 'deleted';
  before_hash: string | null;
  after_hash: string | null;
  before_size: number | null;
  after_size: number | null;
  diff: string | null;
  risk_level: RiskLevel;
  detected_at: string;
  metadata: Record<string, unknown>;
}

export interface CaptureEvidenceInput {
  task_id: ID;
  execution_event_id?: ID;
  approval_id?: ID;
  evidence_type: EvidenceType;
  severity: EvidenceSeverity;
  title: string;
  summary: string;
  details?: Record<string, unknown>;
  source: EvidenceSource;
  captured_at?: string;
  metadata?: Record<string, unknown>;
}

export interface FileChangeInput {
  task_id: ID;
  execution_event_id?: ID;
  file_path: string;
  change_type: 'created' | 'modified' | 'deleted';
  before_hash?: string;
  after_hash?: string;
  before_size?: number;
  after_size?: number;
  diff?: string;
  risk_level?: RiskLevel;
  detected_at?: string;
  metadata?: Record<string, unknown>;
}

export interface ObservabilityMetrics {
  total_tasks: number;
  active_tasks: number;
  completed_tasks: number;
  failed_tasks: number;
  denied_tasks: number;
  pending_approvals: number;
  avg_duration_ms: number | null;
  risk_distribution: Record<RiskLevel, number>;
  policy_decisions: Record<PolicyDecision, number>;
  recent_errors: Array<{ task_id: ID; message: string; timestamp: string }>;
}

export interface AuditTrailEntry {
  timestamp: string;
  event_type: string;
  action: string;
  resource_type: string;
  resource_id: ID | null;
  risk_level: RiskLevel;
  actor: string | null;
  summary: string;
  metadata: Record<string, unknown>;
}