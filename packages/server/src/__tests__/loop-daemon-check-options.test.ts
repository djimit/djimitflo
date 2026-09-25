import { expect, it } from 'vitest';
import { daemonCheckOptions, daemonMakerTimeoutMs, daemonReviewerTimeoutMs } from '../services/loop-daemon';

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

it('maker timeout: 600 s for the mutation lane, else LOOP_MAKER_TIMEOUT_MS (default 300 s, capped at 600 s)', () => {
  expect(daemonMakerTimeoutMs(true, {})).toBe(600_000);
  expect(daemonMakerTimeoutMs(false, {})).toBe(300_000);
  expect(daemonMakerTimeoutMs(false, { LOOP_MAKER_TIMEOUT_MS: '450000' })).toBe(450_000);
  expect(daemonMakerTimeoutMs(false, { LOOP_MAKER_TIMEOUT_MS: '9999999' })).toBe(600_000);
});

it('A3: a run whose maker timed out or exited non-zero is infra_failed, not regressed', async () => {
  const Database = (await import('better-sqlite3')).default;
  const { schema } = await import('../database/schema');
  const { runMigrations } = await import('../database/migrate');
  const { runOutcomeOnFailure } = await import('../services/loop-daemon');
  const db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  const lease = (id: string, meta: object) => db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata) VALUES (?, 'r', 'maker', 'opencode', 'failed', ?)").run(id, JSON.stringify(meta));
  lease('timeout', { timed_out: true, failure_reason: 'maker_gate_failed:maker_runtime_exit_zero,diff_under_threshold' });
  lease('contract', { failure_reason: 'runtime_contract_unavailable_or_drifted' });
  lease('evaluated', { exit_status: 0 }); // ran, produced a change, checks/reviewers rejected it
  expect(['timeout', 'contract', 'evaluated'].map((id) => runOutcomeOnFailure(db, id))).toEqual(['infra_failed', 'infra_failed', 'regressed']);
  db.close();
});
