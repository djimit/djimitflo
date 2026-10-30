import express from 'express';
import Database from 'better-sqlite3';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { UserRole } from '@djimitflo/shared';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { AuthService } from '../services/auth-service';
import { createAuthMiddleware } from '../middleware/auth';
import { createExportRoutes } from '../routes/exports';

// S4a: POST /exports/audit requires read:audit at the route boundary, like GET /api/audit (routes/audit.ts).
let db: Database.Database;
let server: Server;
let baseUrl: string;
const tokens: Record<string, string> = {};
const originalSecret = process.env.JWT_SECRET;

beforeAll(async () => {
  process.env.JWT_SECRET = 'e'.repeat(64);
  db = new Database(':memory:');
  db.exec(schema);
  runMigrations(db);
  const authService = new AuthService(db);
  for (const role of [UserRole.ADMIN, UserRole.VIEWER]) {
    authService.createUser(`${role}@example.invalid`, 'Export-test-password-123!', role);
    tokens[role] = authService.authenticate(`${role}@example.invalid`, 'Export-test-password-123!')!.token;
  }
  const app = express().use(express.json()).use('/exports', createExportRoutes(db, createAuthMiddleware(authService)));
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close(); db?.close();
  if (originalSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = originalSecret;
});

const exportAudit = (role: string) => fetch(`${baseUrl}/exports/audit`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[role]}` }, body: '{}',
});

it('a viewer token is refused by the read:audit permission before the export runs', async () => {
  const res = await exportAudit(UserRole.VIEWER);
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } });
});

it('an admin token exports the audit log', async () => {
  const res = await exportAudit(UserRole.ADMIN);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-disposition')).toContain('attachment');
});
