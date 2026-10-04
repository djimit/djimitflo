import { afterEach, describe, expect, it } from 'vitest';
import { PARKED_PROPOSAL_TTL_DAYS, WORK_ITEM_TTL_DAYS, queueHygieneEnabled } from '../services/queue-hygiene-service';

describe('queue-hygiene-service — exports', () => {
  const original = process.env.QUEUE_HYGIENE_ENABLED;

  afterEach(() => {
    if (original === undefined) delete process.env.QUEUE_HYGIENE_ENABLED;
    else process.env.QUEUE_HYGIENE_ENABLED = original;
  });

  describe('queueHygieneEnabled', () => {
    it('returns true when QUEUE_HYGIENE_ENABLED is "true"', () => {
      process.env.QUEUE_HYGIENE_ENABLED = 'true';
      expect(queueHygieneEnabled()).toBe(true);
    });

    it('returns false when QUEUE_HYGIENE_ENABLED is unset', () => {
      delete process.env.QUEUE_HYGIENE_ENABLED;
      expect(queueHygieneEnabled()).toBe(false);
    });

    it('returns false when QUEUE_HYGIENE_ENABLED is any other value', () => {
      process.env.QUEUE_HYGIENE_ENABLED = 'false';
      expect(queueHygieneEnabled()).toBe(false);
      process.env.QUEUE_HYGIENE_ENABLED = '1';
      expect(queueHygieneEnabled()).toBe(false);
    });
  });

  describe('WORK_ITEM_TTL_DAYS', () => {
    it('maps known loops to positive day thresholds', () => {
      expect(WORK_ITEM_TTL_DAYS['agent-board-review-loop']).toBe(14);
      expect(WORK_ITEM_TTL_DAYS['okf-synchronization-loop']).toBe(14);
      expect(WORK_ITEM_TTL_DAYS['openmythos-evolution-loop']).toBe(30);
    });

    it('returns undefined for an unknown loop', () => {
      expect(WORK_ITEM_TTL_DAYS['unknown-loop']).toBeUndefined();
    });
  });

  describe('PARKED_PROPOSAL_TTL_DAYS', () => {
    it('is a positive integer threshold', () => {
      expect(typeof PARKED_PROPOSAL_TTL_DAYS).toBe('number');
      expect(PARKED_PROPOSAL_TTL_DAYS).toBeGreaterThan(0);
      expect(Number.isInteger(PARKED_PROPOSAL_TTL_DAYS)).toBe(true);
    });

    it('matches the documented 14-day parked proposal drain window', () => {
      expect(PARKED_PROPOSAL_TTL_DAYS).toBe(14);
    });
  });
});