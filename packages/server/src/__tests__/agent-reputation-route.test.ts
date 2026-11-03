import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { createSwarmOrchestrationRoutes } from '../routes/swarm-orchestration';
import { errorHandler } from '../middleware/error-handler';

let db: Database.Database;
let server: Server;
let baseUrl: string;

const auth = {
  requireAuth: (req: any, _res: any, next: any) => { req.user = { sub: 'test-user', email: 'user@example.test', role: 'approver' }; next(); },
  requirePermission: () => (req: any, _res: any, next: any) => { req.user = { sub: 'test-user', email: 'user@example.test', role: 'approver' }; next(); },
} as any;

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  db.prepare(`
    INSERT INTO agents (id, name, description, status, capabilities, total_tasks, completed_tasks, failed_tasks, metadata, created_at, updated_at)
    VALUES ('a1', 'Agent One', '', 'active', '[]', 4, 4, 0, '{}', datetime('now'), datetime('now'))
  `).run();

  const app = express();
  app.use(express.json());
  app.use('/swarm-v2', createSwarmOrchestrationRoutes(db, auth));
  app.use(errorHandler);
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  db.close();
});

describe('GET /swarm-v2/social/reputation/:agentId', () => {
  it('returns the computed reputation for a known agent', async () => {
    const response = await fetch(`${baseUrl}/swarm-v2/social/reputation/a1`);
    expect(response.status).toBe(200);
    const body = await response.json() as { agent_id: string; score: number; task_completion_rate: number | null };
    expect(body.agent_id).toBe('a1');
    expect(body.task_completion_rate).toBe(1);
    expect(body.score).toBeGreaterThan(0.5);
  });

  it('returns 404 for an unknown agent id', async () => {
    const response = await fetch(`${baseUrl}/swarm-v2/social/reputation/does-not-exist`);
    expect(response.status).toBe(404);
  });
});
