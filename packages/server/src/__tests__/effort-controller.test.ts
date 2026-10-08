import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';
import {
  chooseEffort, effortParams, evc, JUDGMENT_CONSUMERS, recordEffortJudgment, recordEffortSibling, siblingArm, type EffortOption,
} from '../services/effort-controller';
import { buildEvolutionEvidence, EVOLUTION_FLAGS } from '../services/evolution-evidence';
import { RemoteGymService } from '../services/remote-gym-service';
import { runJudgment, type JudgmentDef } from '../services/judgment-service';
import type { TypeSafeClient } from '../services/typesafe-client';

const NOW = Date.parse('2026-10-08T12:00:00Z');
const ago = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db); new SkillEvolutionEngine(db); });
afterEach(() => { vi.unstubAllEnvs(); db.close(); });

/** Deterministic LCG in [0, 1). */
const lcg = (seed = 42) => { let s = seed; return () => { s = (s * 1_664_525 + 1_013_904_223) % 4_294_967_296; return s / 4_294_967_296; }; };
const run = (id: string, meta: Record<string, unknown> = {}, loop = 'test-gap', at = ago(0)) => db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
  VALUES (?, ?, 'closed', 'running', '[]', '{}', '[]', '[]', ?, ?, ?)`).run(id, loop, JSON.stringify(meta), at, at);
const events = (type = 'effort_decision') => (db.prepare('SELECT metadata FROM loop_events WHERE event_type = ?').all(type) as Array<{ metadata: string }>).map((r) => JSON.parse(r.metadata));

it('EVC = P·V + VOI − λ_tok·tokens/1M − λ_kWh·kWh, and picks the remote sibling over cloud when cloud P·V < λ_tok·tokens', () => {
  const none: EffortOption = { name: 'none', p: 0, v: 1, voi: 0, tokens: 0, kwh: 0 };
  const remote: EffortOption = { name: 'remote', p: 0.3, v: 1, voi: 0, tokens: 0, kwh: 0.2 };
  const cloud: EffortOption = { name: 'cloud', p: 0.5, v: 1, voi: 0, tokens: 2_000_000, kwh: 0 }; // 0.5 < 0.41 × 2
  const params = { lambda_tok: 0.41, lambda_kwh: 0, exploration: 0 };
  expect(evc(cloud, params)).toBeCloseTo(0.5 - 0.82, 6);
  expect(evc(remote, params)).toBeCloseTo(0.3, 6);
  expect(chooseEffort([none, remote, cloud], params)).toMatchObject({ chosen: 'remote', best: 'remote', explored: false });
  // energy is not free once λ_kWh > 0: the remote option then costs more than it is worth
  expect(chooseEffort([none, remote, cloud], { ...params, lambda_kwh: 10 }).chosen).toBe('none');
  // with VOI, an evaluative option is worth its information
  expect(evc({ name: 'serve', p: 0, v: 1, voi: 0.25, tokens: 0, kwh: 0 }, params)).toBeCloseTo(0.25, 6);
});

it('exploration: with probability EFFORT_EXPLORATION a non-max option is chosen (and marked), never otherwise', () => {
  const opts: EffortOption[] = [{ name: 'a', p: 0.9, v: 1, voi: 0, tokens: 0, kwh: 0 }, { name: 'b', p: 0.1, v: 1, voi: 0, tokens: 0, kwh: 0 }, { name: 'c', p: 0, v: 1, voi: 0, tokens: 0, kwh: 0 }];
  const rng = lcg(7); let explored = 0; const N = 20_000;
  for (let i = 0; i < N; i++) {
    const c = chooseEffort(opts, { lambda_tok: 0, lambda_kwh: 0, exploration: 0.05 }, rng);
    expect(c.best).toBe('a');
    if (c.explored) { explored++; expect(c.chosen).not.toBe('a'); } else expect(c.chosen).toBe('a');
  }
  expect(explored / N).toBeGreaterThan(0.04); expect(explored / N).toBeLessThan(0.06);
  expect(chooseEffort(opts, { lambda_tok: 0, lambda_kwh: 0, exploration: 0 }, () => 0).explored).toBe(false);
  expect(effortParams(db, {}, NOW)).toMatchObject({ lambda_tok: 0.41, lambda_tok_source: 'env', lambda_kwh: 0, exploration: 0.05 });
  expect(effortParams(db, { EFFORT_LAMBDA_TOK: '0.2', EFFORT_LAMBDA_KWH: '0.5', EFFORT_EXPLORATION: '0.1' }, NOW)).toMatchObject({ lambda_tok: 0.2, lambda_kwh: 0.5, exploration: 0.1 });
});

it('λ_tok comes from data when there is any: verified changes per M cloud maker tokens over 7 days (remote/local tokens excluded)', () => {
  const imp = db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, created_at, updated_at) VALUES (?, 'f', 't', 'd', 'r', 's', ?, ?, ?)`);
  imp.run('s1', 'verified', ago(1), ago(1)); imp.run('s2', 'verified', ago(2), ago(2)); imp.run('s3', 'regressed', ago(1), ago(1)); imp.run('old', 'verified', ago(20), ago(20));
  const lease = db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES (?, 'r', 'maker', ?, 'completed', ?, ?, ?)");
  lease.run('l1', 'opencode', JSON.stringify({ model: 'ollama/kimi-k2.6:cloud', runtime_usage: { total_tokens: 3_000_000 } }), ago(1), ago(1));
  lease.run('l2', 'codex', JSON.stringify({ runtime_usage: { total_tokens: 2_000_000 } }), ago(1), ago(1));
  lease.run('l3', 'remote', JSON.stringify({ model: 'workstation/atomic@llama-router', runtime_usage: { total_tokens: 9_000_000 } }), ago(1), ago(1));
  expect(effortParams(db, {}, NOW)).toMatchObject({ lambda_tok: 0.4, lambda_tok_source: 'data' }); // 2 verified / 5 M cloud tokens
});

