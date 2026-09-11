import express from 'express';
import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/test-db';
import { createObservabilityRoutes } from '../routes/observability';

describe('observability SSE stream', () => {
  it('opens a real stream and emits a connected event before disconnect cleanup', async () => {
    const db = createTestDb();
    const auth = {
      requireAuth: (_req: any, _res: any, next: any) => next(),
      requirePermission: () => (_req: any, _res: any, next: any) => next(),
    } as any;
    const app = express().use('/observability', createObservabilityRoutes(db, auth));
    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as import('node:net').AddressInfo).port;
    const controller = new AbortController();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/observability/stream`, { signal: controller.signal });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const reader = response.body!.getReader();
      const first = await reader.read();
      const payload = new TextDecoder().decode(first.value);
      expect(payload).toMatch(/data: \{"type":"connected","timestamp":"/);
      controller.abort();
      reader.releaseLock();
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      db.close();
    }
  });
});
