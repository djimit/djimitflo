import { describe, expect, it } from 'vitest';
import {
  attributionOf,
  policyClass,
  requeueVerdict,
  AUTO_DISMISS_AFTER_DAYS,
  MAKER_FAILURE_GATE,
  type PolicyCandidate,
  type PolicyContext,
} from '../services/requeue-policy';

const baseCandidate = (over: Partial<PolicyCandidate> = {}): PolicyCandidate => ({
  id: 'imp-1',
  status: 'infra_failed',
  updated_at: '2026-10-01T00:00:00.000Z',
  queue_class: 'ready',
  attribution: null,
  evidence_refs_json: '[]',
  grounding_json: null,
  escalated: 0,
  ...over,
});

const baseCtx = (over: Partial<PolicyContext> = {}): PolicyContext => ({
  now: Date.parse('2026-10-10T00:00:00.000Z'),
  makerGate: false,
  budgetAllows: () => true,
  targetOnMain: () => true,
  ...over,
});

describe('requeue-policy — exports', () => {
  describe('attributionOf', () => {
    it('returns a SQL subquery string referencing the given alias', () => {
      const sql = attributionOf('o');
      expect(typeof sql).toBe('string');
      expect(sql).toContain('j.judgment = \'outcome_attribution\'');
      expect(sql).toContain('o.id');
    });

    it('embeds the alias so different aliases yield different strings', () => {
      const a = attributionOf('o');
      const b = attributionOf('s');
      expect(a).not.toEqual(b);
      expect(a).toContain('o.id');
      expect(b).toContain('s.id');
    });

    it('orders by created_at DESC with LIMIT 1 (newest outcome only)', () => {
      const sql = attributionOf('o');
      expect(sql).toMatch(/ORDER BY j\.created_at DESC/);
      expect(sql).toMatch(/LIMIT 1/);
    });
  });

  describe('policyClass', () => {
    it('classifies a no_change status regardless of attribution', () => {
      expect(policyClass('no_change', null)).toBe('no_change');
      expect(policyClass('no_change', 'environment_failure')).toBe('no_change');
    });

    it('maps known outcome_attribution values to their classes', () => {
      expect(policyClass('infra_failed', 'environment_failure')).toBe('environment_failure');
      expect(policyClass('regressed', 'reviewer_failure')).toBe('reviewer_failure');
      expect(policyClass('failed', 'maker_failure')).toBe('maker_failure');
    });

    it('falls back to unknown when attribution is null or unrecognised', () => {
      expect(policyClass('infra_failed', null)).toBe('unknown');
      expect(policyClass('regressed', 'something_else')).toBe('unknown');
      expect(policyClass('failed', '')).toBe('unknown');
    });
  });

  describe('requeueVerdict', () => {
    it('dismisses a requeue copy (a requeue that failed again is never requeued)', () => {
      const v = requeueVerdict(
        baseCandidate({ evidence_refs_json: '["requeue-of:imp-0"]' }),
        baseCtx(),
      );
      expect(v.action).toBe('wait');
      expect(v.cls).toBe('requeue_copy');
    });

    it('dismisses a requeue copy past the auto-dismiss window', () => {
      const old = '2026-09-01T00:00:00.000Z';
      const v = requeueVerdict(
        baseCandidate({ evidence_refs_json: '["requeue-of:imp-0"]', updated_at: old }),
        baseCtx({ now: Date.parse('2026-10-26T00:00:00.000Z') }),
      );
      expect(v.action).toBe('dismiss');
      expect(v.reason).toContain('requeue_copy');
    });

    it('treats no_change status as ineligible (wait then dismiss)', () => {
      const v = requeueVerdict(
        baseCandidate({ status: 'no_change' }),
        baseCtx(),
      );
      expect(v.action).toBe('wait');
      expect(v.cls).toBe('no_change');
    });

    it('treats not_actionable queue_class as ineligible', () => {
      const v = requeueVerdict(
        baseCandidate({ queue_class: 'not_actionable' }),
        baseCtx(),
      );
      expect(v.action).toBe('wait');
      expect(v.cls).toBe('not_actionable');
    });

    it('requeues an environment_failure attribution when the budget allows', () => {
      const v = requeueVerdict(
        baseCandidate({ status: 'regressed', attribution: 'environment_failure' }),
        baseCtx(),
      );
      expect(v.action).toBe('requeue');
      expect(v.cls).toBe('environment_failure');
    });

    it('holds an eligible escalated original for a human', () => {
      const v = requeueVerdict(
        baseCandidate({ status: 'infra_failed', attribution: 'environment_failure', escalated: 1 }),
        baseCtx(),
      );
      expect(v.action).toBe('hold');
      expect(v.reason).toContain('escalated');
    });

    it('holds when the target file cannot be checked (onMain null)', () => {
      const v = requeueVerdict(
        baseCandidate({ grounding_json: JSON.stringify({ target: 'packages/server/src/foo.ts' }) }),
        baseCtx({ targetOnMain: () => null }),
      );
      expect(v.action).toBe('hold');
    });

    it('dismisses when the target file is gone from main', () => {
      const recent = new Date(Date.parse('2026-10-09T00:00:00.000Z') + 86_400_000).toISOString();
      const v = requeueVerdict(
        baseCandidate({ grounding_json: JSON.stringify({ target: 'packages/server/src/gone.ts' }), updated_at: recent }),
        baseCtx({ targetOnMain: () => false, now: Date.parse('2026-10-10T00:00:00.000Z') }),
      );
      expect(v.action).toBe('wait');
      expect(v.cls).toBe('target_gone');
    });

    it('waits when the lane budget is exhausted', () => {
      const v = requeueVerdict(
        baseCandidate({ attribution: 'reviewer_failure' }),
        baseCtx({ budgetAllows: () => false }),
      );
      expect(v.action).toBe('wait');
      expect(v.reason).toContain('budget');
    });

    it('requeues an infra_failed original even when attribution is unknown', () => {
      const v = requeueVerdict(
        baseCandidate({ status: 'infra_failed', attribution: null }),
        baseCtx(),
      );
      expect(v.action).toBe('requeue');
      expect(v.cls).toBe('infra_failed');
    });

    it('does not requeue maker_failure when the measured gate is not met', () => {
      const v = requeueVerdict(
        baseCandidate({ status: 'failed', attribution: 'maker_failure' }),
        baseCtx({ makerGate: false }),
      );
      expect(v.action).toBe('wait');
      expect(v.cls).toBe('maker_failure');
      expect(v.reason).toContain('maker_failure below the measured gate');
    });

    it('requeues maker_failure when the measured gate is met', () => {
      const v = requeueVerdict(
        baseCandidate({ status: 'failed', attribution: 'maker_failure' }),
        baseCtx({ makerGate: true }),
      );
      expect(v.action).toBe('requeue');
      expect(v.cls).toBe('maker_failure');
    });

    it('respects AUTO_DISMISS_AFTER_DAYS in the wait->dismiss boundary', () => {
      expect(AUTO_DISMISS_AFTER_DAYS).toBe(14);
      const base = Date.parse('2026-10-10T00:00:00.000Z');
      const within = base - (AUTO_DISMISS_AFTER_DAYS - 1) * 86_400_000;
      const v = requeueVerdict(
        baseCandidate({ status: 'no_change', updated_at: new Date(within).toISOString() }),
        baseCtx({ now: base }),
      );
      expect(v.action).toBe('wait');
      const past = base - (AUTO_DISMISS_AFTER_DAYS + 1) * 86_400_000;
      const v2 = requeueVerdict(
        baseCandidate({ status: 'no_change', updated_at: new Date(past).toISOString() }),
        baseCtx({ now: base }),
      );
      expect(v2.action).toBe('dismiss');
    });

    it('exposes the maker_failure gate constants in the reason string', () => {
      const v = requeueVerdict(
        baseCandidate({ status: 'failed', attribution: 'maker_failure' }),
        baseCtx({ makerGate: false }),
      );
      expect(v.reason).toContain(String(MAKER_FAILURE_GATE.min_n));
      expect(v.reason).toContain(String(MAKER_FAILURE_GATE.min_rate * 100));
    });
  });
});