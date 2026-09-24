import { expect, it } from 'vitest';
import { daemonCheckOptions, daemonReviewerTimeoutMs } from '../services/loop-daemon';

it('defaults to the standard scripts and 120 s', () => {
  expect(daemonCheckOptions({})).toEqual({ timeout_ms: 120_000 });
});
it('scopes scripts and clamps the timeout to 600 s', () => {
  expect(daemonCheckOptions({ LOOP_DAEMON_CHECK_SCRIPTS: ' test:changed, lint ,', LOOP_DAEMON_CHECK_TIMEOUT_MS: '900000' }))
    .toEqual({ scripts: ['test:changed', 'lint'], timeout_ms: 600_000 });
  expect(daemonCheckOptions({ LOOP_DAEMON_CHECK_TIMEOUT_MS: 'x' }).timeout_ms).toBe(120_000);
});
it('gives reviewers 300 s by default, configurable and clamped to 900 s (prod 2026-09-24: 2/7 reviews hit 120 s)', () => {
  expect(daemonReviewerTimeoutMs({})).toBe(300_000);
  expect(daemonReviewerTimeoutMs({ LOOP_REVIEWER_TIMEOUT_MS: '240000' })).toBe(240_000);
  expect(daemonReviewerTimeoutMs({ LOOP_REVIEWER_TIMEOUT_MS: '5000000' })).toBe(900_000);
  expect(daemonReviewerTimeoutMs({ LOOP_REVIEWER_TIMEOUT_MS: 'x' })).toBe(300_000);
});
