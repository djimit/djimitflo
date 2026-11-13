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

  it('filters by event type and hides service-account logins on the server, and names the actor', async () => {
    db = createTestDb();
    db.prepare("INSERT INTO users (id, email, password_hash, role) VALUES ('svc', 'djimitsec-service@agentical.invalid', 'x', 'maker'), ('op', 'ops@example.test', 'x', 'admin')").run();
    const audit = new AuditService(db);
    for (let i = 0; i < 3; i++) audit.record({ event_type: 'auth.login' as any, user_id: 'svc', action: 'auth.login', resource_type: 'user', resource_id: 'svc' });
    audit.record({ event_type: 'auth.login' as any, user_id: 'op', action: 'auth.login', resource_type: 'user', resource_id: 'op' });
    audit.record({ event_type: 'policy.updated' as any, user_id: 'op', action: 'approval_policy.updated', resource_type: 'approval_policy', resource_id: 'p1' });
    const app = express();
    app.use('/audit', createAuditRoutes(db, audit));
    app.use(errorHandler);
    server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const policy = await (await fetch(`${base}/audit?event_type=policy.updated`)).json();
    expect(policy.events.map((e: any) => e.event_type)).toEqual(['policy.updated']);
    expect(policy.events[0]).toMatchObject({ actor_email: 'ops@example.test', actor_role: 'admin' });

    const hidden = await (await fetch(`${base}/audit?hide_service_logins=1`)).json();
    expect(hidden.events.map((e: any) => e.user_id).sort()).toEqual(['op', 'op']);
    expect(hidden).toMatchObject({ total: 2, hidden_service_logins: 3 });

    const all = await (await fetch(`${base}/audit`)).json();
    expect(all.total).toBe(5);
    expect(all.hidden_service_logins).toBeUndefined();
  });
});
