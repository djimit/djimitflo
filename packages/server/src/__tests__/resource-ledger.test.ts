import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import request from 'supertest';
import { UserRole } from '@djimitflo/shared';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { createTestDb } from './helpers/test-db';
import { createAuthMiddleware } from '../middleware/auth';
import { AuthService } from '../services/auth-service';
import { createHealthRoutes } from '../routes/health';
import { createHostAgentRoutes, HOST_AGENT_SCOPE } from '../routes/host-agent';
import { mintSpawnToken, resolveSpawnTokenSecret } from '../services/spawn-token';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';
import { RemoteMakerQueue } from '../services/remote-maker-queue';
import { efficiencyView, integrateWh, isLocalModel, recordPowerSample, valuePer } from '../services/resource-ledger';

const NOW = Date.parse('2026-10-08T12:00:00Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const H = 3_600_000;
let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); delete process.env.RESOURCE_LEDGER_ENABLED; });
afterEach(() => { db.close(); delete process.env.RESOURCE_LEDGER_ENABLED; });

/** one sample per minute at `watts` over [fromMsAgo, toMsAgo] on host */
function samples(host: string, watts: number, fromMsAgo: number, toMsAgo: number) {
  for (let t = fromMsAgo; t >= toMsAgo; t -= 60_000) recordPowerSample(db, host, { gpu_watts: watts }, NOW - t);
}

it('E1: integrates Wh over power samples, does not bridge gaps, clips to the window and never invents a reading', () => {
  const s = Array.from({ length: 61 }, (_, i) => ({ t: i * 60_000, w: 100 }));
  expect(integrateWh(s, 0, H)).toEqual({ wh: 100, covered_s: 3600 });
  expect(integrateWh(s, 15 * 60_000, 45 * 60_000)).toEqual({ wh: 50, covered_s: 1800 }); // clipped to the job window
  const ramp = [{ t: 0, w: 0 }, { t: 60_000, w: 120 }];
  expect(integrateWh(ramp, 0, 60_000).wh).toBe(1); // trapezoid: mean 60 W × 1 min
  const gapped = s.filter((x) => x.t <= 20 * 60_000 || x.t >= 50 * 60_000); // 30-min outage
  expect(integrateWh(gapped, 0, H)).toEqual({ wh: 50, covered_s: 1800 });
  expect(integrateWh([], 0, H)).toEqual({ wh: 0, covered_s: 0 });
  expect(integrateWh([{ t: 10, w: 300 }], 0, H)).toEqual({ wh: 0, covered_s: 0 }); // one lone sample is not a measurement
});

it('E1: stores only valid power readings and keeps them per host', () => {
  expect(recordPowerSample(db, 'ws', { gpu_watts: 212.04 }, NOW)).toBe(true);
  for (const bad of [null, {}, { gpu_watts: '200' }, { gpu_watts: -1 }, { gpu_watts: Number.NaN }, { gpu_watts: 9_999 }]) expect(recordPowerSample(db, 'ws', bad, NOW)).toBe(false);
  expect(db.prepare('SELECT host, gpu_watts FROM host_power_samples').all()).toEqual([{ host: 'ws', gpu_watts: 212 }]);
});

it('E1: classifies local vs cloud model calls (ollama :cloud models are cloud)', () => {
  expect(isLocalModel('ollama', 'qwen3:8b')).toBe(true);
  expect(isLocalModel('ollama', 'qwen3.5:cloud')).toBe(false);
  expect(isLocalModel('litellm', 'kimi-k2.6')).toBe(false);
  expect(isLocalModel(null, 'ollama:qwen3:8b')).toBe(true);
});

it('E3: value per resource carries a Wilson interval only when n allows', () => {
  expect(valuePer(1, 3, 2)).toEqual({ value: 0.5, low: null, high: null, n: 3 });
  const v = valuePer(5, 10, 2)!;
  expect(v.value).toBe(2.5); expect(v.low!).toBeLessThan(2.5); expect(v.high!).toBeGreaterThan(2.5);
  expect(valuePer(3, 10, 0)).toBeNull();
});

