import express from 'express';
import Database from 'better-sqlite3';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAdvancedRoutes } from '../routes/advanced';

describe('advanced HTTP contracts', () => {
  let server: Server | undefined;
  let db: Database.Database | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    db?.close();
    server = undefined;
    db = undefined;
  });

  it('rejects malformed feedback limits before SQLite access', async () => {
    db = new Database(':memory:');
    const app = express();
    app.use(express.json());
    app.use('/advanced', createAdvancedRoutes(db, { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any));
    server = app.listen(0);
    await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    for (const value of ['NaN', '0', '101', '1.5']) {
      const response = await fetch(`${base}/advanced/feedback/recent?limit=${value}`);
      expect(response.status, value).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }
    const valid = await fetch(`${base}/advanced/feedback/recent?limit=1`);
    expect(valid.status).toBe(200);
    expect((await valid.json()).entries).toEqual([]);
  });

  it('records feedback, exposes an analyzable pattern and applies it', async () => {
    db = new Database(':memory:');
    const app = express();
    app.use(express.json());
    app.use('/advanced', createAdvancedRoutes(db, { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any));
    const server = app.listen(0);
    await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const first = await fetch(`${base}/advanced/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'human_correction', category: 'risk', originalDecision: 'allow', correctedDecision: 'require_approval', reason: 'fixture correction', confidence: 0.9 }) });
      const second = await fetch(`${base}/advanced/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'runtime_violation', category: 'risk', originalDecision: 'allow', correctedDecision: 'require_approval', reason: 'fixture correction', confidence: 0.8 }) });
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect((await (await fetch(`${base}/advanced/feedback/stats`)).json())).toMatchObject({ totalFeedback: 2, pendingFeedback: 2 });
      const analysis = await (await fetch(`${base}/advanced/feedback/analyze`)).json() as any;
      expect(analysis.proposals).toHaveLength(1);
      const applied = await fetch(`${base}/advanced/feedback/apply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pattern: analysis.proposals[0].pattern }) });
      expect(applied.status).toBe(200);
      expect((await (await fetch(`${base}/advanced/feedback/stats`)).json())).toMatchObject({ appliedFeedback: 2, pendingFeedback: 0 });
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('compresses and retrieves context, then persists workflow graph progress', async () => {
    db = new Database(':memory:');
    const app = express();
    app.use(express.json());
    app.use('/advanced', createAdvancedRoutes(db, { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any));
    server = app.listen(0);
    await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const original = Array.from({ length: 30 }, (_, index) => `context sentence ${index}: evidence remains durable.`).join(' ');

    const compressed = await fetch(`${base}/advanced/compression/compress`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: original, type: 'text' }),
    });
    expect(compressed.status).toBe(200);
    const compression = await compressed.json() as any;
    expect(compression).toMatchObject({ original, reversible: true, method: 'text' });
    const retrieved = await fetch(`${base}/advanced/compression/retrieve/${compression.hash}`);
    expect(retrieved.status).toBe(200);
    expect((await retrieved.json()).original).toBe(original);
    expect((await (await fetch(`${base}/advanced/compression/stats`)).json()).cacheSize).toBe(1);

    const created = await fetch(`${base}/advanced/workflows`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'route-fixture', description: 'route proof', nodes: [
        { id: 'start', type: 'start', label: 'Start', status: 'completed' },
        { id: 'task', type: 'task', label: 'Task', status: 'pending' },
      ], edges: [{ id: 'edge', from: 'start', to: 'task', condition: 'success' }] }),
    });
    expect(created.status).toBe(201);
    const workflow = await created.json() as any;
    expect((await (await fetch(`${base}/advanced/workflows/${workflow.id}/next`)).json()).nodes.map((node: any) => node.id)).toEqual(['task']);
    const updated = await fetch(`${base}/advanced/workflows/${workflow.id}/nodes/task/status`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'completed', outputs: { ok: true } }),
    });
    expect(updated.status).toBe(200);
    const invalidApproval = await fetch(`${base}/advanced/workflows/${workflow.id}/nodes/task/approve`, { method: 'POST' });
    expect(invalidApproval.status).toBe(409);
    expect(await invalidApproval.json()).toMatchObject({ error: { code: 'WORKFLOW_GATE_REQUIRED' } });
    const invalidRejection = await fetch(`${base}/advanced/workflows/${workflow.id}/nodes/task/reject`, { method: 'POST' });
    expect(invalidRejection.status).toBe(409);
    expect(await invalidRejection.json()).toMatchObject({ error: { code: 'WORKFLOW_GATE_REQUIRED' } });
    const final = await (await fetch(`${base}/advanced/workflows/${workflow.id}`)).json() as any;
    expect(final.status).toBe('completed');
    expect(final.nodes.find((node: any) => node.id === 'task')).toMatchObject({ status: 'completed', outputs: { ok: true } });

    const gateWorkflow = await fetch(`${base}/advanced/workflows`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'gate-approve', description: 'approval proof', nodes: [
        { id: 'start', type: 'start', label: 'Start', status: 'completed' },
        { id: 'gate', type: 'gate', label: 'Gate', status: 'pending', requiresApproval: true },
      ], edges: [{ id: 'approve-edge', from: 'start', to: 'gate', condition: 'approved' }] }),
    });
    expect(gateWorkflow.status).toBe(201);
    const gate = await gateWorkflow.json() as any;
    const approved = await fetch(`${base}/advanced/workflows/${gate.id}/nodes/gate/approve`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approvedBy: 'operator' }),
    });
    expect(approved.status).toBe(200);
    expect((await (await fetch(`${base}/advanced/workflows/${gate.id}`)).json()).nodes.find((node: any) => node.id === 'gate')).toMatchObject({ status: 'completed', approvedBy: 'operator' });

    const rejectedWorkflow = await fetch(`${base}/advanced/workflows`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'gate-reject', description: 'rejection proof', nodes: [
        { id: 'start', type: 'start', label: 'Start', status: 'completed' },
        { id: 'gate', type: 'gate', label: 'Gate', status: 'pending', requiresApproval: true },
      ], edges: [{ id: 'reject-edge', from: 'start', to: 'gate', condition: 'approved' }] }),
    });
    expect(rejectedWorkflow.status).toBe(201);
    const rejected = await rejectedWorkflow.json() as any;
    const rejection = await fetch(`${base}/advanced/workflows/${rejected.id}/nodes/gate/reject`, { method: 'POST' });
    expect(rejection.status).toBe(200);
    expect((await (await fetch(`${base}/advanced/workflows/${rejected.id}`)).json()).nodes.find((node: any) => node.id === 'gate')).toMatchObject({ status: 'failed' });
  });
});
