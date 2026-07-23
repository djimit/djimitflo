/**
 * End-to-end smoke: boots the REAL server (src/index.ts) as a subprocess on a
 * temp database and drives the whole vertical over the wire — login, WebSocket
 * handshake, task creation, mock-executor execution (through the approval
 * gate if policy requires it), completion, and event persistence.
 *
 * One test that fails if the platform's spine breaks.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import WebSocket from 'ws';

const PORT = 3400 + (process.pid % 500);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { email: 'e2e@local.test', password: 'E2e-Smoke-Password-2026!' };

let server: ChildProcess | null = null;
let dataDir: string;

async function until<T>(fn: () => Promise<T | null>, timeoutMs: number, intervalMs = 500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn().catch(() => null);
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function api<T>(token: string, path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const response = await fetch(`${BASE}/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...init?.headers },
  });
  return { status: response.status, body: await response.json().catch(() => ({})) as T };
}

describe('e2e smoke: login → task → mock execution → completion', () => {
  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'djimitflo-e2e-'));
    server = spawn('npx', ['tsx', 'src/index.ts'], {
      cwd: join(__dirname, '..', '..'),
      env: {
        ...process.env,
        PORT: String(PORT),
        HOST: '127.0.0.1',
        DB_PATH: join(dataDir, 'e2e.sqlite'),
        AUTH_BOOTSTRAP_ADMIN_EMAIL: ADMIN.email,
        AUTH_BOOTSTRAP_ADMIN_PASSWORD: ADMIN.password,
        NODE_ENV: 'test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await until(async () => {
      const response = await fetch(`${BASE}/health`);
      return response.ok ? true : null;
    }, 60_000);
  }, 90_000);

  afterAll(() => {
    server?.kill('SIGTERM');
    setTimeout(() => server?.kill('SIGKILL'), 3000).unref();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('drives the full vertical over HTTP and WebSocket', async () => {
    // 1. Login with the bootstrap admin
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ADMIN),
    });
    expect(login.status).toBe(200);
    const { token } = await login.json() as { token: string };
    expect(token).toBeTruthy();

    // 2. Authenticated WebSocket handshake streams the health frame
    const wsFrames: string[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${token}`);
    await new Promise<void>((resolve, reject) => {
      ws.on('message', (data) => { wsFrames.push(String(data)); resolve(); });
      ws.on('error', reject);
      ws.on('close', (code) => reject(new Error(`WS closed: ${code}`)));
      setTimeout(() => reject(new Error('WS handshake timeout')), 10_000);
    });
    expect(wsFrames.length).toBeGreaterThan(0);

    // 3. Create a low-risk task
    const created = await api<{ id: string }>(token, '/tasks', {
      method: 'POST',
      body: JSON.stringify({
        title: 'e2e smoke task',
        description: 'echo hello from the smoke test',
        risk_level: 'low',
        execution_mode: 'local',
      }),
    });
    expect([200, 201]).toContain(created.status);
    const taskId = created.body.id;
    expect(taskId).toBeTruthy();

    // 4. Execute on the mock executor; approve if policy gates it
    const executed = await api<{ status: string }>(token, `/tasks/${taskId}/execute`, {
      method: 'POST',
      body: JSON.stringify({ executor: 'mock' }),
    });
    expect(executed.status).toBe(200);

    if (executed.body.status === 'awaiting_approval') {
      const approvals = await api<{ approvals: Array<{ id: string }> }>(token, `/tasks/${taskId}/approvals`, {});
      for (const approval of approvals.body.approvals ?? []) {
        await api(token, `/approvals/${approval.id}/approve`, {
          method: 'POST',
          body: JSON.stringify({ reason: 'e2e smoke' }),
        });
      }
    }

    // 5. The task reaches completed
    const finalStatus = await until(async () => {
      const task = await api<{ status: string }>(token, `/tasks/${taskId}`, {});
      return task.body.status === 'completed' ? task.body.status : null;
    }, 60_000, 1000);
    expect(finalStatus).toBe('completed');

    // 6. Execution events were persisted
    const events = await api<{ events: unknown[] }>(token, `/tasks/${taskId}/events`, {});
    expect(events.status).toBe(200);
    expect((events.body.events ?? []).length).toBeGreaterThan(0);

    ws.close();
  }, 120_000);
});
