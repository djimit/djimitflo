import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { createSwarmRoutes } from '../routes/swarms';
import { errorHandler } from '../middleware/error-handler';

const auth = {
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
} as any;

let db: Database.Database;
let server: Server;
let baseUrl: string;
let previousCodexPath: string | undefined;
let runtimeBinDir = '';

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/swarms', createSwarmRoutes(db, auth));
  app.use(errorHandler);
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
}

describe('production runtime readiness', () => {
  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    previousCodexPath = process.env.CODEX_BIN_PATH;
    await startApp();
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    db.close();
    if (previousCodexPath) {
      process.env.CODEX_BIN_PATH = previousCodexPath;
    } else {
      delete process.env.CODEX_BIN_PATH;
    }
    if (runtimeBinDir) {
      fs.rmSync(runtimeBinDir, { recursive: true, force: true });
      runtimeBinDir = '';
    }
  });

  function fakeCodexBin(): string {
    runtimeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-readiness-runtime-'));
    const file = path.join(runtimeBinDir, 'codex');
    fs.writeFileSync(file, `#!/usr/bin/env sh
if [ "$1" = "--version" ]; then
  echo "codex fake-runtime 1.0.0"
  exit 0
fi
if [ "$1" = "exec" ] && [ "$2" = "--help" ]; then
  echo "Usage: codex exec --json --cd <worktree> <prompt>"
  exit 0
fi
exit 0
`);
    fs.chmodSync(file, 0o755);
    return file;
  }

  it('rejects mock as a production runtime without starting workers', async () => {
    const response = await fetch(`${baseUrl}/swarms/runtime-readiness?runtime=mock`);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.starts_workers).toBe(false);
    expect(body.runtimes[0]).toMatchObject({
      runtime: 'mock',
      production_runtime: false,
      ready: false,
      start_allowed: false,
    });
    expect(body.runtimes[0].blocked_reasons).toContain('non_mock_supported_runtime_required');
    expect((db.prepare('SELECT COUNT(*) as count FROM worker_leases').get() as any).count).toBe(0);
  });

  it('reports unavailable real runtime with blocked reasons and starts no workers', async () => {
    process.env.CODEX_BIN_PATH = '/definitely/missing/codex';
    const response = await fetch(`${baseUrl}/swarms/runtime-readiness?runtime=codex`);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.starts_workers).toBe(false);
    expect(body.runtimes[0]).toMatchObject({
      runtime: 'codex',
      production_runtime: true,
      ready: false,
      start_allowed: false,
      available: false,
    });
    expect(body.runtimes[0].blocked_reasons).toEqual(expect.arrayContaining(['runtime_unavailable']));
    expect((db.prepare('SELECT COUNT(*) as count FROM worker_leases').get() as any).count).toBe(0);
  });

  it('reports an available real runtime without starting workers', async () => {
    process.env.CODEX_BIN_PATH = fakeCodexBin();
    const response = await fetch(`${baseUrl}/swarms/runtime-readiness?runtime=codex`);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.starts_workers).toBe(false);
    expect(body.ready).toBe(true);
    expect(body.runtimes[0]).toMatchObject({
      runtime: 'codex',
      production_runtime: true,
      ready: true,
      start_allowed: true,
      available: true,
      status: 'ok',
    });
    expect(body.runtimes[0].blocked_reasons).toEqual([]);
    expect(body.runtimes[0].version).toContain('fake-runtime');
    expect((db.prepare('SELECT COUNT(*) as count FROM worker_leases').get() as any).count).toBe(0);
  });
});