it('shadow sibling decision: off by default; in shadow records effort_decision with EVC per option and picks remote over a token-hungry cloud species', () => {
  run('r1');
  const REMOTE = { runtime: 'remote', model: 'workstation/atomic@llama-router' }; const CLOUD = { runtime: 'opencode', model: 'ollama/kimi-k2.6:cloud' };
  const out = db.prepare("INSERT INTO skill_outcomes (id, skill_id, success, domain, model, created_at) VALUES (?, ?, ?, 'test-gap', ?, ?)");
  for (let i = 0; i < 10; i++) out.run(`c${i}`, 'loop-maker:test-gap:opencode', i < 5 ? 1 : 0, CLOUD.model, ago(0)); // P ≈ 0.5
  for (let i = 0; i < 10; i++) out.run(`w${i}`, 'loop-maker:test-gap:remote', i < 3 ? 1 : 0, REMOTE.model, ago(0)); // P ≈ 0.33
  db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES ('l1', 'x', 'maker', 'opencode', 'completed', ?, ?, ?)")
    .run(JSON.stringify({ model: CLOUD.model, runtime_usage: { total_tokens: 2_000_000 } }), ago(30), ago(30));
  recordEffortSibling(db, 'r1', 'test-gap', [REMOTE, CLOUD], [REMOTE, CLOUD], {}, () => 0.5, NOW);
  expect(events()).toEqual([]);
  recordEffortSibling(db, 'r1', 'test-gap', [REMOTE, CLOUD], [REMOTE, CLOUD], { EFFORT_CONTROLLER_MODE: 'shadow', EFFORT_EXPLORATION: '0' }, () => 0.5, NOW);
  const [e] = events();
  expect(e).toMatchObject({ decision_point: 'evolve_sibling', default_option: 'all', chosen_option: 'remote@workstation/atomic@llama-router', explored: false });
  expect(Object.keys(e.evc)).toEqual(['all', 'none', 'remote@workstation/atomic@llama-router', 'opencode@ollama/kimi-k2.6:cloud']);
  expect(e.evc['opencode@ollama/kimi-k2.6:cloud']).toBeLessThan(0);
  expect(e.inputs.options.find((o: EffortOption) => o.name === 'remote@workstation/atomic@llama-router')).toMatchObject({ tokens: 0 });
});

