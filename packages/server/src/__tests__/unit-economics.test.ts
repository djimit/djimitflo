import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';
import { ensurePowerTable } from '../services/resource-ledger';
import { operatorCockpit } from '../services/operator-cockpit';
import { HANDLING_MINUTES, loadMonthlyEur, parseMonthlyEur, unitEconomics } from '../services/unit-economics';

// G0.3 / G0.4: € and operator minutes per verified / surviving change. Unknown prices stay unknown (E2), never €0.
const NOW = Date.parse('2026-10-19T12:00:00Z');
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const NO_PRICES = { prices: parseMonthlyEur({}), error: null };
const withPrices = (p: Record<string, number>) => ({ prices: parseMonthlyEur({ monthly_eur: p }), error: null });

let db: Database.Database;
afterEach(() => db?.close());
function fresh() {
  db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db); new SkillEvolutionEngine(db);
  return db;
}
const proposal = (id: string, status: string, refs: string[] = [], at = ago(48)) => {
  db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, evidence_refs_json, created_at, updated_at)
    VALUES (?, 'test', ?, 'd', 'r', 'gap_analysis', ?, ?, ?, ?)`).run(id, `t ${id}`, status, JSON.stringify(refs), at, at);
  db.prepare(`INSERT INTO goals (id, objective, risk_class, status, metadata, improvement_id, created_at, updated_at) VALUES (?, 'o', 'low', 'completed', '{}', ?, ?, ?)`)
    .run(`g-${id}`, id, at, at);
};
const run = (id: string, pid: string, meta: Record<string, unknown>) => db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, goal_id, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES (?, 'test-gap', 'closed', 'completed', ?, '[]', '{}', '[]', '[]', ?, ?, ?)`).run(id, `g-${pid}`, JSON.stringify(meta), ago(72), ago(72));
const mergeOutcome = (id: string, runId: string, success: number) => db.prepare(
  "INSERT INTO skill_outcomes (id, skill_id, success, domain, task_id, created_at) VALUES (?, 'loop-maker:merge:codex', ?, 'merge', ?, ?)").run(id, success, runId, ago(24));
const approval = (id: string, actor: string | null, createdH: number, decidedH: number) => db.prepare(`INSERT INTO approvals
  (id, task_id, status, risk_level, request_type, request_message, request_data, decided_by, decided_at, created_at, updated_at)
  VALUES (?, 't', 'approved', 'low', 'tool_call', 'm', '{}', ?, ?, ?, ?)`).run(id, actor, ago(decidedH), ago(createdH), ago(decidedH));

/** two verified proposals, two surviving merges (runs r1, r2) */
function seedChanges() {
  proposal('p1', 'verified'); proposal('p2', 'verified');
  run('r1', 'p1', { pr_url: 'https://github.com/o/r/pull/1', pr_outcome: { state: 'merged', merged_at: ago(30), survived: true } });
  run('r2', 'p2', { pr_url: 'https://github.com/o/r/pull/2', pr_outcome: { state: 'merged', merged_at: ago(30), survived: true } });
  mergeOutcome('o1', 'r1', 1); mergeOutcome('o2', 'r2', 1);
}

