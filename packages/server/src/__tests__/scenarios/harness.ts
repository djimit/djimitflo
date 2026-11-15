/**
 * Acceptance-scenario harness (controlled-execution audit 2026-11-15, master prompt v1.1, evidence level E3).
 *
 * Builds the server the way src/index.ts does for the HTTP surface — the real route factory `createRoutes` with a real
 * AuthService (bootstrap admin + POST /api/auth/login → JWT), the real ExecutionEngine (in-process MockExecutor) and the
 * real error handler — on an in-memory SQLite with the full schema + migrations. Nothing here sets a business outcome
 * in the database; scenarios drive the product through its own entries and read the projections the dashboard reads.
 *
 * Outbound guard: global fetch is wrapped so any non-loopback request is refused and recorded (`outbound`), so a
 * scenario can prove it made no external or model call from this process.
 */
import express from 'express';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { schema } from '../../database/schema';
import { runMigrations } from '../../database/migrate';
import { createRoutes } from '../../routes';
import { errorHandler } from '../../middleware/error-handler';
import { AuthService } from '../../services/auth-service';
import { createAuthMiddleware } from '../../middleware/auth';
import { ExecutionEngine } from '../../execution/execution-engine';
import { RuntimeGovernanceService } from '../../services/runtime-governance-service';
import { setLlmLedger } from '../../services/model-selector';

export const ADMIN = { email: 'scenario-admin@local.test', password: 'Scenario-Harness-Password-2026!' };

export interface Harness {
  db: Database.Database;
  baseUrl: string;
  token: string;
  engine: ExecutionEngine;
  outbound: string[];
  api: <T = any>(method: string, p: string, body?: unknown) => Promise<{ status: number; body: T }>;
  close: () => Promise<void>;
}

/** Env keys a scenario sets; restored on close. */
export function envSnapshot(keys: string[]): () => void {
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  return () => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
}

export async function startHarness(): Promise<Harness> {
  const restoreEnv = envSnapshot(['AUTH_BOOTSTRAP_ADMIN_EMAIL', 'AUTH_BOOTSTRAP_ADMIN_PASSWORD']);
  process.env.AUTH_BOOTSTRAP_ADMIN_EMAIL = ADMIN.email;
  process.env.AUTH_BOOTSTRAP_ADMIN_PASSWORD = ADMIN.password;

  const outbound: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const host = new URL(url).hostname;
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
      outbound.push(url);
      throw new Error(`SCENARIO_OUTBOUND_REFUSED: ${host}`);
    }
    return realFetch(input, init);
  }) as typeof fetch;

  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  setLlmLedger(db); // index.ts:109 — the one model-call ledger

  const authService = new AuthService(db);
  authService.bootstrapAdmin();
  const auth = createAuthMiddleware(authService);
  const runtimeGovernance = new RuntimeGovernanceService(db);
  const engine = new ExecutionEngine(db, undefined, undefined, runtimeGovernance);

  const app = express();
  app.use(express.json());
  app.use('/api', createRoutes(db, engine, authService, auth, undefined, undefined, false, runtimeGovernance));
  app.use(errorHandler);
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const login = await realFetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ADMIN),
  });
  if (login.status !== 200) throw new Error(`HARNESS_LOGIN_FAILED ${login.status} ${await login.text()}`);
  const { token } = await login.json() as { token: string };

  const api = async <T = any>(method: string, p: string, body?: unknown) => {
    const response = await realFetch(`${baseUrl}/api${p}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* non-JSON body kept as text */ }
    return { status: response.status, body: parsed as T };
  };

  return {
    db, baseUrl, token, engine, outbound, api,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      globalThis.fetch = realFetch;
      setLlmLedger(null);
      restoreEnv();
      // the DB is left open: process-wide listeners (swarmEventBus) built by createRoutes keep its handle until the file ends
    },
  };
}

/** A throwaway git repository whose test/lint/type-check scripts are deterministic (exit 0). */
export function makeFixtureRepo(prefix = 'djimitflo-scenario-repo-', readme = '# scenario fixture\n'): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(repo, 'README.md'), readme);
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({
    name: 'scenario-fixture',
    scripts: { test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"', 'type-check': 'node -e "process.exit(0)"' },
  }, null, 2));
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'scenario@example.invalid'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Scenario Harness'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: repo, stdio: 'ignore' });
  return repo;
}

export async function until<T>(fn: () => T | null | undefined | Promise<T | null | undefined>, timeoutMs: number, intervalMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`until: timed out after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Prints a scenario's observations; with SCENARIO_OBS_DIR set also writes them to <dir>/<name>.json (for scenarios.json). */
export function recordObs(name: string, obs: unknown): void {
  console.log(`[${name}] observations`, JSON.stringify(obs, null, 1));
  const dir = process.env.SCENARIO_OBS_DIR;
  if (dir) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, `${name.replace(/[^A-Za-z0-9_.-]+/g, '_')}.json`), JSON.stringify(obs, null, 1)); }
}