it('shadow remote gym claim: same task with the controller on or off; the decision uses the task\'s pass rate for VOI', () => {
  vi.stubEnv('EVOLUTION_GYM_REMOTE_ENABLED', 'true'); vi.stubEnv('LOOP_DAEMON_REPOSITORY_PATH', '/repo');
  const TASK = (commit: string) => ({ commit, source: 'packages/server/src/services/x.ts', tests: ['packages/server/src/__tests__/x.test.ts'], sourceLines: 5 });
  // c1 was attempted by another species: 1 of 3 passed → posterior (1+1)/(2+3) = 0.4 → VOI 0.24
  for (const [i, status] of ['success', 'failure', 'failure'].entries()) run(`h${i}`, { gym: { commit: 'c1', species: 'codex' }, gym_result: { status } }, 'evolution-gym', ago(1));
  const off = new RemoteGymService(db, () => [TASK('c1')]).claim('workstation', ['atomic@llama-router']);
  db.prepare("DELETE FROM loop_runs WHERE json_extract(metadata, '$.gym.remote_host') IS NOT NULL").run();
  vi.stubEnv('EFFORT_CONTROLLER_MODE', 'shadow'); vi.stubEnv('EFFORT_EXPLORATION', '0');
  const on = new RemoteGymService(db, () => [TASK('c1')]).claim('workstation', ['atomic@llama-router']);
  expect({ ...on, runId: 'x' }).toEqual({ ...off, runId: 'x' });
  const [e] = events();
  expect(e).toMatchObject({ decision_point: 'remote_gym_claim', default_option: 'serve', chosen_option: 'serve' });
  expect(e.inputs.task_pass).toMatchObject({ n: 3, ok: 1 });
  expect(e.evc.serve).toBeCloseTo(0.24, 6); expect(e.evc.skip).toBe(0);
});

it('shadow judgment dispatch: the judgment runs and returns exactly as before; a judgment without consumer is worth skipping', async () => {
  vi.stubEnv('TYPESAFE_API_KEY', 'k'); vi.stubEnv('TYPESAFE_COMMONS_IDEA_MODE', 'shadow');
  const def: JudgmentDef = { id: 'commons_idea', questions: { x: { type: 'noul', instructions: 'q' } }, decide: () => ({ decision: 'yes', reason: 'r' }) };
  const client = { systemOne: async () => ({ model: 'jev', answers: { x: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 4_000, output_tokens: 1_000 } }) } as unknown as TypeSafeClient;
  const before = await runJudgment(db, def, { type: 'agent_message', id: 'm1' }, {}, client);
  vi.stubEnv('EFFORT_CONTROLLER_MODE', 'shadow'); vi.stubEnv('EFFORT_EXPLORATION', '0');
  const after = await runJudgment(db, def, { type: 'agent_message', id: 'm2' }, {}, client);
  expect({ ...after, id: 'x' }).toEqual({ ...before, id: 'x' });
  const rows = db.prepare("SELECT subject_id, mode, decision, answers_json FROM judgments WHERE judgment = 'effort_decision'").all() as Array<{ subject_id: string; mode: string; decision: string; answers_json: string }>;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ subject_id: 'm2', mode: 'shadow', decision: 'skip' });
  const meta = JSON.parse(rows[0].answers_json);
  expect(meta).toMatchObject({ decision_point: 'judgment:commons_idea', default_option: 'run', chosen_option: 'skip', inputs: { consumer: null } });
  expect(meta.evc.run).toBeLessThan(0);
  // a judgment whose decision is acted on carries VOI
  expect(JUDGMENT_CONSUMERS.proposal_prescreen).not.toBeNull(); expect(JUDGMENT_CONSUMERS.commons_idea).toBeNull();
  recordEffortJudgment(db, 'proposal_prescreen', { type: 'self_improvement', id: 's1' }, { EFFORT_CONTROLLER_MODE: 'shadow', EFFORT_EXPLORATION: '0' }, () => 0.5, NOW);
  const p = JSON.parse((db.prepare("SELECT answers_json FROM judgments WHERE judgment = 'effort_decision' AND subject_id = 's1'").get() as { answers_json: string }).answers_json);
  expect(p.evc.run).toBeCloseTo(0.25, 6); // no history: q = 0.5, VOI = 0.25, no tokens yet
});

