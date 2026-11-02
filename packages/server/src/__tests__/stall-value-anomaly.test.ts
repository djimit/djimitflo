import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { detectStallsWithHealth, GATE_ALWAYS_FAILS_MIN_LEASES, ZERO_SUCCESS_MIN_ATTEMPTS } from '../services/stall-watch';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';
/** capability chain (stall-watch): a configured environment, so these tests see only the detectors they assert on */
const C = { DJIMITFLO_SKILLS_DIR: __dirname, DJIMIT_SKILL_TRAINING_EVAL_RUNNER: __filename };

let db: Database.Database;
const NOW = Date.parse('2026-10-19T12:00:00Z');
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF'); new SkillEvolutionEngine(db); });
afterEach(() => db.close());

let seq = 0;
const lease = (runtime: string, status: 'completed' | 'failed', hoursAgo: number, meta: Record<string, unknown>) =>
  db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, budget_json, metadata, created_at, updated_at) VALUES (?, ?, 'maker', ?, ?, ?, ?, ?, ?)`)
    .run(`l${++seq}`, `r${seq}`, runtime, status, JSON.stringify({ max_tokens: 1000 }), JSON.stringify(meta), at(hoursAgo), at(hoursAgo));
const call = (consumer: string, ok: 0 | 1, hoursAgo: number, shadow: 0 | 1 = 0) =>
  db.prepare('INSERT INTO llm_model_calls (consumer, model, ok, shadow, created_at) VALUES (?, ?, ?, ?, ?)').run(consumer, 'm', ok, shadow, at(hoursAgo));

/** prod 17–19 Oct: claude makers exited 0 with a diff, every lease failed the token_budget gate (meta maxTokens=1000), 0 completed */
function replayProd() {
  for (let i = 0; i < 10; i++) lease('claude', 'failed', 22 - 2 * i, { model: 'claude-sonnet', exit_status: 0, diff_lines: 40 + i, maxTokens: 1000, failure_reason: 'maker_gate_failed:token_budget' });
  // older than the window: not counted
  for (let i = 0; i < 3; i++) lease('claude', 'failed', 40 + i, { model: 'claude-sonnet', exit_status: 0, failure_reason: 'maker_gate_failed:token_budget' });
  // opencode 3/5 completed; its 2 failures are a diff-size gate on an exit-0 lease → neither detector fires
  for (let i = 0; i < 3; i++) lease('opencode', 'completed', 3 + i, { model: 'kimi-k3', exit_status: 0, diff_lines: 30 });
  for (let i = 0; i < 2; i++) lease('opencode', 'failed', 8 + i, { model: 'kimi-k3', exit_status: 0, failure_reason: 'maker_gate_failed:diff_under_threshold' });
}
const report = (env: NodeJS.ProcessEnv = { VALUE_ANOMALY_ALARM: 'on' }) => detectStallsWithHealth(db, NOW, { ...C, ...env });
const subsystems = (env?: NodeJS.ProcessEnv) => report(env).stalls.map((s) => s.subsystem).sort();

it('G0.2: the 17–19 Oct replay fires both detectors for claude, never for opencode at 3/5', () => {
  replayProd();
  expect(subsystems()).toEqual(['gate_always_fails:token_budget:claude', 'zero_success:maker:claude@claude-sonnet']);
  const r = report();
  expect(r.health).toBe('BREACHED');
  expect(r.stalls.find((s) => s.subsystem.startsWith('zero_success'))?.detail).toContain('0/10');
  expect(r.stalls.find((s) => s.subsystem.startsWith('gate_always_fails'))?.detail).toContain('10/10');
});

it('does not fire below the attempt thresholds', () => {
  // distinct reasons: 4 identical ones would fire the O1b same-reason rule (≥ 3, zero-success-same-reason.test.ts)
  for (let i = 0; i < ZERO_SUCCESS_MIN_ATTEMPTS - 1; i++) lease('codex', 'failed', 1 + i, { exit_status: 1, failure_reason: `runtime_exit_status_${i + 1}` });
  for (let i = 0; i < GATE_ALWAYS_FAILS_MIN_LEASES - 1; i++) lease('remote', 'failed', 1 + i, { exit_status: 0, failure_reason: 'maker_gate_failed:token_budget' });
  for (let i = 0; i < ZERO_SUCCESS_MIN_ATTEMPTS - 1; i++) call('panel_review', 0, 1 + i);
  lease('manual', 'failed', 1, {}); // manual leases are never a consumer
  expect(subsystems()).toEqual([]);
});

it('fires zero_success for an llm purpose with ≥ 5 calls and none ok; shadow calls are not counted', () => {
  for (let i = 0; i < 5; i++) call('discovery_relevance', 0, 1 + i);
  for (let i = 0; i < 4; i++) call('content_safety', 0, 1 + i);
  call('content_safety', 1, 1);
  for (let i = 0; i < 8; i++) call('jev:challenger', 0, 1 + i, 1);
  expect(subsystems()).toEqual(['zero_success:llm:discovery_relevance']);
});

it('flag off: not applicable; shadow: detector detail only, no stall', () => {
  replayProd();
  const off = report({});
  expect(off.stalls).toEqual([]);
  expect(off.detectors.filter((d) => ['zero_success', 'gate_always_fails'].includes(d.name)).map((d) => d.status)).toEqual(['not_applicable', 'not_applicable']);
  const shadow = report({ VALUE_ANOMALY_ALARM: 'shadow' });
  expect(shadow.stalls).toEqual([]);
  expect(shadow.health).toBe('HEALTHY');
  expect(shadow.detectors.find((d) => d.name === 'zero_success')?.detail).toContain('zero_success:maker:claude@claude-sonnet');
  expect(shadow.detectors.find((d) => d.name === 'gate_always_fails')?.detail).toContain('gate_always_fails:token_budget:claude');
});

it('a detector that cannot query reads as error (UNKNOWN), never as no stall', () => {
  db.exec('DROP TABLE llm_model_calls');
  const r = report();
  expect(r.detectors.find((d) => d.name === 'zero_success')?.status).toBe('error');
  expect(r.detectors.find((d) => d.name === 'gate_always_fails')?.status).toBe('ok');
  expect(r.health).toBe('UNKNOWN');
});
