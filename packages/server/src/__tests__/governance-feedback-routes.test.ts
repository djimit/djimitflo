import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import Database from 'better-sqlite3';
import { createGovernanceFeedbackRoutes } from '../routes/governance-feedback';

describe('governance feedback routes', () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  it('rejects a missing authenticated principal instead of fabricating an admin', async () => {
    const db = new Database(':memory:');
    const app = express();
    app.use(express.json());
    app.use('/governance-feedback', createGovernanceFeedbackRoutes(db, {
      requirePermission: () => (_req: any, _res: any, next: any) => next(),
    } as any));
    server = createServer(app);
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test listener unavailable');

    const response = await fetch(`http://127.0.0.1:${address.port}/governance-feedback/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent_id: 'agent-1' }),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    db.close();
  });
});
