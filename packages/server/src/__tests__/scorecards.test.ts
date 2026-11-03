import { expect, it } from 'vitest';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import request from 'supertest';
import Database from 'better-sqlite3';
import { UserRole } from '@djimitflo/shared';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { createTestDb } from './helpers/test-db';
import { createAuthMiddleware } from '../middleware/auth';
import { AuthService } from '../services/auth-service';
import { createHealthRoutes } from '../routes/health';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';
import { agentScorecards, runtimeScorecards } from '../services/scorecards';

const NOW = Date.parse('2026-10-06T12:00:00Z');
const ago = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

function seed() {
  const db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = ON'); new SkillEvolutionEngine(db);
  const out = db.prepare(`INSERT INTO skill_outcomes (id, skill_id, success, tokens_used, duration_ms, domain, model, evidence_refs_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  // opencode real makers: durations 10..100 s, 7 of 10 succeed; two tagged failures + one untagged
  for (let i = 1; i <= 10; i++) {
    const ok = i <= 7 ? 1 : 0;
    const refs = i === 8 ? '["outcome_class:infra_failed"]' : i === 9 ? '["outcome_class:regressed"]' : '[]';
    out.run(`o${i}`, 'loop-maker:test-gap:opencode', ok, 1_000_000, i * 10_000, 'loop', 'kimi-k3:cloud', refs, ago(1));
  }
  out.run('old', 'loop-maker:test-gap:opencode', 1, 0, 1, 'loop', null, '[]', ago(40)); // outside 30 d
  out.run('g1', 'loop-maker:gym:atomic', 1, 0, 5_000, 'gym', 'llama-router', '[]', ago(1)); // gym is not a real maker
  out.run('m1', 'loop-maker:merge:opencode', 1, 0, 0, 'merge', null, '[]', ago(1)); // merge survival is not a run
  // fleet agents
  out.run('a1', 'agent:hermes-eve-v:dream-scout', 1, 0, 0, 'fleet', null, '[]', ago(2));
  out.run('a2', 'agent:hermes-eve-v:dream-scout', 0, 0, 0, 'fleet', null, '[]', ago(1));
  out.run('a3', 'agent:hermes-eve-v:publish-goals', 1, 0, 0, 'fleet', null, '[]', ago(1));
  return db;
}

it('UX-17: runtime scorecard — n, success with a Wilson interval, nearest-rank p50/p95 and failure classes (gym/merge excluded)', () => {
  const [card] = runtimeScorecards(seed(), NOW, {});
  expect(card.runtime).toBe('opencode');
  expect(card.outcomes).toMatchObject({ n: 10, ok: 7, success_rate: 0.7 });
  expect(card.outcomes.ci![0]).toBeCloseTo(0.3968, 3); expect(card.outcomes.ci![1]).toBeCloseTo(0.8922, 3);
  expect(card.duration_ms).toEqual({ p50: 50_000, p95: 100_000 });
  expect(card.tokens).toBe(10_000_000);
  expect(card.failure_classes).toEqual({ infra_failed: 1, regressed: 1, untagged: 1 });
  expect(runtimeScorecards(seed(), NOW, {}).map((c) => c.runtime)).toEqual(['opencode']); // no 'gym' / 'merge' rows
});

it('UX-17: cost is null with a reason when a price is unknown or split in/out; computed only from a configured flat price', () => {
  expect(runtimeScorecards(seed(), NOW, {})[0].cost).toEqual({ usd: null, reason: 'no price for kimi-k3:cloud' });
  expect(runtimeScorecards(seed(), NOW, { LLM_PRICE_PER_MTOK: 'kimi-k3=1/3' })[0].cost).toEqual({ usd: null, reason: 'in/out split unknown for kimi-k3:cloud' });
  expect(runtimeScorecards(seed(), NOW, { LLM_PRICE_PER_MTOK: 'kimi-k3=0.5/0.5' })[0].cost).toEqual({ usd: 5, reason: null });
});

it('UX-17: agent scorecard per fleet agent and task kind; connection state only where an agent record exists', () => {
  const db = seed();
  const [card] = agentScorecards(db, NOW);
  expect(card).toMatchObject({ agent: 'hermes-eve-v', n: 3, ok: 2, success_rate: 0.667, last_outcome_at: ago(1), connection_state: null });
  expect(card.task_kinds).toEqual([{ task_kind: 'dream-scout', n: 2, ok: 1, success_rate: 0.5 }, { task_kind: 'publish-goals', n: 1, ok: 1, success_rate: 1 }]);
  expect(card.ci).not.toBeNull();
  db.prepare("INSERT INTO agents (id, name, description, status, capabilities, metadata, last_active_at, created_at, updated_at) VALUES ('hermes-eve-v', 'Hermes Eve-V', 'fleet agent', 'active', '[]', '{}', ?, ?, ?)").run(ago(3), ago(30), ago(3));
  expect(agentScorecards(db, NOW)[0]).toMatchObject({ connection_state: 'lapsed' });
});

it('UX-17: GET /api/health/scorecards requires a login and returns both sections', async () => {
  const db = createTestDb(); new SkillEvolutionEngine(db);
  const authService = new AuthService(db);
  const token = authService.generateToken(authService.createUser('scorecards@example.test', 'disposable-password', UserRole.VIEWER));
  const auth = createAuthMiddleware(authService);
  const app = express().use(rateLimit({ windowMs: 60_000, limit: 600 })).use('/api/health', createHealthRoutes(db, auth));
  expect((await request(app).get('/api/health/scorecards')).status).toBe(401);
  const res = await request(app).get('/api/health/scorecards').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ runtimes: [], agents: [] });
});
