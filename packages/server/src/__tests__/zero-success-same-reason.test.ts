/**
 * O1b (re-20261029 C-reliability candidate 4): misconfigurations ran for days below the ≥ 5-attempt zero_success
 * threshold — the remote checker failed 21/21 with "remote maker needs model '<host>/<species>', got ''", but fewer than 5
 * per 24 h. zero_success now also fires on ≥ 3 failed attempts of one species (maker or reviewer) sharing an identical
 * failure_reason prefix (first 60 chars) with no success in the window. The ≥ 5 rule is unchanged.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { detectStallsWithHealth, ZERO_SUCCESS_SAME_REASON_MIN, ZERO_SUCCESS_REASON_PREFIX } from '../services/stall-watch';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';

const C = { DJIMITFLO_SKILLS_DIR: __dirname, DJIMIT_SKILL_TRAINING_EVAL_RUNNER: __filename };
const NOW = Date.parse('2026-10-20T12:00:00Z');
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();
let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF'); new SkillEvolutionEngine(db); });
afterEach(() => db.close());

let seq = 0;
const lease = (role: string, runtime: string, status: 'completed' | 'failed', hoursAgo: number, meta: Record<string, unknown>) =>
  db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(`l${++seq}`, `r${seq}`, role, runtime, status, JSON.stringify(meta), at(hoursAgo), at(hoursAgo));
/** the prod shape (executeChecker's failure_reason for the 21 remote checker leases, model '') */
const REMOTE_CHECKER = "checker_runtime_failed:exit=1,timed_out=false: remote maker needs model '<host>/<species>', got ''";
const stalls = (env: NodeJS.ProcessEnv = { VALUE_ANOMALY_ALARM: 'on' }) => detectStallsWithHealth(db, NOW, { ...C, ...env }).stalls;
const zero = (env?: NodeJS.ProcessEnv) => stalls(env).filter((s) => s.subsystem.startsWith('zero_success')).map((s) => s.subsystem).sort();

it('the remote-checker shape: 3 checker failures with model "" and one reason fire zero_success:checker:remote', () => {
  expect(ZERO_SUCCESS_SAME_REASON_MIN).toBe(3);
  expect(ZERO_SUCCESS_REASON_PREFIX).toBe(60);
  for (let i = 0; i < 3; i++) lease('checker', 'remote', 'failed', 2 + 6 * i, { model: '', exit_status: 1, failure_reason: REMOTE_CHECKER });
  expect(zero()).toEqual(['zero_success:checker:remote']);
  const s = stalls().find((x) => x.subsystem === 'zero_success:checker:remote');
  expect(s?.detail).toContain('3/3');
  expect(s?.detail).toContain(REMOTE_CHECKER.slice(0, 60));
  expect(s?.since).toBe(at(14));
});

it('only the first 60 characters are compared: a varying tail still counts as one reason', () => {
  for (let i = 0; i < 3; i++) lease('maker', 'opencode', 'failed', 1 + i, { model: 'kimi', failure_reason: `${'x'.repeat(60)} run ${i}` });
  expect(zero()).toEqual(['zero_success:maker:opencode@kimi']);
});

it('does not fire on 2 same-reason failures, on 3 different reasons, or when the species also succeeded', () => {
  for (let i = 0; i < 2; i++) lease('checker', 'remote', 'failed', 1 + i, { model: '', failure_reason: REMOTE_CHECKER });
  for (let i = 0; i < 3; i++) lease('maker', 'codex', 'failed', 1 + i, { failure_reason: `runtime_exit_status_${i}` });
  for (let i = 0; i < 3; i++) lease('security_checker', 'claude', 'failed', 1 + i, { failure_reason: 'security_checker_runtime_failed:exit=1,timed_out=false: boom' });
  lease('security_checker', 'claude', 'completed', 2, {});
  lease('checker', 'manual', 'failed', 1, { failure_reason: 'x' }); lease('checker', 'manual', 'failed', 1, { failure_reason: 'x' }); lease('checker', 'manual', 'failed', 1, { failure_reason: 'x' });
  expect(zero()).toEqual([]);
});

it('outside the 24 h window nothing counts; the ≥ 5 rule is unchanged and not raised twice', () => {
  for (let i = 0; i < 3; i++) lease('checker', 'remote', 'failed', 30 + i, { model: '', failure_reason: REMOTE_CHECKER });
  expect(zero()).toEqual([]);
  for (let i = 0; i < 6; i++) lease('maker', 'claude', 'failed', 1 + i, { model: 'sonnet', failure_reason: 'maker_gate_failed:token_budget' });
  expect(zero()).toEqual(['zero_success:maker:claude@sonnet']);
  expect(stalls().find((s) => s.subsystem === 'zero_success:maker:claude@sonnet')?.detail).toContain('0/6');
});

it('shadow: detector detail only, no stall; off: not run', () => {
  for (let i = 0; i < 3; i++) lease('checker', 'remote', 'failed', 1 + i, { model: '', failure_reason: REMOTE_CHECKER });
  expect(zero({ VALUE_ANOMALY_ALARM: 'shadow' })).toEqual([]);
  const d = detectStallsWithHealth(db, NOW, { ...C, VALUE_ANOMALY_ALARM: 'shadow' }).detectors.find((x) => x.name === 'zero_success');
  expect(d?.detail).toContain('zero_success:checker:remote');
  expect(zero({})).toEqual([]);
});
