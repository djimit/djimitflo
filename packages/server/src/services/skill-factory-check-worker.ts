import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import Database from 'better-sqlite3';
import type { LoopService } from './loop-service';

export type FactoryCheckRequest = { database: string; runId: string; leaseId: string; timeoutMs?: number };
export type FactoryCheckResult = Pick<ReturnType<LoopService['runDeterministicChecks']>, 'checks'>;
let active = false;

/** Run the existing synchronous checker off the API thread. No queue or alternate verification semantics. */
export function runFactoryChecks(request: FactoryCheckRequest): Promise<FactoryCheckResult> {
  if (!request.database || request.database === ':memory:') return Promise.reject(new Error('SKILL_FACTORY_PERSISTED_DATABASE_REQUIRED'));
  if (active) return Promise.reject(new Error('SKILL_FACTORY_CHECK_WORKER_BUSY'));
  active = true;
  return new Promise((resolve, reject) => {
    let result: FactoryCheckResult | undefined;
    let failure: Error | undefined;
    let worker: Worker;
    try {
      worker = new Worker(__filename, { workerData: { kind: 'skill-factory-check', ...request }, execArgv: __filename.endsWith('.ts') ? ['--require', require.resolve('tsx/cjs')] : [] });
    } catch (error) {
      active = false;
      reject(error);
      return;
    }
    worker.once('message', (message: { result?: FactoryCheckResult; error?: string }) => {
      if (message.error) failure = new Error(message.error);
      else result = message.result;
    });
    worker.once('error', error => { failure = error instanceof Error ? error : new Error('SKILL_FACTORY_CHECK_WORKER_FAILED'); });
    // Keep the slot until the actual worker exits, including after errors.
    worker.once('exit', code => {
      active = false;
      if (failure || code !== 0 || !result) reject(failure ?? new Error('SKILL_FACTORY_CHECK_WORKER_FAILED'));
      else resolve(result);
    });
  });
}

if (!isMainThread && workerData?.kind === 'skill-factory-check') {
  const request = workerData as FactoryCheckRequest;
  let db: Database.Database | undefined;
  let checking = false;
  try {
    db = new Database(request.database, { fileMustExist: true, timeout: 5000 });
    const { LoopService: ExistingLoopService } = require('./loop-service') as typeof import('./loop-service');
    const loops = new ExistingLoopService(db);
    checking = true;
    const result = loops.runDeterministicChecks(request.runId, {
      lease_id: request.leaseId, timeout_ms: request.timeoutMs,
      scripts: ['test', 'lint', 'type-check', 'test:skill-package'],
    });
    parentPort!.postMessage({ result: { checks: result.checks } });
  } catch {
    parentPort!.postMessage({ error: checking ? 'SKILL_FACTORY_CHECKS_FAILED' : 'SKILL_FACTORY_CHECK_WORKER_FAILED' });
  } finally {
    db?.close();
    parentPort!.close();
  }
}
