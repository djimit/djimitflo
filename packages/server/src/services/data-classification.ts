/**
 * Data Classification Model — information object taxonomy.
 *
 * Defines classification levels, data owners, retention rules,
 * and provider routing constraints for all information objects.
 */

export enum DataClassification {
  PUBLIC = 'public',
  INTERNAL = 'internal',
  CONFIDENTIAL = 'confidential',
  RESTRICTED = 'restricted',
}

export interface DataClassificationRule {
  classification: DataClassification;
  description: string;
  encryption_required: boolean;
  retention_days: number;
  allowed_roles: string[];
  provider_routing: 'any' | 'private_only' | 'on_premise_only';
  redaction_required: boolean;
  audit_required: boolean;
}

export const DATA_CLASSIFICATION_RULES: Record<DataClassification, DataClassificationRule> = {
  [DataClassification.PUBLIC]: {
    classification: DataClassification.PUBLIC,
    description: 'Non-sensitive data safe for public disclosure',
    encryption_required: false,
    retention_days: 365,
    allowed_roles: ['viewer', 'maker', 'checker', 'approver', 'auditor', 'operator', 'platform_admin', 'admin'],
    provider_routing: 'any',
    redaction_required: false,
    audit_required: false,
  },
  [DataClassification.INTERNAL]: {
    classification: DataClassification.INTERNAL,
    description: 'Internal operational data not for external distribution',
    encryption_required: false,
    retention_days: 730,
    allowed_roles: ['maker', 'checker', 'approver', 'auditor', 'operator', 'platform_admin', 'admin'],
    provider_routing: 'any',
    redaction_required: false,
    audit_required: true,
  },
  [DataClassification.CONFIDENTIAL]: {
    classification: DataClassification.CONFIDENTIAL,
    description: 'Sensitive data requiring protection (PII, credentials, business data)',
    encryption_required: true,
    retention_days: 365,
    allowed_roles: ['maker', 'checker', 'approver', 'auditor', 'platform_admin', 'admin'],
    provider_routing: 'private_only',
    redaction_required: true,
    audit_required: true,
  },
  [DataClassification.RESTRICTED]: {
    classification: DataClassification.RESTRICTED,
    description: 'Highly sensitive data (API keys, secrets, regulated information)',
    encryption_required: true,
    retention_days: 90,
    allowed_roles: ['admin'],
    provider_routing: 'on_premise_only',
    redaction_required: true,
    audit_required: true,
  },
};

export interface InformationObject {
  id: string;
  type: InformationObjectType;
  classification: DataClassification;
  data_owner: string;
  data_steward: string;
  purpose: string;
  tenant_id?: string;
  subject_context?: string;
  created_at: string;
  retention_until: string;
  legal_hold: boolean;
}

export type InformationObjectType =
  | 'task_description'
  | 'agent_message'
  | 'tool_input'
  | 'tool_output'
  | 'model_response'
  | 'rag_excerpt'
  | 'source_diff'
  | 'file_path'
  | 'approval_decision'
  | 'user_identifier'
  | 'audit_evidence'
  | 'provider_config'
  | 'cost_data'
  | 'benchmark_result';

export const INFORMATION_OBJECT_DEFAULTS: Record<InformationObject['type'], { classification: DataClassification; retention_days: number }> = {
  'task_description': { classification: DataClassification.INTERNAL, retention_days: 730 },
  'agent_message': { classification: DataClassification.INTERNAL, retention_days: 365 },
  'tool_input': { classification: DataClassification.CONFIDENTIAL, retention_days: 90 },
  'tool_output': { classification: DataClassification.CONFIDENTIAL, retention_days: 90 },
  'model_response': { classification: DataClassification.INTERNAL, retention_days: 365 },
  'rag_excerpt': { classification: DataClassification.INTERNAL, retention_days: 365 },
  'source_diff': { classification: DataClassification.CONFIDENTIAL, retention_days: 365 },
  'file_path': { classification: DataClassification.INTERNAL, retention_days: 365 },
  'approval_decision': { classification: DataClassification.INTERNAL, retention_days: 730 },
  'user_identifier': { classification: DataClassification.CONFIDENTIAL, retention_days: 365 },
  'audit_evidence': { classification: DataClassification.RESTRICTED, retention_days: 2555 },
  'provider_config': { classification: DataClassification.RESTRICTED, retention_days: 365 },
  'cost_data': { classification: DataClassification.INTERNAL, retention_days: 730 },
  'benchmark_result': { classification: DataClassification.PUBLIC, retention_days: 365 },
};

export function getClassificationRule(classification: DataClassification): DataClassificationRule {
  return DATA_CLASSIFICATION_RULES[classification];
}

export function canAccessClassification(userRole: string, classification: DataClassification): boolean {
  const rule = DATA_CLASSIFICATION_RULES[classification];
  return rule.allowed_roles.includes(userRole);
}

export function getRetentionDate(classification: DataClassification, createdDate: Date): Date {
  const rule = DATA_CLASSIFICATION_RULES[classification];
  return new Date(createdDate.getTime() + rule.retention_days * 24 * 60 * 60 * 1000);
}
