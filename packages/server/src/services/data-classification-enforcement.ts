/**
 * DataClassificationEnforcement — enforces data classification policies.
 *
 * Implements:
 * - PII detection and redaction
 * - Provider routing based on classification
 * - Encryption-at-rest markers
 * - Data retention enforcement
 */

import type { Database } from 'better-sqlite3';
import { DataClassification, type DataClassificationRule, getClassificationRule, getRetentionDate } from './data-classification';

export interface RedactionResult {
  redacted: string;
  redactions: Array<{ type: string; count: number; }>;
}

export interface ProviderRouting {
  allowed: boolean;
  reason: string;
  recommended_providers: string[];
}

export interface RetentionCheck {
  expired: boolean;
  retention_date: Date;
  days_overdue: number;
}

const PII_PATTERNS = [
  { type: 'email', pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  { type: 'phone', pattern: /(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g },
  { type: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  { type: 'credit_card', pattern: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g },
  { type: 'ip_address', pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g },
  { type: 'api_key', pattern: /\b(sk|pk|api|key)_[a-zA-Z0-9]{16,}\b/gi },
];

export class DataClassificationEnforcement {
  // Database handle for future use (e.g., storing redaction audit logs)
  constructor(_db?: Database) {}

  /**
   * Redact PII from a string based on classification level.
   */
  redact(content: string, classification: DataClassification): RedactionResult {
    const rule = getClassificationRule(classification);
    const redactions: Array<{ type: string; count: number; }> = [];
    let redacted = content;

    if (!rule.redaction_required) {
      return { redacted, redactions: [] };
    }

    for (const { type, pattern } of PII_PATTERNS) {
      const matches = redacted.match(pattern);
      if (matches && matches.length > 0) {
        redacted = redacted.replace(pattern, `[REDACTED_${type.toUpperCase()}]`);
        redactions.push({ type, count: matches.length });
      }
    }

    return { redacted, redactions };
  }

  /**
   * Check if a provider is allowed for a classification level.
   */
  checkProviderRouting(classification: DataClassification, provider: string): ProviderRouting {
    const rule = getClassificationRule(classification);

    const providerTiers: Record<string, string[]> = {
      'any': ['openai', 'anthropic', 'google', 'ollama', 'ollama-cloud', 'deepseek', 'openrouter', 'local'],
      'private_only': ['ollama', 'ollama-cloud', 'local', 'openai', 'anthropic'],
      'on_premise_only': ['ollama', 'local'],
    };

    const allowed = providerTiers[rule.provider_routing]?.includes(provider) ?? false;

    return {
      allowed,
      reason: allowed
        ? `Provider "${provider}" is allowed for ${classification} data`
        : `Provider "${provider}" is NOT allowed for ${classification} data. Allowed: ${providerTiers[rule.provider_routing]?.join(', ') || 'none'}`,
      recommended_providers: providerTiers[rule.provider_routing] || [],
    };
  }

  /**
   * Check if data has expired based on its classification retention policy.
   */
  checkRetention(classification: DataClassification, createdDate: Date): RetentionCheck {
    const retentionDate = getRetentionDate(classification, createdDate);
    const now = new Date();
    const expired = now > retentionDate;
    const daysOverdue = expired
      ? Math.floor((now.getTime() - retentionDate.getTime()) / (1000 * 60 * 60 * 24))
      : 0;

    return { expired, retention_date: retentionDate, days_overdue: daysOverdue };
  }

  /**
   * Check if encryption is required for a classification level.
   */
  requiresEncryption(classification: DataClassification): boolean {
    return getClassificationRule(classification).encryption_required;
  }

  /**
   * Check if audit logging is required for a classification level.
   */
  requiresAudit(classification: DataClassification): boolean {
    return getClassificationRule(classification).audit_required;
  }

  /**
   * Get the classification rule for a data type.
   */
  getRule(classification: DataClassification): DataClassificationRule {
    return getClassificationRule(classification);
  }

  /**
   * Enforce classification on a database record.
   * Returns true if the record is compliant.
   */
  enforceOnRecord(
    classification: DataClassification,
    record: { metadata?: string; created_at: string; encryption_status?: string },
  ): { compliant: boolean; issues: string[]; } {
    const issues: string[] = [];
    const rule = getClassificationRule(classification);

    // Check encryption requirement
    if (rule.encryption_required && record.encryption_status !== 'encrypted') {
      issues.push(`Encryption required for ${classification} data but not applied`);
    }

    // Check retention
    const retention = this.checkRetention(classification, new Date(record.created_at));
    if (retention.expired) {
      issues.push(`Data expired ${retention.days_overdue} days ago (retention: ${rule.retention_days} days)`);
    }

    return { compliant: issues.length === 0, issues };
  }
}
