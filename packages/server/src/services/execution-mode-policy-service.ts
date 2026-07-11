/**
 * ExecutionModePolicyService — risk-based execution policy per mode.
 *
 * Defines required evidence, gates, and constraints per execution mode:
 * - fast: Minimal overhead, auto-merge allowed
 * - standard: Plan approval + security scan + final review
 * - controlled: Architecture + security + privacy approval, full evidence
 * - restricted: Separate human review, limited agent rights, no autonomous merge
 */

import { EvidenceType } from '@djimitflo/shared';
import { ExecutionMode } from './fallback-chain-service';

export interface ExecutionModeConfig {
  mode: ExecutionMode;
  requiredEvidence: EvidenceType[];
  requiredGates: string[];
  sandboxRequired: boolean;
  maxRetries: number;
  humanApprovalRequired: boolean;
  description: string;
}

export const EXECUTION_MODE_CONFIGS: Record<ExecutionMode, ExecutionModeConfig> = {
  fast: {
    mode: 'fast',
    requiredEvidence: [EvidenceType.TEST_RESULT, EvidenceType.REPOSITORY_SCAN],
    requiredGates: ['task_review'],
    sandboxRequired: false,
    maxRetries: 1,
    humanApprovalRequired: false,
    description: 'Minimal overhead for docs, tests, small internal changes',
  },
  standard: {
    mode: 'standard',
    requiredEvidence: [EvidenceType.TEST_RESULT, EvidenceType.REPOSITORY_SCAN, EvidenceType.REPOSITORY_SCAN],
    requiredGates: ['task_review', 'security_gate'],
    sandboxRequired: true,
    maxRetries: 2,
    humanApprovalRequired: false,
    description: 'Regular features and API changes with security scanning',
  },
  controlled: {
    mode: 'controlled',
    requiredEvidence: [
      EvidenceType.TEST_RESULT,
      EvidenceType.REPOSITORY_SCAN,
      EvidenceType.REPOSITORY_SCAN,
      EvidenceType.AUDIT_EVENT,
      EvidenceType.APPROVAL_DECISION,
    ],
    requiredGates: ['task_review', 'security_gate', 'compliance_gate'],
    sandboxRequired: true,
    maxRetries: 3,
    humanApprovalRequired: true,
    description: 'IAM, PII, infrastructure, external APIs with full evidence',
  },
  restricted: {
    mode: 'restricted',
    requiredEvidence: [
      EvidenceType.TEST_RESULT,
      EvidenceType.REPOSITORY_SCAN,
      EvidenceType.REPOSITORY_SCAN,
      EvidenceType.AUDIT_EVENT,
      EvidenceType.APPROVAL_DECISION,
      EvidenceType.ARTIFACT,
    ],
    requiredGates: ['task_review', 'security_gate', 'compliance_gate', 'final_review'],
    sandboxRequired: true,
    maxRetries: 0,
    humanApprovalRequired: true,
    description: 'Crypto, production identity, critical infrastructure — no autonomous merge',
  },
};

export interface ComplianceCheckResult {
  compliant: boolean;
  missingEvidence: EvidenceType[];
  missingGates: string[];
  humanApprovalMissing: boolean;
  sandboxMissing: boolean;
}

export class ExecutionModePolicyService {
  /**
   * Check if a task execution meets the requirements for its execution mode.
   */
  checkCompliance(
    mode: ExecutionMode,
    evidence: EvidenceType[],
    gatesPassed: string[],
    hasHumanApproval: boolean,
    sandboxUsed: boolean,
  ): ComplianceCheckResult {
    const config = EXECUTION_MODE_CONFIGS[mode] || EXECUTION_MODE_CONFIGS.standard;

    const missingEvidence = config.requiredEvidence.filter((e) => !evidence.includes(e));
    const missingGates = config.requiredGates.filter((g) => !gatesPassed.includes(g));
    const humanApprovalMissing = config.humanApprovalRequired && !hasHumanApproval;
    const sandboxMissing = config.sandboxRequired && !sandboxUsed;

    return {
      compliant:
        missingEvidence.length === 0 &&
        missingGates.length === 0 &&
        !humanApprovalMissing &&
        !sandboxMissing,
      missingEvidence,
      missingGates,
      humanApprovalMissing,
      sandboxMissing,
    };
  }

  /**
   * Get the config for an execution mode.
   */
  getConfig(mode: ExecutionMode): ExecutionModeConfig {
    return EXECUTION_MODE_CONFIGS[mode] || EXECUTION_MODE_CONFIGS.standard;
  }

  /**
   * Check if merge should be blocked for a given execution mode.
   */
  shouldBlockMerge(
    mode: ExecutionMode,
    evidence: EvidenceType[],
    gatesPassed: string[],
    hasHumanApproval: boolean,
    sandboxUsed: boolean,
  ): { blocked: boolean; reasons: string[] } {
    const result = this.checkCompliance(mode, evidence, gatesPassed, hasHumanApproval, sandboxUsed);
    const reasons: string[] = [];

    if (!result.compliant) {
      if (result.missingEvidence.length > 0) {
        reasons.push(`Missing evidence: ${result.missingEvidence.join(', ')}`);
      }
      if (result.missingGates.length > 0) {
        reasons.push(`Missing gates: ${result.missingGates.join(', ')}`);
      }
      if (result.humanApprovalMissing) {
        reasons.push('Human approval required but not obtained');
      }
      if (result.sandboxMissing) {
        reasons.push('Sandbox execution required but not used');
      }
    }

    return { blocked: reasons.length > 0, reasons };
  }
}
