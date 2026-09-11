import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from './helpers/test-db';
import { createExplainerRoutes } from '../routes/explainer';
import { createGymRoutes } from '../routes/gym';
import { createSegmlRoutes } from '../routes/segml';
import { createSwarmIntelRoutes } from '../routes/swarm-intel';
import { createApexRoutes } from '../routes/apex';
import { createExplorePublicRoutes } from '../routes/explore-public';
import { createGoalRoutes } from '../routes/goals';
import { createHealthRoutes } from '../routes/health';
import { createTaskRoutes } from '../routes/tasks';
import { createGitHubWebhookRoutes } from '../routes/github-webhooks';

describe('remaining module-covered route boundaries', () => {
  const dbs: ReturnType<typeof createTestDb>[] = [];
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

  it('enforces permission boundaries on every formerly module-covered mutation route', async () => {
    const db = createTestDb();
    dbs.push(db);
    const auth = {
      requirePermission: () => (_req: any, res: any) => res.status(403).json({ error: { code: 'FORBIDDEN' } }),
    } as any;
    const app = express().use(express.json());
    app.use('/api/explainer', createExplainerRoutes(db, auth));
    app.use('/api/gym', createGymRoutes(db, auth));
    app.use('/api/segml', createSegmlRoutes(db, auth));
    app.use('/api/swarms', createSwarmIntelRoutes(db, auth));
    app.use('/api/apex', createApexRoutes(db, auth, false));
    app.use('/api/goals', createGoalRoutes(db, auth));
    app.use('/api/health', createHealthRoutes(db, auth));
    app.use('/api/tasks', createTaskRoutes(db, undefined, auth));

    await request(app).post('/api/explainer/fleet/regenerate').send({ full_name: 'fixture/repo' }).expect(403);
    await request(app).post('/api/gym/governance/fixture-skill/run').send({}).expect(403);
    await request(app).post('/api/gym/governance/fixture-skill/retest').send({}).expect(403);
    await request(app).post('/api/segml/run/fixture-agent').send({}).expect(403);
    await request(app).post('/api/swarms/intelligence/outcome-learning/capabilities/fixture/release').send({}).expect(403);
    await request(app).post('/api/swarms/intelligence/capabilities/fixture/promote').send({}).expect(403);
    await request(app).post('/api/apex/plugins/fixture/enable').send({}).expect(403);
    await request(app).post('/api/apex/plugins/fixture/disable').send({}).expect(403);
    await request(app).post('/api/apex/workers/fixture/run').send({}).expect(403);
    await request(app).post('/api/apex/workers/fixture/start').send({}).expect(403);
    await request(app).post('/api/apex/workers/fixture/stop').send({}).expect(403);
    await request(app).get('/api/goals').expect(403);
    await request(app).get('/api/health/metrics').expect(403);
    await request(app).get('/api/tasks/fixture/events').expect(404);
  });

  it('exercises public and out-of-band route contracts on bounded fixtures', async () => {
    const db = createTestDb();
    dbs.push(db);
    const auth = {
      requirePermission: () => (_req: any, res: any) => res.status(403).json({ error: { code: 'FORBIDDEN' } }),
    } as any;
    const app = express().use(createExplorePublicRoutes(db));
    await request(app).get('/fixture/repo/llms.txt').expect(404);
    await request(app).get('/fixture/repo/opengraph.svg').expect(404);
    await request(app).get('/sitemap.xml').expect(200);
    await request(app).get('/robots.txt').expect(200);
    await request(app).get('/fixture/repo/badge.svg').expect(404);
    await request(app).get('/leaderboard').expect(404);

    vi.stubEnv('GITHUB_WEBHOOK_SECRET', '');
    const webhookApp = express().use(createGitHubWebhookRoutes(db));
    await request(webhookApp).post('/').set('Content-Type', 'application/json').send('{}').expect(503);

    const relativeApp = express().use(createGoalRoutes(db, auth)).use(createHealthRoutes(db, auth)).use(createTaskRoutes(db, undefined, auth));
    await request(relativeApp).get('/').expect(403);
    await request(relativeApp).get('/metrics').expect(403);
    await request(relativeApp).get('/fixture/events').expect(404);
  });
});
