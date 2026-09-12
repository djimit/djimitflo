// Actual server-crash diagnostic, with a synthetic executor and disposable database.
// Run after npm run build. No external runtime, repository, or production state used.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';

const root = resolve(import.meta.dirname, '../..');
const dir = await mkdtemp(join(tmpdir(), 'djimitflo-task-crash-'));
const portProbe = createServer();
await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
const port = portProbe.address().port;
await new Promise(resolve => portProbe.close(resolve));
const base = `http://127.0.0.1:${port}`;
let child, token;
async function start() {
  child = spawn(process.execPath, ['packages/server/dist/index.js'], {
    cwd: root, stdio: 'ignore', env: {
      PATH: process.env.PATH, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port),
      DB_PATH: join(dir, 'probe.sqlite'), BACKUP_DIR: join(dir, 'backups'),
      DJIMITFLO_RUNTIME_PROFILE: 'api', DJIMITFLO_EXPLAINER_AUTONOMY: 'false',
      JWT_SECRET: 'disposable-crash-probe', AUTH_BOOTSTRAP_ADMIN_EMAIL: 'probe@example.test',
      AUTH_BOOTSTRAP_ADMIN_PASSWORD: 'disposable-crash-probe-only',
    },
  });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('Fixture server exited');
    try { if ((await fetch(`${base}/health`, { signal: AbortSignal.timeout(250) })).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Fixture server startup timed out');
}
async function call(path, body) {
  const response = await fetch(`${base}/api${path}`, {
    method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(5000),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  assert(response.ok, JSON.stringify({ path, status: response.status, result }));
  return result;
}
try {
  await start();
  token = (await call('/auth/login', { email: 'probe@example.test', password: 'disposable-crash-probe-only' })).token;
  const task = await call('/tasks', { title: 'Mock crash recovery fixture', description: 'echo hello', priority: 'low', execution_mode: 'local' });
  const dispatch = await call(`/tasks/${task.id}/execute`, { executor: 'mock' });
  const before = await call(`/tasks/${task.id}`);
  assert.equal(before.status, 'running', JSON.stringify(dispatch));
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  await start();
  const after = await call(`/tasks/${task.id}`);
  if (process.argv.includes('--expect-recovery')) assert.equal(after.status, 'failed', 'Lost in-process mock execution must not remain running');
  console.log(JSON.stringify({
    scope: 'actual server crash and restart, synthetic mock executor only',
    task_id: task.id, before: before.status, after: after.status,
    state: after.status === 'running' ? 'BROKEN' : 'PARTIAL',
    reason: after.status === 'running' ? 'Standalone task remains running without an execution session after server death.' : 'Task state reconciled; real provider orphan handling remains unproven.',
  }, null, 2));
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  }
  await rm(dir, { recursive: true, force: true });
}
