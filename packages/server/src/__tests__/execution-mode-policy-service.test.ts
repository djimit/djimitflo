import { describe, it, expect, beforeEach } from 'vitest';
import { ExecutionModePolicyService, EXECUTION_MODE_CONFIGS, type ExecutionModeConfig } from '../services/execution-mode-policy-service';
import { EvidenceType } from '@djimitflo/shared';
import type { ExecutionMode } from '../services/fallback-chain-service';

const T = EvidenceType.TEST_RESULT;
const RS = EvidenceType.REPOSITORY_SCAN;
const AE = EvidenceType.AUDIT_EVENT;
const AD = EvidenceType.APPROVAL_DECISION;
const AR = EvidenceType.ARTIFACT;

const FAST_EVIDENCE = [T, RS];
const STANDARD_EVIDENCE = [T, RS];
const CONTROLLED_EVIDENCE = [T, RS, AE, AD];
const RESTRICTED_EVIDENCE = [T, RS, AE, AD, AR];
const FAST_GATES = ['task_review'];
const STANDARD_GATES = ['task_review', 'security_gate'];
const CONTROLLED_GATES = ['task_review', 'security_gate', 'compliance_gate'];
const RESTRICTED_GATES = ['task_review', 'security_gate', 'compliance_gate', 'final_review'];