describe('G0.3 € ledger', () => {
  it('the checked-in docs/usage-plan-limits.json has a monthly_eur map; every set price carries a stated source (never invented)', () => {
    const { prices, error } = loadMonthlyEur();
    expect(error).toBeNull();
    expect(Object.keys(prices).sort()).toEqual(['chatgpt_pro', 'claude_max', 'ollama_cloud', 'vps', 'workstation_kwh_eur']);
    for (const v of Object.values(prices)) expect(v === null || (typeof v === 'number' && v > 0)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../docs/usage-plan-limits.json'), 'utf8')) as { monthly_eur_source?: string };
    if (Object.values(prices).some((v) => v !== null)) expect((raw.monthly_eur_source ?? '').length).toBeGreaterThan(40);
  });

  it('all prices null → every € value null with reason no_prices, unknown_share 1 — never 0', () => {
    fresh(); seedChanges();
    const ue = unitEconomics(db, NOW, NO_PRICES);
    expect(ue.counts).toMatchObject({ verified: 2, surviving: 2 });
    expect(ue.eur).toMatchObject({ known_cost: null, per_verified: null, per_surviving: null, reason: 'no_prices', unknown_share: 1 });
  });

  it('partial prices → known € pro-rated to 30 d, unknown_share > 0, per change = known cost / count', () => {
    fresh(); seedChanges();
    const ue = unitEconomics(db, NOW, withPrices({ claude_max: 90, vps: 30 }));
    const known = +((90 * 30) / (365.25 / 12)).toFixed(2) + +((30 * 30) / (365.25 / 12)).toFixed(2);
    expect(ue.eur.known_cost).toBeCloseTo(known, 2);
    expect(ue.eur.unknown_share).toBe(0.6); // ollama_cloud, chatgpt_pro, workstation kWh unknown out of 5
    expect(ue.eur.reason).toBeNull();
    expect(ue.eur.per_verified).toBeCloseTo(known / 2, 2);
    expect(ue.eur.per_surviving).toBeCloseTo(known / 2, 2);
  });

  it('workstation € = measured GPU kWh × €/kWh; a price without samples stays unknown', () => {
    fresh(); seedChanges();
    expect(unitEconomics(db, NOW, withPrices({ workstation_kwh_eur: 0.3 })).eur.components.find((c) => c.key === 'workstation_kwh'))
      .toMatchObject({ eur: null, reason: 'no_energy_samples' });
    ensurePowerTable(db);
    // 1000 W for 2 h, sampled every 60 s → 2 kWh
    for (let s = 0; s <= 120; s++) db.prepare('INSERT INTO host_power_samples (host, at, gpu_watts) VALUES (?, ?, ?)').run('ws', new Date(NOW - 5 * 3_600_000 + s * 60_000).toISOString(), 1000);
    const ws = unitEconomics(db, NOW, withPrices({ workstation_kwh_eur: 0.3 })).eur.components.find((c) => c.key === 'workstation_kwh');
    expect(ws).toMatchObject({ kwh: 2, eur: 0.6, reason: null });
  });

  it('a superseded close is not a surviving change', () => {
    fresh(); seedChanges();
    proposal('p-old', 'verified', [], ago(200));
    run('r-old', 'p-old', { pr_url: 'https://github.com/o/r/pull/3', pr_outcome: { state: 'closed_unmerged' } });
    proposal('p-copy', 'verified', ['requeue-of:p-old'], ago(100));
    mergeOutcome('o-old', 'r-old', 1); // a stray win on a superseded close must not count
    const ue = unitEconomics(db, NOW, withPrices({ vps: 30 }));
    expect(ue.counts).toMatchObject({ surviving: 2, superseded_excluded: 1 });
  });
});

describe('G0.4 operator minutes', () => {
  it('human approvals: waiting capped at 24 h + fixed handling estimate; autonomy / inherit / unknown actors excluded', () => {
    fresh(); seedChanges();
    approval('a-h1', 'dennis', 3, 1); // 120 min
    approval('a-h2', 'operator@example', 80, 2); // 78 h → capped at 1440 min
    approval('a-auto', 'autonomy:rule-7', 5, 1);
    approval('a-inh', 'inherit:a-h1', 5, 1);
    approval('a-null', null, 5, 1);
    approval('a-old', 'dennis', 1000, 900); // outside 30 d
    const m = unitEconomics(db, NOW, NO_PRICES).operator_minutes;
    expect(m.approvals).toEqual({ human: 2, excluded_automated: 2, unknown_actor: 1, waiting_minutes: 1560, handling_minutes_estimate: 2 * HANDLING_MINUTES });
  });

  it('human merges count; earned auto-merges do not; per surviving change reported separately for waiting and handling', () => {
    fresh(); seedChanges();
    run('r-auto', 'p1', { pr_url: 'https://github.com/o/r/pull/9', pr_outcome: { state: 'merged', merged_at: ago(10) }, auto_merge: { decision: 'merged' } });
    approval('a-h1', 'dennis', 3, 1);
    const m = unitEconomics(db, NOW, NO_PRICES).operator_minutes;
    expect(m.human_merges).toEqual({ count: 2, handling_minutes_estimate: 2 * HANDLING_MINUTES });
    expect(m.waiting_minutes).toBe(120);
    expect(m.handling_minutes_estimate).toBe(3 * HANDLING_MINUTES);
    expect(m.per_surviving).toEqual({ waiting_minutes: 60, handling_minutes_estimate: (3 * HANDLING_MINUTES) / 2 });
    expect(m.reason).toBeNull();
  });

  it('no surviving change → per-change minutes null with a reason, not 0', () => {
    fresh();
    approval('a-h1', 'dennis', 3, 1);
    const m = unitEconomics(db, NOW, NO_PRICES).operator_minutes;
    expect(m.per_surviving).toEqual({ waiting_minutes: null, handling_minutes_estimate: null });
    expect(m.reason).toBe('no_surviving_changes');
  });

  it('the cockpit carries unit_economics', () => {
    fresh(); seedChanges();
    const snap = operatorCockpit(db, NOW, {});
    expect(snap.unit_economics?.counts.surviving).toBe(2);
    expect(snap.errors.filter((e) => e.section === 'unit_economics')).toEqual([]);
  });
});
