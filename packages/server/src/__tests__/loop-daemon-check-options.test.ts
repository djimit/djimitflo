import { expect, it } from 'vitest';
import { daemonCheckOptions } from '../services/loop-daemon';

it('defaults to the standard scripts and 120 s', () => {
  expect(daemonCheckOptions({})).toEqual({ timeout_ms: 120_000 });
});
it('scopes scripts and clamps the timeout to 600 s', () => {
  expect(daemonCheckOptions({ LOOP_DAEMON_CHECK_SCRIPTS: ' test:changed, lint ,', LOOP_DAEMON_CHECK_TIMEOUT_MS: '900000' }))
    .toEqual({ scripts: ['test:changed', 'lint'], timeout_ms: 600_000 });
  expect(daemonCheckOptions({ LOOP_DAEMON_CHECK_TIMEOUT_MS: 'x' }).timeout_ms).toBe(120_000);
});
