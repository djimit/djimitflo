import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { createWorkItemRoutes } from '../routes/work-items';

let db: Database.Database;
let root: string;
let server: Server | null;
const previousEnv = {
  packets: process.env.NAS_EVIDENCE_PACKETS_PATH,
  audit: process.env.NAS_EVIDENCE_AUDIT_PATH,
  blocked: process.env.NAS_EVIDENCE_BLOCKED_PATH,
};

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-nas-routes-'));
  process.env.NAS_EVIDENCE_PACKETS_PATH = writeJsonl('packets.jsonl', [{
    source_path: 'Documenten/sovereign-platform-roadmap-2025-2030.html',
    title: 'Sovereign platform roadmap 2025-2030',
    domain: 'sovereign-ai',
    claim: 'Sovereign platform roadmap 2025-2030',
    confidence: 0.7,
    valid_until: '2026-12-31',
    risk_flags: [],
  }]);
  process.env.NAS_EVIDENCE_AUDIT_PATH = writeJsonl('audit.jsonl', []);
  process.env.NAS_EVIDENCE_BLOCKED_PATH = writeJsonl('blocked.jsonl', []);
  const app = express();
  app.use(express.json());
  app.use('/work-items', createWorkItemRoutes(db));
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close((err) => err ? reject(err) : resolve()));
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
  if (previousEnv.packets) process.env.NAS_EVIDENCE_PACKETS_PATH = previousEnv.packets;
  else delete process.env.NAS_EVIDENCE_PACKETS_PATH;
  if (previousEnv.audit) process.env.NAS_EVIDENCE_AUDIT_PATH = previousEnv.audit;
  else delete process.env.NAS_EVIDENCE_AUDIT_PATH;
  if (previousEnv.blocked) process.env.NAS_EVIDENCE_BLOCKED_PATH = previousEnv.blocked;
  else delete process.env.NAS_EVIDENCE_BLOCKED_PATH;
});

function writeJsonl(name: string, rows: unknown[]) {
  const file = path.join(root, name);
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  return file;
}

async function request(route: string, init: RequestInit = {}) {
  const address = server!.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${address.port}${route}`, init);
  return { status: response.status, body: await response.json() as any };
}

describe('NAS evidence routes', () => {
  it('mounts summary and import preview before work-item id routes', async () => {
    const summary = await request('/work-items/nas-evidence/summary');
    const preview = await request('/work-items/nas-evidence/import-preview', { method: 'POST' });

    expect(summary.status).toBe(200);
    expect(summary.body).toMatchObject({ status: 'green', approved_packets: 1 });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ dry_run: true, create: 1 });
    expect(db.prepare('SELECT COUNT(*) as count FROM work_items').get()).toMatchObject({ count: 0 });
  });
});
