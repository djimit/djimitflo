import { afterEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAgentSocialRuntimeRoutes, createSwarmOrchestrationRoutes, publicBaseUrl } from '../routes/swarm-orchestration';
import { AgentCommunicationService } from '../services/agent-communication-service';
import { createTestDb } from './helpers/test-db';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('C6: lure status and join requests need manage:tokens (viewers hold read:evidence); the commons list is bounded', async () => {
  const db = createTestDb();
  const asked: Record<string, string> = {};
  const auth = { requirePermission: (permission: string) => (req: any, _res: any, next: any) => { asked[`${req.method} ${req.path}`] = permission; req.user = { sub: 'u' }; next(); } } as any;
  const list = vi.spyOn(AgentCommunicationService.prototype, 'listSocialCommons');
  const app = express().use(express.json()).use('/swarm', createSwarmOrchestrationRoutes(db, auth));
  await request(app).get('/swarm/social/lures');
  await request(app).get('/swarm/social/join-requests');
  await request(app).get('/swarm/social/commons?limit=1000000');
  await request(app).get('/swarm/social/commons?limit=-5');
  expect(asked['GET /social/lures']).toBe('manage:tokens');
  expect(asked['GET /social/join-requests']).toBe('manage:tokens');
  expect(list.mock.calls.map((c) => c[0])).toEqual([200, 1]);
  db.close();
});

it('C6: the public agent card uses DJIMITFLO_PUBLIC_URL, not a spoofed Host header', async () => {
  const db = createTestDb();
  vi.stubEnv('JWT_SECRET', 'c6-test-secret-with-enough-entropy-000');
  vi.stubEnv('DJIMITFLO_PUBLIC_URL', 'https://djimitflo.agentical.nl/');
  const app = express().use(express.json()).use('/api/swarm-v2/social-runtime', createAgentSocialRuntimeRoutes(db));
  const card = await request(app).get('/api/swarm-v2/social-runtime/card').set('Host', 'evil.example');
  expect(JSON.stringify(card.body)).not.toContain('evil.example');
  expect(card.body.join.url).toMatch(/^https:\/\/djimitflo\.agentical\.nl\//);
  expect(publicBaseUrl({ protocol: 'http', get: () => 'h:1' }, { DJIMITFLO_PUBLIC_URL: 'javascript:alert(1)' } as NodeJS.ProcessEnv)).toBe('http://h:1');
  db.close();
});
