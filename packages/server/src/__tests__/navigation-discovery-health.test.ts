import { afterEach, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import Database from 'better-sqlite3';
import { createHealthRoutes } from '../routes/health';
import { EVOLUTION_FLAGS } from '../services/evolution-evidence';

let server: Server | undefined;
let db: Database.Database | undefined;
afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined; db?.close(); db = undefined; vi.unstubAllEnvs();
});
it.each([undefined, 'off', 'shadow', 'on', 'private-unrecognized-value'])('public health safely reports UI mode %s', async mode => {
  vi.stubEnv('UX_NAVIGATION_DISCOVERY_MODE', mode);
  db = new Database(':memory:');
  const app = express(); app.use('/api/health', createHealthRoutes(db));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server!.once('listening', resolve));
  const address = server.address() as { port: number };
  const response = await fetch(`http://127.0.0.1:${address.port}/api/health`);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.ui).toEqual({ navigation_discovery_mode: mode === 'on' || mode === 'shadow' ? mode : 'off' });
  expect(JSON.stringify(body)).not.toContain('private-unrecognized-value');
});
it('registers the operator rollout in existing evolution flags', () => {
  expect(EVOLUTION_FLAGS).toContainEqual({ name: 'UX_NAVIGATION_DISCOVERY_MODE', acting: false });
});