it('E1/E3: aggregates tokens, GPU time, measured Wh and verified outcomes per consumer, plus the north star', () => {
  const run = (id: string, loop: string, status: string, meta: object, created: string, completed: string | null) =>
    db.prepare('INSERT INTO loop_runs (id, loop_name, mode, status, metadata, created_at, updated_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, loop, 'closed', status, JSON.stringify(meta), created, completed ?? created, completed);
  const lease = (id: string, role: string, runtime: string, model: string | null, tokens: number) =>
    db.prepare('INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, 'r-prod', role, runtime, 'completed', JSON.stringify({ model, runtime_usage: { total_tokens: tokens } }), iso(2 * H), iso(2 * H));
  run('r-prod', 'test-gap', 'completed', {}, iso(2 * H), iso(H));
  lease('l1', 'maker', 'opencode', 'glm-5', 3_000_000);
  lease('l2', 'checker', 'codex', null, 1_000_000);
  lease('l3', 'maker', 'remote', 'ws/atomic@llama-router', 400_000); // runs on the workstation: local tokens
  lease('l4', 'maker', 'opencode', 'glm-5', 10_000_000); // last week: outside the 7-day view, inside the north-star trend
  db.prepare('UPDATE worker_leases SET created_at = ? WHERE id = ?').run(iso(10 * 24 * H), 'l4');
  const call = (consumer: string, model: string, provider: string, tin: number, tout: number) =>
    db.prepare('INSERT INTO llm_model_calls (consumer, model, ok, provider, tokens_in, tokens_out, created_at) VALUES (?, ?, 1, ?, ?, ?, ?)').run(consumer, model, provider, tin, tout, iso(3 * H));
  call('jev', 'kimi-k2.6', 'litellm', 600_000, 400_000);
  call('committee', 'qwen3:8b', 'ollama', 50_000, 0);

  // gym run on the workstation: 1 h at 300 W, fully sampled → 300 Wh
  run('g1', 'evolution-gym', 'completed', { gym: { species: 'atomic@llama-router', remote_host: 'ws' } }, iso(6 * H), iso(5 * H));
  samples('ws', 300, 6 * H, 5 * H);
  // remote maker job on the workstation: 1 h, samples cover only the first 30 min → partial, no value per kWh
  new RemoteMakerQueue(db);
  db.prepare("INSERT INTO remote_maker_jobs (id, host, species, base_commit, prompt, status, created_at, claimed_at, finished_at) VALUES ('m1', 'ws', 'atomic@llama-router', 'abc', 'p', 'done', ?, ?, ?)")
    .run(iso(4 * H), iso(4 * H), iso(3 * H));
  samples('ws', 200, 4 * H, 3.5 * H);
  // committee job on a host that never reported power → not measured
  db.prepare("INSERT INTO committee_jobs (id, subject_id, question_json, as_of, status, host, claimed_at, finished_at, created_at) VALUES ('c1', 's', '{}', ?, 'done', 'macmini', ?, ?, ?)")
    .run(iso(H), iso(H), iso(0.5 * H), iso(H));

  const skills = new SkillEvolutionEngine(db);
  for (let i = 0; i < 6; i++) skills.recordOutcome('loop-maker:test-gap:opencode', { success: i < 3, tokensUsed: 0, durationMs: 0, domain: 'test-gap', model: 'glm-5' });
  skills.recordOutcome('loop-maker:gym:atomic', { success: true, tokensUsed: 0, durationMs: 0, domain: 'gym', model: 'llama-router' }); // gym is not a verified change
  db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, created_at, updated_at) VALUES ('si1', 'feature', 't', 'd', 'r', 'gap_analysis', 'verified', ?, ?)`).run(iso(H), iso(H));
  db.prepare('UPDATE skill_outcomes SET created_at = ?').run(iso(3 * H)); // inside the 7-day window whatever the wall clock

  const v = efficiencyView(db, NOW, {});
  const row = (c: string) => v.consumers.find((x) => x.consumer === c)!;
  expect(v.ledger_enabled).toBe(false);
  expect(row('maker:opencode@glm-5')).toMatchObject({ cloud_tokens: 3_000_000, local_tokens: 0, verified: 3, attempts: 6, lanes: { 'test-gap': 3 }, energy: 'not_measured', wh: null, per_kwh: null });
  expect(row('maker:opencode@glm-5').per_m_tokens).toMatchObject({ value: 1, n: 6 });
  expect(row('maker:opencode@glm-5').per_m_tokens!.low).not.toBeNull();
  expect(row('reviewer:checker:codex')).toMatchObject({ cloud_tokens: 1_000_000, verified: null });
  expect(row('llm:jev')).toMatchObject({ cloud_tokens: 1_000_000, local_tokens: 0 });
  expect(row('llm:committee')).toMatchObject({ cloud_tokens: 0, local_tokens: 50_000 });
  expect(row('gym:atomic@llama-router')).toMatchObject({ jobs: 1, gpu_seconds: 3600, wh: 300, energy: 'measured', energy_coverage: 1, verified: null });
  const remote = row('maker:remote@ws/atomic@llama-router');
  expect(remote).toMatchObject({ local_tokens: 400_000, cloud_tokens: 0, jobs: 1, gpu_seconds: 3600, energy: 'partial', per_kwh: null });
  expect(remote.wh).toBe(100); expect(remote.energy_coverage).toBe(0.5);
  expect(row('committee')).toMatchObject({ jobs: 1, gpu_seconds: 1800, wh: null, energy: 'not_measured' });
  expect(v.consumers.some((c) => c.consumer.includes('gym') && c.verified !== null)).toBe(false);
  // per host: the wall-meter comparable total (300 Wh + 100 Wh), and the daily ledger rows
  expect(v.hosts).toEqual([expect.objectContaining({ host: 'ws', gpu_kwh: 0.4, covered_h: 1.5 })]);
  expect(v.ledger.find((d) => d.consumer === 'gym:atomic@llama-router')).toMatchObject({ day: '2026-10-08', wh: 300, jobs: 1 });
  // north star: this week 1 verified ÷ 5 cloud M tokens (3 M maker + 1 M checker + 1 M jev) and ÷ 0.4 measured kWh
  expect(v.north_star.weeks).toHaveLength(8);
  expect(v.north_star.weeks[0]).toMatchObject({ verified: 1, cloud_m_tokens: 5, local_kwh: 0.4, per_m_tokens: 0.2, per_kwh: 2.5 });
  expect(v.north_star.weeks[1]).toMatchObject({ verified: 0, cloud_m_tokens: 10, local_kwh: null, per_kwh: null });
});

it('E1: the host-agent poll stores the GPU power sample only with RESOURCE_LEDGER_ENABLED, and never fails the heartbeat', async () => {
  const app = express().use(rateLimit({ windowMs: 60_000, limit: 600 })).use(express.json())
    .use('/api/host-agent', createHostAgentRoutes(db, { requireAuth: (_q: any, _s: any, n: any) => n(), requirePermission: () => (_q: any, _s: any, n: any) => n() } as any));
  const token = mintSpawnToken(resolveSpawnTokenSecret(), 'ws', HOST_AGENT_SCOPE, 60_000);
  const poll = (info: object) => request(app).post('/api/host-agent/poll').set('X-Host', 'ws').set('X-Host-Token', token).send({ version: '3', info });
  const stored = () => { try { return (db.prepare('SELECT COUNT(*) AS n FROM host_power_samples').get() as { n: number }).n; } catch { return 0; } };
  expect((await poll({ os: 'linux', power: { gpu_watts: 250, source: 'rocm-smi' } })).status).toBe(200);
  expect(stored()).toBe(0);
  process.env.RESOURCE_LEDGER_ENABLED = 'true';
  expect((await poll({ os: 'linux', power: { gpu_watts: 250, source: 'rocm-smi' } })).status).toBe(200);
  expect((await poll({ os: 'linux', power: { gpu_watts: 'lots' } })).status).toBe(200);
  expect((await poll({ os: 'darwin' })).status).toBe(200);
  expect(stored()).toBe(1);
});

it('E3: GET /api/health/efficiency requires read:evidence and returns consumers, ledger, hosts and the north star', async () => {
  const tdb = createTestDb();
  const authService = new AuthService(tdb);
  const auth = createAuthMiddleware(authService);
  const viewer = authService.generateToken(authService.createUser('eff-viewer@example.test', 'disposable-password', UserRole.VIEWER));
  const app = express().use(rateLimit({ windowMs: 60_000, limit: 600 })).use('/api/health', createHealthRoutes(tdb, auth));
  expect((await request(app).get('/api/health/efficiency')).status).toBe(401);
  const res = await request(app).get('/api/health/efficiency').set('Authorization', `Bearer ${viewer}`);
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ window_days: 7, ledger_enabled: false, consumers: expect.any(Array), ledger: expect.any(Array), hosts: [], notes: expect.any(Array) });
  expect(res.body.north_star.weeks).toHaveLength(8);
  expect(res.body.north_star.weeks[0]).toMatchObject({ local_kwh: null, per_kwh: null });
});
