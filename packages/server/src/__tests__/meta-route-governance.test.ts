import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ROLE_PERMISSIONS } from '@djimitflo/shared';
import { createTestDb } from './helpers/test-db';
import { createMetaOrchestrationRoutes } from '../routes/meta-orchestration';
import { MetaOrchestrationService } from '../services/meta-orchestration-service';
import { CognitiveLoopClosureService } from '../services/cognitive-loop-closure-service';

describe('meta tuning governance route', () => {
  it('requires write:governance for tuning mutation', async () => {
    const db = createTestDb();
    const meta = new MetaOrchestrationService(db);
    const auth = {
      requirePermission: (permission: string) => (req: any, res: any, next: any) => {
        const role = req.user?.role as keyof typeof ROLE_PERMISSIONS;
        if (!ROLE_PERMISSIONS[role]?.includes(permission)) return res.status(403).json({ error: { code: 'FORBIDDEN' } });
        next();
      },
    } as any;
    const appForRole = (role: string) => {
      const app = express();
      app.use(express.json());
      app.use((_req: any, _res, next) => { _req.user = { role }; next(); });
      app.use('/meta', createMetaOrchestrationRoutes(db, auth, meta));
      app.use('/api/meta', createMetaOrchestrationRoutes(db, auth, meta));
      return app;
    };
    const viewerApp = appForRole('viewer');
    const readRoutes = [
      ['/meta/stats', undefined],
      ['/meta/tuning/engineering', undefined],
      ['/meta/tuning-history', undefined],
      ['/meta/routing/coding', undefined],
      ['/meta/strategy/engineering', undefined],
      ['/meta/predict', { title: 'test', description: 'test', priority: 'normal', riskLevel: 'low', executionMode: 'test', tags: [], metadata: {} }],
    ] as const;
    for (const [path, body] of readRoutes) {
      const response = body === undefined
        ? await request(viewerApp).get(path)
        : await request(viewerApp).post(path).send(body);
      expect(response.status, path).toBe(200);
    }
    const canonicalPrediction = await request(viewerApp).post('/api/meta/predict').send({ title: 'canonical', description: 'canonical route', tags: [] });
    expect(canonicalPrediction.status).toBe(200);
    expect(canonicalPrediction.body).toMatchObject({ willFail: false, confidence: 0.5 });
    const stats = (await request(viewerApp).get('/meta/stats')).body;
    expect(stats).toMatchObject({ enabled: true, autoTuningsApplied: 0 });
    expect(stats.totalDecisions).toBeGreaterThan(0);
    expect((await request(viewerApp).get('/meta/tuning-history?limit=1')).body).toEqual([]);
    expect((await request(viewerApp).get('/meta/routing/coding')).body).toMatchObject({ taskType: 'coding', recommendedModel: 'workstation-litellm/coding' });
    expect((await request(viewerApp).get('/meta/strategy/engineering')).body).toMatchObject({ strategy: 'maker-checker-v1', confidence: 0.3 });
    for (const body of [{}, { title: 'missing tags', description: 'invalid' }, { title: 42, description: 'invalid', tags: [] }]) {
      const invalid = await request(viewerApp).post('/meta/predict').send(body);
      expect(invalid.status).toBe(400);
    }
    for (const role of ['platform_admin', 'approver', 'maker', 'checker', 'auditor', 'viewer']) {
      expect((await request(appForRole(role)).post('/meta/tuning/run').send({})).status, role).toBe(403);
    }
    const adminRun = await request(appForRole('admin')).post('/meta/tuning/run').send({});
    expect(adminRun.status).toBe(200);
    expect(adminRun.body).toEqual({ evaluated: 0, applied: 0 });
    meta.stop();
    db.close();
  });

  it('applies tuning from persisted loop evidence and exposes the durable result through read routes', async () => {
    const db = createTestDb();
    const cognitive = new CognitiveLoopClosureService(db);
    const meta = new MetaOrchestrationService(db);
    const auth = {
      requirePermission: (permission: string) => (req: any, res: any, next: any) => {
        const role = req.user?.role as keyof typeof ROLE_PERMISSIONS;
        if (!ROLE_PERMISSIONS[role]?.includes(permission)) return res.status(403).json({ error: { code: 'FORBIDDEN' } });
        next();
      },
    } as any;
    const app = express();
    app.use(express.json());
    app.use((_req: any, _res, next) => { _req.user = { role: 'admin' }; next(); });
    app.use('/api/meta', createMetaOrchestrationRoutes(db, auth, meta));

    for (let i = 0; i < 20; i++) {
      const completedAt = new Date(Date.UTC(2026, 8, 9, 0, 0, i + 1)).toISOString();
      cognitive.recordEpisode({
        loopRunId: `meta-route-${i}`, goalId: 'fixture', goalType: 'doc-drift', mode: 'closed',
        startedAt: '2026-09-09T00:00:00Z', completedAt, durationMs: 1000, outcome: 'success',
        strategy: 'fixture', actions: [],
        metrics: { totalLeases: 1, completedLeases: 1, failedLeases: 0, totalTokens: 2000,
          totalCostDollars: 0, diffLinesChanged: 1, filesModified: 1, gatesPassed: 1, gatesFailed: 0 },
        metadata: { synthetic: true, provider_executed: false },
      });
    }

    expect(await request(app).post('/api/meta/tuning/run').send({})).toMatchObject({ status: 200, body: { evaluated: 1, applied: 1 } });
    expect(db.prepare('SELECT COUNT(*) AS n FROM meta_tuning_log WHERE applied=1').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM meta_active_loop_parameters WHERE goal_type=?').get('doc-drift')).toEqual({ n: 1 });
    expect((await request(app).get('/api/meta/tuning/doc-drift')).body).toMatchObject({
      goalType: 'doc-drift', confidence: 0.9, recommendedBudget: { maxTokens: 3000 },
    });
    expect((await request(app).get('/api/meta/tuning-history?goalType=doc-drift')).body).toMatchObject([
      { goalType: 'doc-drift', applied: true, confidence: 0.9 },
    ]);

    cognitive.stop();
    meta.stop();
    db.close();
  });
});
