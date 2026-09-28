import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { operatorCockpit } from '../services/operator-cockpit';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';

let db: Database.Database;
const NOW = Date.parse('2026-09-28T20:00:00Z');
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF'); new SkillEvolutionEngine(db); });
afterEach(() => db.close());
const proposal = (id: string, status: string) => db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, created_at, updated_at)
  VALUES (?, 'test', 't', 'd', 'r', 'gap_analysis', ?, ?, ?)`).run(id, status, ago(2), ago(1));

it('computes the scorecard and flags the regression guardrail like plan §3', () => {
  for (let i = 0; i < 10; i++) proposal(`v${i}`, 'verified');
  for (let i = 0; i < 3; i++) proposal(`r${i}`, 'regressed');
  const c = operatorCockpit(db, NOW);
  expect(c.scorecard.verified_7d).toBe(10); expect(c.scorecard.regressed_7d).toBe(3);
  expect(c.guardrails.find((g) => g.name === 'regressions')).toMatchObject({ ok: false, value: 3 });
});

it('reports gym species with success rate and remote worker activity', () => {
  const out = db.prepare("INSERT INTO skill_outcomes (id, skill_id, success, tokens_used, duration_ms, domain, created_at) VALUES (?, ?, ?, 0, 60000, 'gym', ?)");
  out.run('a', 'loop-maker:gym:atomic', 1, ago(1)); out.run('b', 'loop-maker:gym:atomic', 0, ago(1)); out.run('c', 'loop-maker:gym:opencode', 1, ago(1));
  db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES ('g1', 'evolution-gym', 'closed', 'completed', '[]', '{}', '[]', '[]', '{"gym":{"remote_host":"workstation"}}', ?, ?)`).run(ago(2), ago(2));
  const c = operatorCockpit(db, NOW);
  expect(c.gym[0]).toMatchObject({ species: 'atomic', outcomes: 2, successes: 1, success_pct: 50, avg_seconds: 60 });
  expect(c.remote_workers).toEqual([{ host: 'workstation', claims_24h: 1, last_claim: ago(2), interrupted_24h: 0 }]);
});

it('never throws on a schema without optional tables', () => {
  const bare = new Database(':memory:');
  const c = operatorCockpit(bare, NOW);
  expect(c.scorecard.verified_7d).toBeNull(); expect(c.gym).toEqual([]);
  bare.close();
});

it('reads the newest deploy events from the mounted deploy log and ignores broken lines', async () => {
  const { recentDeploys } = await import('../services/operator-cockpit');
  const fsm = await import('fs'); const osm = await import('os'); const pm = await import('path');
  const f = pm.join(fsm.mkdtempSync(pm.join(osm.tmpdir(), 'dl-')), 'deploy-log.jsonl');
  fsm.writeFileSync(f, '{"at":"1","event":"deploying","sha":"a","detail":""}\nnot json\n{"at":"2","event":"done","sha":"a","detail":""}\n');
  expect(recentDeploys(f).map((e) => e.event)).toEqual(['done', 'deploying']);
  expect(recentDeploys('/nonexistent/file')).toEqual([]);
});
