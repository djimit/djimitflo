import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { OPERATOR_CONTRACTS, type OperatorContract } from '@djimitflo/shared';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';
import { operatorCockpit } from '../services/operator-cockpit';
import { buildEvolutionEvidence } from '../services/evolution-evidence';
import { forecastScoresV2 } from '../services/forecast-scoring';
import { runtimeHealth } from '../services/runtime-health';
import { buildDigest } from '../services/operator-push';
import { listDraftPrs } from '../services/loop-draft-pr-service';
import { listSchedulers, noteScheduler, resetSchedulers } from '../services/scheduler-registry';

const NOW = Date.parse('2026-10-06T08:00:00Z');
const ago = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
let db: Database.Database;
afterEach(() => { db?.close(); resetSchedulers(); });

function fresh(seed: boolean): Database.Database {
  const d = new Database(':memory:'); d.exec(schema); runMigrations(d); d.pragma('foreign_keys = OFF'); new SkillEvolutionEngine(d);
  if (seed) {
    d.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
      VALUES ('r1', 'test-gap', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, ?, ?)`).run(JSON.stringify({ pr_url: 'https://github.com/o/r/pull/7' }), ago(2), ago(2));
    d.prepare("INSERT INTO skill_outcomes (id, skill_id, success, domain, created_at) VALUES ('o1', 'loop-maker:test-gap:opencode', 1, 'loop', ?)").run(ago(1));
    noteScheduler('stall_watch', 'STALL_WATCH_ENABLED', true, 3_600_000);
  }
  return d;
}

/** Every operator endpoint the dashboard renders, built the way its route builds it. */
const builders: Array<[OperatorContract, (d: Database.Database) => object]> = [
  ['cockpit', (d) => operatorCockpit(d, NOW)],
  ['evolutionEvidence', (d) => buildEvolutionEvidence(d, {}, NOW, 30)],
  ['forecastsV2', (d) => forecastScoresV2(d)],
  ['runtimes', (d) => ({ runtimes: runtimeHealth(d, NOW) })],
  ['digest', (d) => buildDigest(d, NOW, {})],
  ['draftPrs', (d) => listDraftPrs(d, 50, NOW)],
  ['schedulers', () => listSchedulers()],
];

describe.each([false, true])('UX-2b: operator response contracts (seeded=%s)', (seed) => {
  it.each(builders)('UX-2b: %s returns exactly the shared contract keys', (name, build) => {
    db = fresh(seed);
    expect(Object.keys(build(db)).sort()).toEqual([...OPERATOR_CONTRACTS[name]].sort());
  });
});

it('UX-2b: row contracts — a runtime row and a draft-PR row carry exactly the shared keys', () => {
  db = fresh(true);
  const runtime = runtimeHealth(db, NOW)[0];
  expect(runtime).toBeDefined();
  expect(Object.keys(runtime).sort()).toEqual([...OPERATOR_CONTRACTS.runtimeRow].sort());
  const draft = listDraftPrs(db, 50, NOW).rows[0];
  expect(Object.keys(draft).sort()).toEqual([...OPERATOR_CONTRACTS.draftPrRow].sort());
});