it('X1 randomiser: deterministic per goal id, ~50/50, independent of the memory holdout salt', () => {
  expect(siblingArm('goal-1')).toBe(siblingArm('goal-1'));
  let on = 0; const N = 4_000;
  for (let i = 0; i < N; i++) if (siblingArm(`goal-${i}`) === 'on') on++;
  expect(on / N).toBeGreaterThan(0.47); expect(on / N).toBeLessThan(0.53);
});

it('X1 evidence: per-arm goals, verified, regressed and infra in evolution-evidence effort_x1; flags documented', () => {
  const imp = db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, created_at, updated_at) VALUES (?, 'f', 't', 'd', 'r', 's', ?, ?, ?)`);
  const goal = db.prepare("INSERT INTO goals (id, objective, risk_class, status, metadata, improvement_id, created_at, updated_at) VALUES (?, 'o', 'low', 'completed', ?, ?, ?, ?)");
  const out = db.prepare("INSERT INTO skill_outcomes (id, skill_id, success, domain, task_id, evidence_refs_json, created_at) VALUES (?, 'loop-maker:test-gap:opencode', 0, 'test-gap', ?, ?, ?)");
  const seed = (id: string, arm: string | null, status: string, infra = false) => {
    imp.run(`s-${id}`, status, ago(1), ago(1)); goal.run(`g-${id}`, JSON.stringify(arm ? { effort_arm: arm } : {}), `s-${id}`, ago(1), ago(1));
    db.prepare("INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, created_at, updated_at) VALUES (?, ?, 'test-gap', 'closed', 'completed', ?, ?)").run(`r-${id}`, `g-${id}`, ago(1), ago(1));
    if (infra) out.run(`o-${id}`, `r-${id}`, JSON.stringify(['outcome_class:infra_failed']), ago(1));
  };
  seed('a', 'on', 'verified'); seed('b', 'on', 'verified'); seed('c', 'on', 'regressed', true);
  seed('d', 'off', 'verified'); seed('e', 'off', 'regressed'); seed('f', 'off', 'executing', true); seed('n', null, 'verified');
  const e = buildEvolutionEvidence(db, { EFFORT_SIBLING_RANDOMISE: 'true' }, NOW, 30);
  expect(e.effort_x1).toMatchObject({
    enabled: 'true',
    on: { goals: 3, verified: 2, regressed: 1, infra: 1, verified_rate: 0.667 },
    off: { goals: 3, verified: 1, regressed: 1, infra: 1, verified_rate: 0.5 },
  });
  expect(typeof e.effort_x1.fisher_p).toBe('number');
  for (const name of ['EFFORT_CONTROLLER_MODE', 'EFFORT_LAMBDA_TOK', 'EFFORT_LAMBDA_KWH', 'EFFORT_EXPLORATION']) expect(EVOLUTION_FLAGS).toContainEqual({ name, acting: false });
  expect(EVOLUTION_FLAGS).toContainEqual({ name: 'EFFORT_SIBLING_RANDOMISE', acting: true });
});
