import { describe, it, expect, beforeEach } from 'vitest';
import { ExecutionModePolicyService } from '../services/execution-mode-policy-service';
import { EvidenceType } from '@djimitflo/shared';

describe('ExecutionModePolicyService', () => {
  let policy: ExecutionModePolicyService;

  beforeEach(() => {
    policy = new ExecutionModePolicyService();
  });

  it('passes fast mode with minimal evidence', () => {
    const result = policy.checkCompliance(
      'fast',
      [EvidenceType.TEST_RESULT, EvidenceType.REPOSITORY_SCAN],
      ['task_review'],
      false,
      false,
    );
    expect(result.compliant).toBe(true);
  });

  it('blocks fast mode without required evidence', () => {
    const result = policy.checkCompliance(
      'fast',
      [EvidenceType.TEST_RESULT],
      ['task_review'],
      false,
      false,
    );
    expect(result.compliant).toBe(false);
    expect(result.missingEvidence).toContain(EvidenceType.REPOSITORY_SCAN);
  });

  it('requires sandbox for standard mode', () => {
    const result = policy.checkCompliance(
      'standard',
      [EvidenceType.TEST_RESULT, EvidenceType.REPOSITORY_SCAN],
      ['task_review', 'security_gate'],
      false,
      false, // sandbox not used
    );
    expect(result.compliant).toBe(false);
    expect(result.sandboxMissing).toBe(true);
  });

  it('requires human approval for controlled mode', () => {
    const result = policy.checkCompliance(
      'controlled',
      [EvidenceType.TEST_RESULT, EvidenceType.REPOSITORY_SCAN, EvidenceType.AUDIT_EVENT, EvidenceType.APPROVAL_DECISION],
      ['task_review', 'security_gate', 'compliance_gate'],
      false, // no human approval
      true,
    );
    expect(result.compliant).toBe(false);
    expect(result.humanApprovalMissing).toBe(true);
  });

  it('passes restricted mode with all requirements', () => {
    const result = policy.checkCompliance(
      'restricted',
      [EvidenceType.TEST_RESULT, EvidenceType.REPOSITORY_SCAN, EvidenceType.AUDIT_EVENT, EvidenceType.APPROVAL_DECISION, EvidenceType.ARTIFACT],
      ['task_review', 'security_gate', 'compliance_gate', 'final_review'],
      true,
      true,
    );
    expect(result.compliant).toBe(true);
  });

  it('blocks merge with reasons', () => {
    const result = policy.shouldBlockMerge(
      'controlled',
      [],
      [],
      false,
      false,
    );
    expect(result.blocked).toBe(true);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('returns correct config for each mode', () => {
    const fastConfig = policy.getConfig('fast');
    expect(fastConfig.sandboxRequired).toBe(false);
    expect(fastConfig.humanApprovalRequired).toBe(false);

    const restrictedConfig = policy.getConfig('restricted');
    expect(restrictedConfig.sandboxRequired).toBe(true);
    expect(restrictedConfig.humanApprovalRequired).toBe(true);
    expect(restrictedConfig.maxRetries).toBe(0);
  });
});
