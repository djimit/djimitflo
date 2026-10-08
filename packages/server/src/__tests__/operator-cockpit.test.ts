import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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
  expect(c.gym[0]).toMatchObject({ species: 'atomic', outcomes: 2, successes: 1, success_pct: 50, avg_seconds: 60, benched: false });
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

it('W3: splits gym species per model, flags a benched species and counts what needs the operator', () => {
  const out = db.prepare("INSERT INTO skill_outcomes (id, skill_id, model, success, tokens_used, duration_ms, domain, created_at) VALUES (?, 'loop-maker:gym:atomic', ?, 1, 0, 1000, 'gym', ?)");
  out.run('r1', 'llama-router', ago(1)); out.run('q1', 'qwen36-2060', ago(1));
  const run = db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES (?, 'evolution-gym', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, ?, ?)`);
  for (const i of [1, 2, 3]) run.run(`d${i}`, JSON.stringify({ gym: { species: 'atomic@qwen36-2060', commit: `c${i}` }, gym_result: { status: 'discarded', reason: 'infra: npm ci failed' } }), ago(1), ago(1));
  vi.useFakeTimers(); vi.setSystemTime(NOW); // the breaker's cool-down reads the clock
  const c = operatorCockpit(db, NOW);
  vi.useRealTimers();
  expect(c.gym.map((g) => g.species).sort()).toEqual(['atomic@llama-router', 'atomic@qwen36-2060']);
  expect(c.gym.find((g) => g.species === 'atomic@qwen36-2060')?.benched).toBe(true);
  expect(c.gym.find((g) => g.species === 'atomic@llama-router')?.benched).toBe(false);
  expect(c.needs_you).toEqual(expect.objectContaining({ requeue: expect.any(Number), labels: expect.any(Number), memory_review: expect.any(Number) }));
});

it('honest needs-you: open loop PRs count, merged ones do not; no_change and dismissed requeue candidates do not', async () => {
  const { dismissRequeue } = await import('../services/decisions-inbox');
  proposal('r1', 'regressed'); proposal('i1', 'infra_failed'); proposal('n1', 'no_change');
  const run = db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES (?, 'test-gap', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, ?, ?)`);
  run.run('o1', JSON.stringify({ pr_url: 'https://github.com/o/r/pull/1' }), ago(30), ago(30));
  run.run('o2', JSON.stringify({ pr_url: 'https://github.com/o/r/pull/2', pr_outcome: { state: 'open' } }), ago(30), ago(30));
  run.run('m1', JSON.stringify({ pr_url: 'https://github.com/o/r/pull/3', pr_outcome: { state: 'merged' } }), ago(30), ago(30));
  run.run('c1', JSON.stringify({ pr_url: 'https://github.com/o/r/pull/4', pr_outcome: { state: 'closed_unmerged', settled_at: ago(1) } }), ago(30), ago(30));
  let c = operatorCockpit(db, NOW);
  expect(c.needs_you.open_prs).toBe(2);
  expect(c.needs_you.requeue).toBe(2);
  dismissRequeue(db, 'i1', 'op');
  c = operatorCockpit(db, NOW);
  expect(c.needs_you.requeue).toBe(1);
});

it('honest cockpit: tokens per verified change = maker + reviewer lease tokens / verified proposals (not an average over zero-token gym outcomes)', () => {
  for (let i = 0; i < 2; i++) proposal(`v${i}`, 'verified');
  const lease = db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at) VALUES (?, 'r', ?, 'opencode', 'completed', ?, ?)");
  lease.run('m', 'maker', JSON.stringify({ runtime_usage: { total_tokens: 3_000_000 } }), ago(3));
  lease.run('c', 'checker', JSON.stringify({ runtime_usage: { total_tokens: 600_000 } }), ago(3));
  lease.run('s', 'security_checker', JSON.stringify({ runtime_usage: { total_tokens: 400_000 } }), ago(3));
  lease.run('old', 'maker', JSON.stringify({ runtime_usage: { total_tokens: 9_000_000 } }), ago(24 * 8));
  const out = db.prepare("INSERT INTO skill_outcomes (id, skill_id, success, tokens_used, duration_ms, domain, created_at) VALUES (?, 'loop-maker:gym:atomic', 1, 0, 1000, 'gym', ?)");
  for (let i = 0; i < 50; i++) out.run(`g${i}`, ago(1));
  const c = operatorCockpit(db, NOW);
  expect(c.scorecard.tokens_per_verified_change_7d).toBe(2_000_000);
  expect(c.scorecard).not.toHaveProperty('tokens_per_outcome_7d');
});

it('honest cockpit: a gym species without an outcome for 72 h is stale and sorts after the active ones', () => {
  const out = db.prepare("INSERT INTO skill_outcomes (id, skill_id, success, tokens_used, duration_ms, domain, created_at) VALUES (?, ?, 1, 0, 1000, 'gym', ?)");
  for (let i = 0; i < 5; i++) out.run(`old${i}`, 'loop-maker:gym:pi', ago(80));
  out.run('new', 'loop-maker:gym:atomic', ago(2));
  const c = operatorCockpit(db, NOW);
  expect(c.gym.map((g) => [g.species, g.stale])).toEqual([['atomic', false], ['pi', true]]);
});

it('honest cockpit: strategy genomes of gym makers and production makers are separate scopes', () => {
  const out = db.prepare("INSERT INTO skill_outcomes (id, skill_id, success, tokens_used, duration_ms, domain, evidence_refs_json, created_at) VALUES (?, ?, ?, 0, 1000, ?, ?, ?)");
  for (let i = 0; i < 3; i++) out.run(`gym${i}`, 'loop-maker:gym:atomic', 1, 'gym', JSON.stringify(['genome:g-base']), ago(1));
  out.run('prod1', 'loop-maker:test-gap:opencode', 0, 'test-gap', JSON.stringify(['genome:g-base']), ago(1));
  const c = operatorCockpit(db, NOW);
  expect(c.genomes.map((g) => [g.scope, g.skill_id, g.outcomes])).toEqual([
    ['production', 'loop-maker:test-gap:opencode', 1],
    ['gym', 'loop-maker:gym:atomic', 3],
  ]);
});
