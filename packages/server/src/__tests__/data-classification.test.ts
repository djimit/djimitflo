import { describe, expect, it } from 'vitest';
import {
  DataClassification,
  DATA_CLASSIFICATION_RULES,
  INFORMATION_OBJECT_DEFAULTS,
  canAccessClassification,
  getClassificationRule,
  getRetentionDate,
} from '../services/data-classification';

describe('DataClassification', () => {
  describe('classification rules', () => {
    it('PUBLIC has lowest protection', () => {
      const rule = getClassificationRule(DataClassification.PUBLIC);
      expect(rule.encryption_required).toBe(false);
      expect(rule.redaction_required).toBe(false);
      expect(rule.audit_required).toBe(false);
      expect(rule.retention_days).toBe(365);
    });

    it('RESTRICTED has highest protection', () => {
      const rule = getClassificationRule(DataClassification.RESTRICTED);
      expect(rule.encryption_required).toBe(true);
      expect(rule.redaction_required).toBe(true);
      expect(rule.audit_required).toBe(true);
      expect(rule.provider_routing).toBe('on_premise_only');
      expect(rule.retention_days).toBe(90);
    });

    it('CONFIDENTIAL requires encryption', () => {
      const rule = getClassificationRule(DataClassification.CONFIDENTIAL);
      expect(rule.encryption_required).toBe(true);
      expect(rule.redaction_required).toBe(true);
      expect(rule.provider_routing).toBe('private_only');
    });

    it('INTERNAL requires audit but no encryption', () => {
      const rule = getClassificationRule(DataClassification.INTERNAL);
      expect(rule.encryption_required).toBe(false);
      expect(rule.audit_required).toBe(true);
      expect(rule.retention_days).toBe(730);
    });
  });

  describe('role access control', () => {
    it('viewer can access PUBLIC and INTERNAL', () => {
      expect(canAccessClassification('viewer', DataClassification.PUBLIC)).toBe(true);
      expect(canAccessClassification('viewer', DataClassification.INTERNAL)).toBe(true);
    });

    it('viewer cannot access CONFIDENTIAL or RESTRICTED', () => {
      expect(canAccessClassification('viewer', DataClassification.CONFIDENTIAL)).toBe(false);
      expect(canAccessClassification('viewer', DataClassification.RESTRICTED)).toBe(false);
    });

    it('admin can access all classifications', () => {
      expect(canAccessClassification('admin', DataClassification.PUBLIC)).toBe(true);
      expect(canAccessClassification('admin', DataClassification.INTERNAL)).toBe(true);
      expect(canAccessClassification('admin', DataClassification.CONFIDENTIAL)).toBe(true);
      expect(canAccessClassification('admin', DataClassification.RESTRICTED)).toBe(true);
    });

    it('maker can access PUBLIC, INTERNAL, CONFIDENTIAL', () => {
      expect(canAccessClassification('maker', DataClassification.PUBLIC)).toBe(true);
      expect(canAccessClassification('maker', DataClassification.INTERNAL)).toBe(true);
      expect(canAccessClassification('maker', DataClassification.CONFIDENTIAL)).toBe(true);
    });

    it('maker cannot access RESTRICTED', () => {
      expect(canAccessClassification('maker', DataClassification.RESTRICTED)).toBe(false);
    });

    it('auditor can access PUBLIC and INTERNAL', () => {
      expect(canAccessClassification('auditor', DataClassification.PUBLIC)).toBe(true);
      expect(canAccessClassification('auditor', DataClassification.INTERNAL)).toBe(true);
    });

    it('auditor can access PUBLIC, INTERNAL, and CONFIDENTIAL (for audit)', () => {
      expect(canAccessClassification('auditor', DataClassification.PUBLIC)).toBe(true);
      expect(canAccessClassification('auditor', DataClassification.INTERNAL)).toBe(true);
      expect(canAccessClassification('auditor', DataClassification.CONFIDENTIAL)).toBe(true);
    });

    it('auditor cannot access RESTRICTED (admin only)', () => {
      expect(canAccessClassification('auditor', DataClassification.RESTRICTED)).toBe(false);
    });
  });

  describe('retention dates', () => {
    it('PUBLIC retention is 365 days', () => {
      const created = new Date(Date.UTC(2024, 0, 1));
      const retention = getRetentionDate(DataClassification.PUBLIC, created);
      const daysDiff = (retention.getTime() - created.getTime()) / (1000 * 60 * 60 * 24);
      expect(daysDiff).toBe(365);
    });

    it('RESTRICTED retention is 90 days', () => {
      const created = new Date(Date.UTC(2024, 0, 1));
      const retention = getRetentionDate(DataClassification.RESTRICTED, created);
      const daysDiff = (retention.getTime() - created.getTime()) / (1000 * 60 * 60 * 24);
      expect(daysDiff).toBe(90);
    });

    it('INTERNAL retention is 730 days', () => {
      const created = new Date(Date.UTC(2024, 0, 1));
      const retention = getRetentionDate(DataClassification.INTERNAL, created);
      const daysDiff = (retention.getTime() - created.getTime()) / (1000 * 60 * 60 * 24);
      expect(daysDiff).toBe(730);
    });
  });

  describe('information object defaults', () => {
    it('task_description defaults to INTERNAL', () => {
      expect(INFORMATION_OBJECT_DEFAULTS['task_description'].classification).toBe(DataClassification.INTERNAL);
    });

    it('tool_input defaults to CONFIDENTIAL', () => {
      expect(INFORMATION_OBJECT_DEFAULTS['tool_input'].classification).toBe(DataClassification.CONFIDENTIAL);
    });

    it('audit_evidence defaults to RESTRICTED', () => {
      expect(INFORMATION_OBJECT_DEFAULTS['audit_evidence'].classification).toBe(DataClassification.RESTRICTED);
    });

    it('benchmark_result defaults to PUBLIC', () => {
      expect(INFORMATION_OBJECT_DEFAULTS['benchmark_result'].classification).toBe(DataClassification.PUBLIC);
    });

    it('provider_config defaults to RESTRICTED', () => {
      expect(INFORMATION_OBJECT_DEFAULTS['provider_config'].classification).toBe(DataClassification.RESTRICTED);
    });

    it('all 14 information object types have defaults', () => {
      const types = [
        'task_description', 'agent_message', 'tool_input', 'tool_output',
        'model_response', 'rag_excerpt', 'source_diff', 'file_path',
        'approval_decision', 'user_identifier', 'audit_evidence',
        'provider_config', 'cost_data', 'benchmark_result',
      ];
      for (const type of types) {
        expect(INFORMATION_OBJECT_DEFAULTS[type as keyof typeof INFORMATION_OBJECT_DEFAULTS]).toBeDefined();
      }
    });
  });

  describe('provider routing', () => {
    it('PUBLIC allows any provider', () => {
      expect(DATA_CLASSIFICATION_RULES[DataClassification.PUBLIC].provider_routing).toBe('any');
    });

    it('CONFIDENTIAL requires private_only', () => {
      expect(DATA_CLASSIFICATION_RULES[DataClassification.CONFIDENTIAL].provider_routing).toBe('private_only');
    });

    it('RESTRICTED requires on_premise_only', () => {
      expect(DATA_CLASSIFICATION_RULES[DataClassification.RESTRICTED].provider_routing).toBe('on_premise_only');
    });
  });
});
