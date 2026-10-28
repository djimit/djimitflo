/** Fixed, operator-configured security worker. No prompt, shell, caller URL or retry path. */
import { constants, openSync, closeSync, fstatSync, readSync } from 'fs';
import { isAbsolute } from 'path';
import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { ExecutionEventType, LogLevel, type Task, type ExecutionEventCreateInput } from '@djimitflo/shared';
import type { TaskExecutor, ExecutionSession, ExecutionResult, ExecutorKind } from '../types';

export const DJIMITSEC_ADAPTER_VERSION = '1.0.0';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const revision = /^[0-9a-f]{40}$/;
const repository = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const hex = /^[0-9a-f]{64}$/;
interface ScanInput { repositoryId: string; commit: string }
interface WorkerConfig { origin: string; tokenFile: string; repositoryIds: string[]; implementationDigest: string; timeoutMs: number }
interface WorkerReceipt extends ScanInput { taskId: string; investigationId: string | null; bundleDigest: string | null; state: 'collected' | 'UNKNOWN' | 'cancelled' | 'held' | 'running'; verified: false }

export function privateScanText(path: string, maxBytes = 65536): string {
  if (!isAbsolute(path)) throw new Error('DJIMITSEC_PRIVATE_PATH_REQUIRED');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.() || stat.size > maxBytes) throw new Error('DJIMITSEC_PRIVATE_FILE_REQUIRED');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) throw new Error('DJIMITSEC_PRIVATE_FILE_CHANGED'); offset += count; }
    const after = fstatSync(fd);
    if (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'uid', 'mode', 'nlink'].some(key => stat[key as keyof typeof stat] !== after[key as keyof typeof after]) || readSync(fd, Buffer.alloc(1), 0, 1, bytes.length) !== 0) throw new Error('DJIMITSEC_PRIVATE_FILE_CHANGED');
    return bytes.toString('utf8');
  } finally { closeSync(fd); }
}
function mode(): 'off' | 'shadow' | 'execute' {
  const value = process.env.DJIMITSEC_SCAN_MODE || 'off';
  if (!['off', 'shadow', 'execute'].includes(value)) throw new Error('DJIMITSEC_SCAN_MODE_INVALID');
  return value as 'off' | 'shadow' | 'execute';
}
function config(): WorkerConfig {
  const c = JSON.parse(privateScanText(process.env.DJIMITSEC_SCAN_CONFIG || '')) as WorkerConfig;
  if (!c || Object.keys(c).sort().join(',') !== 'implementationDigest,origin,repositoryIds,timeoutMs,tokenFile') throw new Error('DJIMITSEC_CONFIG_INVALID');
  const url = new URL(c.origin);
  if (url.origin !== c.origin || url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('DJIMITSEC_FIXED_ORIGIN_REQUIRED');
  if (!Array.isArray(c.repositoryIds) || !c.repositoryIds.length || c.repositoryIds.some(id => !repository.test(id)) || !hex.test(c.implementationDigest) || !Number.isInteger(c.timeoutMs) || c.timeoutMs < 1000 || c.timeoutMs > 300000) throw new Error('DJIMITSEC_CONFIG_INVALID');
  return c;
}
function input(task: Task, c: WorkerConfig): ScanInput {
  const m = task.metadata || {}, value = m.djimitsecScan as ScanInput;
  if (!uuid.test(task.id) || !value || Object.keys(value).sort().join(',') !== 'commit,repositoryId' || !repository.test(value.repositoryId) || !revision.test(value.commit) || !c.repositoryIds.includes(value.repositoryId)) throw new Error('DJIMITSEC_SCAN_INPUT_DENIED');
  // Generic executor controls have no meaning for this deterministic capability.
  for (const name of ['environment', 'workingDirectory', 'model', 'timeoutMs', 'skipPermissions', 'sandbox', 'reasoningEffort', 'codexSandbox']) if (m[name] !== undefined) throw new Error('DJIMITSEC_CALLER_EXECUTION_OPTIONS_DENIED');
  return { repositoryId: value.repositoryId, commit: value.commit };
}
function receipt(value: unknown, taskId: string, scan: ScanInput): WorkerReceipt {
  const r = value as WorkerReceipt;
  if (!r || Object.keys(r).sort().join(',') !== 'bundleDigest,commit,investigationId,repositoryId,state,taskId,verified' || r.taskId !== taskId || r.repositoryId !== scan.repositoryId || r.commit !== scan.commit || r.verified !== false || !['collected', 'UNKNOWN', 'cancelled', 'held', 'running'].includes(r.state) || (r.investigationId !== null && !uuid.test(r.investigationId)) || (r.bundleDigest !== null && !hex.test(r.bundleDigest)) || (r.state === 'collected' && (!r.investigationId || !r.bundleDigest))) throw new Error('DJIMITSEC_RECEIPT_IDENTITY_INVALID');
  return r;
}
async function request(c: WorkerConfig, path: string, method: 'GET' | 'POST', body?: unknown, signal?: AbortSignal, timeoutMs = c.timeoutMs): Promise<unknown> {
  const token = privateScanText(c.tokenFile, 16384).trim();
  if (!token || /\s/.test(token)) throw new Error('DJIMITSEC_WORKER_TOKEN_INVALID');
  const response = await fetch(new URL(path, c.origin), { method, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`DJIMITSEC_WORKER_HTTP_${response.status}`); }
  const reader = response.body?.getReader(); if (!reader) throw new Error('DJIMITSEC_WORKER_BODY_REQUIRED');
  const chunks: Buffer[] = []; let size = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 65536) throw new Error('DJIMITSEC_WORKER_RESPONSE_LIMIT'); chunks.push(Buffer.from(part.value)); } }
  catch (error) { await reader.cancel(); throw error; }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export class DjimitSecExecutor implements TaskExecutor {
  readonly kind: ExecutorKind = 'djimitsec';
  constructor(private db: Database) {}
  canExecute(task: Task): boolean { try { if (mode() !== 'execute') return false; input(task, config()); return true; } catch { return false; } }
  async prepare(task: Task): Promise<void> {
    if (mode() === 'off') throw new Error('DJIMITSEC_SCAN_DISABLED');
    const c = config(); input(task, c);
    const health = await request(c, '/health', 'GET', undefined, undefined, 5000) as Record<string, unknown>;
    if (health?.service !== 'djimitsec-scanner' || health.version !== DJIMITSEC_ADAPTER_VERSION || health.implementationDigest !== c.implementationDigest || health.ready !== true) throw new Error('DJIMITSEC_WORKER_IDENTITY_UNPROVEN');
    this.db.exec(`CREATE TABLE IF NOT EXISTS runtime_contract_probes (runtime TEXT PRIMARY KEY, command TEXT, status TEXT NOT NULL DEFAULT 'unknown', available INTEGER NOT NULL DEFAULT 0, contract_json TEXT NOT NULL DEFAULT '{}', probed_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO runtime_contract_probes(runtime,command,status,available,contract_json,probed_at,updated_at) VALUES(?,NULL,'ok',?,?,?,?) ON CONFLICT(runtime) DO UPDATE SET command=NULL,status=excluded.status,available=excluded.available,contract_json=excluded.contract_json,probed_at=excluded.probed_at,updated_at=excluded.updated_at`)
      .run(this.kind, mode() === 'execute' ? 1 : 0, JSON.stringify({ version: DJIMITSEC_ADAPTER_VERSION, worker: health, supports_timeout_kill: true, source: 'fixed-worker-http-health', shadow: mode() === 'shadow' }), now, now);
  }
  async start(task: Task): Promise<ExecutionSession> {
    if (!this.canExecute(task)) throw new Error('DJIMITSEC_SCAN_NOT_EXECUTABLE');
    const c = config(), scan = input(task, c), started = Date.now(), controller = new AbortController();
    let cancelled = false, terminal = false, resolveClosed!: () => void;
    let cancellation: Promise<void> | null = null;
    let cancellationReceipt: WorkerReceipt | null = null;
    const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
    const events: ExecutionEventCreateInput[] = []; let done = false, wake: (() => void) | null = null;
    const notify = () => { wake?.(); wake = null; };
    const emit = (event: ExecutionEventCreateInput) => { events.push(event); notify(); };
    const session: ExecutionSession = { id: randomUUID(), taskId: task.id, executorKind: this.kind, status: 'running', startedAt: new Date(started), closed,
      events: (async function* () { while (!done || events.length) { if (!events.length && !done) await new Promise<void>(resolve => { wake = resolve; }); while (events.length) yield events.shift()!; } })(),
      result: Promise.resolve({ status: 'failed', message: 'Not started' }),
      cancel: async () => {
        if (cancellation) { await cancellation; return; }
        if (terminal) return;
        cancellation = (async () => { cancelled = true; controller.abort(); const r = receipt(await request(c, `/runs/${task.id}/cancel`, 'POST', {}, undefined, 5000), task.id, scan); if (!['cancelled', 'collected', 'UNKNOWN'].includes(r.state)) throw new Error('DJIMITSEC_CANCELLATION_UNCONFIRMED'); cancellationReceipt = r; })();
        await cancellation;
      },
    };
    session.result = (async (): Promise<ExecutionResult> => {
      emit({ task_id: task.id, event_type: ExecutionEventType.TOOL_CALL, tool_name: 'djimitsec.scan_repository', tool_input: { taskId: task.id, ...scan }, level: LogLevel.INFO, message: 'Starting fixed approved repository scanner; no security verdict is granted' });
      try {
        let observation: unknown;
        try { observation = await request(c, '/scan', 'POST', { taskId: task.id, ...scan }, controller.signal); }
        catch {
          // POST may have committed. Observe the same durable identity once; never resubmit.
          observation = await request(c, `/runs/${task.id}`, 'GET', undefined, undefined, 5000);
        }
        let r = receipt(observation, task.id, scan);
        if (cancelled && cancellation) await cancellation;
        if (cancellationReceipt) r = cancellationReceipt;
        const status = r.state === 'cancelled' ? 'cancelled' : ['collected', 'UNKNOWN'].includes(r.state) ? 'completed' : 'failed';
        emit({ task_id: task.id, event_type: ExecutionEventType.TOOL_RESULT, tool_name: 'djimitsec.scan_repository', tool_output: r, level: status === 'failed' ? LogLevel.WARNING : LogLevel.INFO, message: `Scanner observation ${r.state}; independently verified=false` });
        return { status, message: `DjimitSec scan ${r.state}; verified=false`, stdout: JSON.stringify(r), ...(status === 'failed' ? { failure: { code: 'DJIMITSEC_SCAN_HELD', message: 'Reconcile the existing worker run; automatic replay is forbidden', retryable: false, sideEffectsPossible: true } } : {}), metrics: { executionTimeMs: Date.now() - started, toolCalls: 1 } };
      } catch {
        return { status: 'failed', message: 'DjimitSec outcome HELD; reconcile existing task identity', failure: { code: 'DJIMITSEC_SCAN_HELD', message: 'Remote execution/cancellation is unconfirmed; no automatic retry or fallback', retryable: false, sideEffectsPossible: true }, metrics: { executionTimeMs: Date.now() - started, toolCalls: 1 } };
      } finally { terminal = true; done = true; notify(); resolveClosed(); session.completedAt = new Date(); }
    })();
    return session;
  }
}
