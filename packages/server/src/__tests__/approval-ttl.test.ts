import { expect, it } from 'vitest';
import { approvalTtlMs } from '../services/approval-service';

it('approval TTL: 1 h by default, configurable, clamped to 5 min .. 7 days (prod 2026-09-25: approvals expired overnight)', () => {
  expect(approvalTtlMs({})).toBe(3_600_000);
  expect(approvalTtlMs({ APPROVAL_TTL_MS: String(12 * 3_600_000) })).toBe(43_200_000);
  expect(approvalTtlMs({ APPROVAL_TTL_MS: '1000' })).toBe(300_000);
  expect(approvalTtlMs({ APPROVAL_TTL_MS: String(30 * 86_400_000) })).toBe(7 * 86_400_000);
  expect(approvalTtlMs({ APPROVAL_TTL_MS: 'x' })).toBe(3_600_000);
});
