import { describe, expect, it } from 'vitest';
import { verifiedDeliveredOutcomeSql } from '../services/skill-artifact-evolution-service';
import { COMPLETED_UNVERIFIED_REF, DELIVERED_ATTRIBUTION_SQL } from '../services/skill-evolution-engine';

describe('skill-artifact-evolution-service exports (verifiedDeliveredOutcomeSql)', () => {
  describe('verifiedDeliveredOutcomeSql', () => {
    it('is a function taking no arguments', () => {
      expect(typeof verifiedDeliveredOutcomeSql).toBe('function');
      expect(verifiedDeliveredOutcomeSql.length).toBe(0);
    });

    it('returns a non-empty string', () => {
      const sql = verifiedDeliveredOutcomeSql();
      expect(typeof sql).toBe('string');
      expect(sql.length).toBeGreaterThan(0);
    });

    it('requires success = 1 (a verified, delivered outcome, never a bare process exit)', () => {
      const sql = verifiedDeliveredOutcomeSql();
      expect(sql).toContain('success = 1');
      expect(sql.startsWith('success = 1')).toBe(true);
    });

    it('embeds the delivered attribution SQL from skill-evolution-engine', () => {
      const sql = verifiedDeliveredOutcomeSql();
      expect(sql).toContain(DELIVERED_ATTRIBUTION_SQL);
      expect(sql).toContain('skill_delivery:delivered');
    });

    it('excludes outcomes still carrying the completed_unverified receipt ref', () => {
      const sql = verifiedDeliveredOutcomeSql();
      expect(sql).toContain(`"${COMPLETED_UNVERIFIED_REF}"`);
      expect(sql).toContain('NOT LIKE');
      expect(sql).toContain(COMPLETED_UNVERIFIED_REF);
    });

    it('returns the same value on every call (pure, deterministic)', () => {
      expect(verifiedDeliveredOutcomeSql()).toBe(verifiedDeliveredOutcomeSql());
    });

    it('is a valid conjunctive SQL fragment combining all three predicates', () => {
      const sql = verifiedDeliveredOutcomeSql();
      expect(sql).toContain(' AND ');
      expect(sql).toContain('evidence_refs_json');
    });
  });
});
