import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { EVOLUTION_FLAGS } from '../services/evolution-evidence';
import { FORECAST_REQUEST, makerForecastMode, makerForecastScore, parseForecast } from '../services/maker-forecast';

describe('maker forecast (MAKER_FORECAST_MODE)', () => {
  let db: Database.Database;
  const now = new Date().toISOString();
  beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); });
  afterEach(() => db.close());

  it('is off unless set to shadow, and is a registered acting flag', () => {
    expect(makerForecastMode({})).toBe('off');
    expect(makerForecastMode({ MAKER_FORECAST_MODE: 'on' })).toBe('off');
    expect(makerForecastMode({ MAKER_FORECAST_MODE: 'shadow' })).toBe('shadow');
    expect(EVOLUTION_FLAGS).toContainEqual({ name: 'MAKER_FORECAST_MODE', acting: true });
    expect(FORECAST_REQUEST).toContain('FORECAST:');
  });

  it('takes the last valid forecast and treats a missing or out-of-range one as null, not zero', () => {
    expect(parseForecast('plan FORECAST: 0.2\n{"text":"done\\nFORECAST: 0.85"}')).toBe(0.85);
    expect(parseForecast('FORECAST: 1')).toBe(1);
    expect(parseForecast('FORECAST: 0')).toBe(0);
    expect(parseForecast('no forecast here')).toBeNull();
    expect(parseForecast('FORECAST: 1.5')).toBeNull();
    expect(parseForecast('FORECAST: 85%')).toBeNull();
    expect(parseForecast('FORECAST: <number between 0 and 1>')).toBeNull(); // the request line echoed back
  });

  it('scores stored forecasts against checks and reviewer verdict; unresolved makers are not scored and n = 0 gives null', () => {
    expect(makerForecastScore(db)).toMatchObject({ n: 0, unresolved: 0, brier: null, base_rate: null, skill: null });
    db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
      VALUES ('r', 'lint-fix', 'closed', 'running', '[]', '{}', '[]', '[]', '{}', ?, ?)`).run(now, now);
    const lease = (id: string, role: string, status: string, metadata: Record<string, unknown>) => db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at)
      VALUES (?, 'r', ?, 'opencode', ?, ?, ?, ?)`).run(id, role, status, JSON.stringify(metadata), now, now);
    lease('m1', 'maker', 'completed', { self_forecast: 0.9, deterministic_checks: [{ name: 'lint', status: 'pass' }] });
    lease('c1', 'checker', 'completed', { maker_lease_id: 'm1', verdict: 'accepted' });
    lease('m2', 'maker', 'completed', { self_forecast: 0.8, deterministic_checks: [{ name: 'lint', status: 'pass' }] });
    lease('c2', 'checker', 'completed', { maker_lease_id: 'm2', verdict: 'needs_revision' });
    lease('m3', 'maker', 'failed', { self_forecast: 0.6, deterministic_checks: [{ name: 'lint', status: 'fail', timed_out: false }] });
    lease('m4', 'maker', 'failed', { self_forecast: 0.7, deterministic_checks: [{ name: 'test:changed', status: 'fail', timed_out: true }] }); // infra: unresolved
    lease('m5', 'maker', 'completed', { self_forecast: 0.5 }); // no reviewer yet: unresolved
    lease('m6', 'maker', 'completed', { self_forecast: 0.4 });
    lease('c6', 'checker', 'completed', { maker_lease_id: 'm6', verdict: 'insufficient_evidence', verdict_parsed: false }); // no verdict parsed: unresolved
    lease('m7', 'maker', 'completed', { self_forecast: null }); // gave no forecast: not counted at all
    const s = makerForecastScore(db);
    expect(s).toMatchObject({ n: 3, positives: 1, unresolved: 3, base_rate: 0.3333 });
    expect(s.brier).toBeCloseTo((0.1 ** 2 + 0.8 ** 2 + 0.6 ** 2) / 3, 3);
    expect(s.skill).toBeLessThan(0); // overconfident: worse than quoting the pass rate
  });
});
