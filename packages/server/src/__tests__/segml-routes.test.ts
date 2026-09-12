import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTestDb } from './helpers/test-db';
import { createSegmlRoutes } from '../routes/segml';
import { errorHandler } from '../middleware/error-handler';

describe('SEGML HTTP contracts', () => {
  let server: Server | undefined;
  let db: ReturnType<typeof createTestDb> | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    db?.close();
    server = undefined;
    db = undefined;
  });

  it('rejects malformed cycle-history limits before SQLite access', async () => {
    db = createTestDb();
    const app = express();
    app.use('/segml', createSegmlRoutes(db));
    app.use(errorHandler);
    server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const value of ['NaN', '0', '101', '1.5']) {
      const response = await fetch(`${base}/segml/history?limit=${value}`);
      expect(response.status, value).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }
    const valid = await fetch(`${base}/segml/history?limit=1`);
    expect(valid.status).toBe(200);
    expect((await valid.json()).cycles).toEqual([]);

    app.use('/api/segml', createSegmlRoutes(db));
    expect((await fetch(`${base}/api/segml/generated-cases`)).status).toBe(200);
    const judge = await fetch(`${base}/api/segml/judge-rubrics`);
    expect(judge.status, await judge.text()).toBe(200);
    expect((await fetch(`${base}/api/segml/curriculum`)).status).toBe(200);
    expect((await fetch(`${base}/api/segml/latest`)).status).toBe(404);
    expect((await fetch(`${base}/api/segml/blind-spots/missing`)).status).toBe(404);

    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const finishedAt = new Date().toISOString();
    db.prepare(`INSERT INTO openmythos_eval_runs
      (id, agent_id, started_at, finished_at, total_cases, completed_cases, overall_score, status, metadata)
      VALUES (?, ?, ?, ?, 1, 1, 1.5, 'completed', ?)`)
      .run('eval-route-fixture', 'route-agent', startedAt, finishedAt, JSON.stringify({ category_scores: { injection: 1.5 } }));
    db.prepare(`INSERT INTO openmythos_case_results
      (id, run_id, case_id, category, difficulty, response, judge_score, judge_rationale, status)
      VALUES (?, ?, ?, ?, 3, ?, 1.5, ?, 'completed')`)
      .run('eval-case-route-fixture', 'eval-route-fixture', 'case-route-fixture', 'injection', 'unsafe answer', 'Failed injection');

    const cycleResponse = await fetch(`${base}/api/segml/run/route-agent`, { method: 'POST' });
    expect(cycleResponse.status).toBe(200);
    const cycle = await cycleResponse.json() as any;
    expect(cycle).toMatchObject({ status: 'completed', eval_run_id: 'eval-route-fixture' });
    expect(cycle.cases_generated).toBeGreaterThan(0);

    const history = await fetch(`${base}/api/segml/history?limit=1`);
    expect((await history.json() as any).cycles[0]).toMatchObject({ id: cycle.id, status: 'completed', cases_generated: cycle.cases_generated });
    const generatedCases = await fetch(`${base}/api/segml/generated-cases?cycle_id=${cycle.id}`);
    expect((await generatedCases.json() as any).count).toBe(cycle.cases_generated);

    const failedCycle = await fetch(`${base}/api/segml/run/no-evaluation`, { method: 'POST' });
    expect(failedCycle.status).toBe(200);
    const failed = await failedCycle.json() as any;
    expect(failed.status).toBe('failed');
    const latest = await fetch(`${base}/api/segml/history?limit=1`);
    expect((await latest.json() as any).cycles[0]).toMatchObject({ id: failed.id, status: 'failed' });
  });
});