describe('ExecutionModePolicyService', () => {
  let policy: ExecutionModePolicyService;
  beforeEach(() => { policy = new ExecutionModePolicyService(); });

  describe('checkCompliance', () => {
    it('fast: compliant with all fields zero/empty', () => {
      const r = policy.checkCompliance('fast', FAST_EVIDENCE, FAST_GATES, false, false);
      expect(r).toMatchObject({ compliant: true, missingEvidence: [], missingGates: [], humanApprovalMissing: false, sandboxMissing: false });
    });

    it('fast: missing evidence only', () => {
      const r = policy.checkCompliance('fast', [T], FAST_GATES, false, false);
      expect(r).toMatchObject({ compliant: false, missingEvidence: [RS], missingGates: [], humanApprovalMissing: false, sandboxMissing: false });
    });

    it('fast: missing gate only', () => {
      const r = policy.checkCompliance('fast', FAST_EVIDENCE, [], false, false);
      expect(r).toMatchObject({ compliant: false, missingGates: ['task_review'], missingEvidence: [] });
    });

    it('standard: compliant with sandbox', () => {
      expect(policy.checkCompliance('standard', STANDARD_EVIDENCE, STANDARD_GATES, false, true).compliant).toBe(true);
    });

    it('standard: sandbox missing only', () => {
      const r = policy.checkCompliance('standard', STANDARD_EVIDENCE, STANDARD_GATES, false, false);
      expect(r).toMatchObject({ compliant: false, sandboxMissing: true, missingEvidence: [], missingGates: [] });
    });

    it('standard: missing security_gate only', () => {
      const r = policy.checkCompliance('standard', STANDARD_EVIDENCE, ['task_review'], false, true);
      expect(r).toMatchObject({ compliant: false, missingGates: ['security_gate'] });
    });

    it('controlled: compliant with approval', () => {
      expect(policy.checkCompliance('controlled', CONTROLLED_EVIDENCE, CONTROLLED_GATES, true, true).compliant).toBe(true);
    });

    it('controlled: human approval missing only', () => {
      const r = policy.checkCompliance('controlled', CONTROLLED_EVIDENCE, CONTROLLED_GATES, false, true);
      expect(r).toMatchObject({ compliant: false, humanApprovalMissing: true, missingEvidence: [], missingGates: [], sandboxMissing: false });
    });

    it('controlled: multiple missing evidence in order', () => {
      const r = policy.checkCompliance('controlled', [T], CONTROLLED_GATES, true, true);
      expect(r.missingEvidence).toEqual([RS, RS, AE, AD]);
      expect(r.missingGates).toEqual([]);
    });

    it('controlled: multiple missing gates in order', () => {
      const r = policy.checkCompliance('controlled', CONTROLLED_EVIDENCE, ['task_review'], true, true);
      expect(r.missingGates).toEqual(['security_gate', 'compliance_gate']);
      expect(r.missingEvidence).toEqual([]);
    });

    it('restricted: compliant with all', () => {
      const r = policy.checkCompliance('restricted', RESTRICTED_EVIDENCE, RESTRICTED_GATES, true, true);
      expect(r).toMatchObject({ compliant: true, missingEvidence: [], missingGates: [], humanApprovalMissing: false, sandboxMissing: false });
    });

    it('restricted: missing artifact only', () => {
      const r = policy.checkCompliance('restricted', CONTROLLED_EVIDENCE, RESTRICTED_GATES, true, true);
      expect(r).toMatchObject({ compliant: false, missingEvidence: [AR] });
    });

    it('restricted: missing final_review gate only', () => {
      const r = policy.checkCompliance('restricted', RESTRICTED_EVIDENCE, CONTROLLED_GATES, true, true);
      expect(r).toMatchObject({ compliant: false, missingGates: ['final_review'] });
    });

    it('accepts superset evidence and gates', () => {
      const r = policy.checkCompliance('fast', [T, RS, AR, AE], ['task_review', 'security_gate', 'extra'], true, true);
      expect(r).toMatchObject({ compliant: true, missingEvidence: [], missingGates: [] });
    });

    it('all four failure flags set when nothing provided (controlled)', () => {
      const r = policy.checkCompliance('controlled', [], [], false, false);
      expect(r.compliant).toBe(false);
      expect(r.missingEvidence.length).toBeGreaterThan(0);
      expect(r.missingGates.length).toBeGreaterThan(0);
      expect(r.humanApprovalMissing).toBe(true);
      expect(r.sandboxMissing).toBe(true);
    });

    it('falls back to standard for unknown mode (sandbox required)', () => {
      const r = policy.checkCompliance('unknown' as ExecutionMode, STANDARD_EVIDENCE, STANDARD_GATES, false, true);
      expect(r.compliant).toBe(true);
      expect(r.sandboxMissing).toBe(false);
    });

    it('falls back to standard for unknown mode (sandbox missing)', () => {
      const r = policy.checkCompliance('unknown' as ExecutionMode, STANDARD_EVIDENCE, STANDARD_GATES, false, false);
      expect(r).toMatchObject({ compliant: false, sandboxMissing: true });
    });

    it('falls back to standard for unknown mode (gates missing)', () => {
      const r = policy.checkCompliance('unknown' as ExecutionMode, STANDARD_EVIDENCE, [], false, true);
      expect(r.missingGates).toEqual(STANDARD_GATES);
    });
  });

  describe('getConfig', () => {
    const expectedConfigs: Record<ExecutionMode, ExecutionModeConfig> = {
      fast: { mode: 'fast', requiredEvidence: [T, RS], requiredGates: ['task_review'], sandboxRequired: false, maxRetries: 1, humanApprovalRequired: false, description: 'Minimal overhead for docs, tests, small internal changes' },
      standard: { mode: 'standard', requiredEvidence: [T, RS, RS], requiredGates: ['task_review', 'security_gate'], sandboxRequired: true, maxRetries: 2, humanApprovalRequired: false, description: 'Regular features and API changes with security scanning' },
      controlled: { mode: 'controlled', requiredEvidence: [T, RS, RS, AE, AD], requiredGates: ['task_review', 'security_gate', 'compliance_gate'], sandboxRequired: true, maxRetries: 3, humanApprovalRequired: true, description: 'IAM, PII, infrastructure, external APIs with full evidence' },
      restricted: { mode: 'restricted', requiredEvidence: [T, RS, RS, AE, AD, AR], requiredGates: ['task_review', 'security_gate', 'compliance_gate', 'final_review'], sandboxRequired: true, maxRetries: 0, humanApprovalRequired: true, description: 'Crypto, production identity, critical infrastructure — no autonomous merge' },
    };

    it.each(['fast', 'standard', 'controlled', 'restricted'] as ExecutionMode[])('returns exact config for %s mode', (mode) => {
      expect(policy.getConfig(mode)).toEqual(expectedConfigs[mode]);
    });

    it('falls back to standard for unknown mode', () => {
      const config = policy.getConfig('foobar' as ExecutionMode);
      expect(config).toEqual(expectedConfigs.standard);
    });

    it('EXECUTION_MODE_CONFIGS has exactly four modes', () => {
      expect(Object.keys(EXECUTION_MODE_CONFIGS).sort()).toEqual(['controlled', 'fast', 'restricted', 'standard']);
    });
  });

  describe('shouldBlockMerge', () => {
    it('not blocked for compliant fast execution', () => {
      expect(policy.shouldBlockMerge('fast', FAST_EVIDENCE, FAST_GATES, false, false)).toEqual({ blocked: false, reasons: [] });
    });

    it('not blocked for compliant restricted execution', () => {
      expect(policy.shouldBlockMerge('restricted', RESTRICTED_EVIDENCE, RESTRICTED_GATES, true, true)).toEqual({ blocked: false, reasons: [] });
    });

    it('all four reasons in order for controlled with nothing', () => {
      const r = policy.shouldBlockMerge('controlled', [], [], false, false);
      expect(r.blocked).toBe(true);
      expect(r.reasons).toEqual([
        `Missing evidence: ${T}, ${RS}, ${RS}, ${AE}, ${AD}`,
        'Missing gates: task_review, security_gate, compliance_gate',
        'Human approval required but not obtained',
        'Sandbox execution required but not used',
      ]);
    });

    it('only missing evidence reason for fast', () => {
      const r = policy.shouldBlockMerge('fast', [T], FAST_GATES, false, false);
      expect(r).toEqual({ blocked: true, reasons: [`Missing evidence: ${RS}`] });
    });

    it('only missing gate reason for fast', () => {
      const r = policy.shouldBlockMerge('fast', FAST_EVIDENCE, [], false, false);
      expect(r).toEqual({ blocked: true, reasons: ['Missing gates: task_review'] });
    });

    it('only human approval reason for controlled', () => {
      const r = policy.shouldBlockMerge('controlled', CONTROLLED_EVIDENCE, CONTROLLED_GATES, false, true);
      expect(r).toEqual({ blocked: true, reasons: ['Human approval required but not obtained'] });
    });

    it('only sandbox reason for standard', () => {
      const r = policy.shouldBlockMerge('standard', STANDARD_EVIDENCE, STANDARD_GATES, false, false);
      expect(r).toEqual({ blocked: true, reasons: ['Sandbox execution required but not used'] });
    });

    it('evidence and gate reasons only (fast, no approval/sandbox needed)', () => {
      const r = policy.shouldBlockMerge('fast', [], [], false, false);
      expect(r.reasons).toEqual([
        `Missing evidence: ${T}, ${RS}`,
        'Missing gates: task_review',
      ]);
    });

    it('not blocked for unknown mode when standard-compliant', () => {
      expect(policy.shouldBlockMerge('unknown' as ExecutionMode, STANDARD_EVIDENCE, STANDARD_GATES, false, true)).toEqual({ blocked: false, reasons: [] });
    });

    it('blocked with sandbox reason for unknown mode without sandbox', () => {
      const r = policy.shouldBlockMerge('unknown' as ExecutionMode, STANDARD_EVIDENCE, STANDARD_GATES, false, false);
      expect(r).toEqual({ blocked: true, reasons: ['Sandbox execution required but not used'] });
    });
  });
});