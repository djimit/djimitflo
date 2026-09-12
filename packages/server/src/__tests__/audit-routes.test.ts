import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTestDb } from './helpers/test-db';
import { AuditService } from '../services/audit-service';
import { createAuditRoutes } from '../routes/audit';
import { errorHandler } from '../middleware/error-handler';

describe('audit HTTP contracts', () => {
  let server: Server | undefined;
  let db: ReturnType<typeof createTestDb> | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    db?.close();
    server = undefined;
    db = undefined;
  });

  it('rejects malformed pagination before the audit query', async () => {
    db = createTestDb();
    const audit = new AuditService(db);
    audit.record({ event_type: 'task.created', action: 'create', resource_type: 'task', resource_id: 'task-1' });
    const app = express();
    app.use('/audit', createAuditRoutes(db, audit));
    app.use(errorHandler);
    server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    for (const path of ['/audit?limit=NaN', '/audit?limit=0', '/audit?limit=1.5', '/audit?offset=-1', '/audit?offset=1.5']) {
      const response = await fetch(`${base}${path}`);
      expect(response.status, path).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }
    const valid = await fetch(`${base}/audit?limit=1&offset=0`);
    expect(valid.status).toBe(200);
    expect((await valid.json()).events).toHaveLength(1);
  });
});
