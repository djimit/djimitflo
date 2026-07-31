import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../database/schema';
import { createCouncilRoutes } from '../routes/council';
import { errorHandler } from '../middleware/error-handler';

describe('Council routes', () => {
  let db: Database.Database;
  let server: Server;
  let modelServer: Server;
  let baseUrl: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);

    const models = express();
    models.use(express.json());
    models.post('/api/generate', (req, res) => {
      const candidates = [...String(req.body.prompt).matchAll(/Candidate ([A-Z]):/g)].map(match => match[1]);
      res.json({
        response: candidates.length ? JSON.stringify({
          evaluations: candidates.map(candidate => ({
            candidate, correctness: 4, evidence_quality: 4, completeness: 4,
            risk_score: 4, policy_compliance: 4, reasoning: 'sound',
          })),
          ranking: candidates,
          confidence: 0.8,
        }) : 'independent answer',
        eval_count: 10,
      });
    });
    modelServer = await new Promise<Server>((resolve) => {
      const listening = models.listen(0, () => resolve(listening));
    });
    process.env.OLLAMA_URL = `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}`;

    const app = express();
    app.use(express.json());
    app.use('/council', createCouncilRoutes(db));
    app.use(errorHandler);
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, () => resolve(listening));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/council`;
  });

  afterEach(async () => {
    delete process.env.OLLAMA_URL;
    await Promise.all([server, modelServer].map(instance => new Promise<void>((resolve, reject) => {
      instance.close(error => error ? reject(error) : resolve());
    })));
    db.close();
  });

  async function request(path: string, init?: RequestInit) {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: init?.body ? { 'content-type': 'application/json', ...init.headers } : init?.headers,
    });
    return { status: response.status, body: await response.json() };
  }

  it('validates every route and completes a council session end to end', async () => {
    expect((await request('/sessions', { method: 'POST', body: '{}' })).status).toBe(400);
    expect((await request('/sessions', { method: 'POST', body: JSON.stringify({ task_description: 'x', max_cost: -1 }) })).status).toBe(400);
    expect((await request('/classify', { method: 'POST', body: '{}' })).status).toBe(400);
    expect((await request('/models?status=broken')).status).toBe(400);

    const modelIds: string[] = [];
    for (const model_name of ['generalist', 'skeptic', 'expert']) {
      const result = await request('/models', {
        method: 'POST',
        body: JSON.stringify({ provider: 'ollama', model_name, avg_governance_score: 4 }),
      });
      expect(result.status).toBe(201);
      modelIds.push(result.body.id);
    }

    expect((await request('/models')).body).toHaveLength(3);
    expect((await request(`/models/${modelIds[0]}`)).body.model_name).toBe('generalist');
    expect((await request('/classify', {
      method: 'POST',
      body: JSON.stringify({ description: 'Architecture security review' }),
    })).body.mode).toBe('council');

    const created = await request('/sessions', {
      method: 'POST',
      body: JSON.stringify({ task_description: 'Review architecture', mode: 'council', risk_class: 'high' }),
    });
    expect(created.status).toBe(201);
    const sessionId = created.body.id;

    expect((await request('/sessions?limit=-2')).body).toHaveLength(1);
    expect((await request(`/sessions/${sessionId}`)).body.phase).toBe('diverging');

    const executed = await request(`/sessions/${sessionId}/execute`, { method: 'POST' });
    expect(executed.status).toBe(200);
    expect(executed.body.session.status).toBe('completed');
    expect(executed.body.requires_human_approval).toBe(true);
    expect((await request(`/sessions/${sessionId}/execute`, { method: 'POST' })).status).toBe(409);
    expect((await request(`/sessions/${sessionId}/outputs`)).body).toHaveLength(3);
    expect((await request(`/sessions/${sessionId}/evaluations`)).body.length).toBeGreaterThan(0);
    expect((await request(`/sessions/${sessionId}/aggregate?method=weighted_borda`)).body.aggregated.length).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM council_aggregations WHERE session_id = ?').get(sessionId)).toEqual({ count: 1 });
    expect((await request(`/sessions/${sessionId}/aggregate?method=invalid`)).status).toBe(400);
    expect((await request('/stats')).body.sessions.completed).toBe(1);

    expect((await request('/sessions/missing/outputs')).status).toBe(404);
    expect((await request('/sessions/missing/evaluations')).status).toBe(404);
    expect((await request('/sessions/missing/aggregate')).status).toBe(404);
    expect((await request('/models/missing', { method: 'DELETE' })).status).toBe(404);

    expect((await request(`/models/${modelIds[0]}`, { method: 'DELETE' })).status).toBe(200);
    expect((await request('/models?status=deprecated')).body).toHaveLength(1);

    const fast = await request('/sessions', {
      method: 'POST',
      body: JSON.stringify({ task_description: 'Answer directly', mode: 'fast', custom_models: ['skeptic'] }),
    });
    const fastResult = await request(`/sessions/${fast.body.id}/execute`, { method: 'POST' });
    expect(fastResult.status).toBe(200);
    expect(JSON.parse(fastResult.body.synthesis)).toMatchObject({
      conclusion: 'independent answer',
      confidence: 0,
      reasoning: { method: 'single_model_no_peer_review' },
    });
  });
});
