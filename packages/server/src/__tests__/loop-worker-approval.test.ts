import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from './helpers/test-db';
import { LoopWorkerExecutorService } from '../services/loop-worker-executor-service';

let db: Database.Database;
beforeEach(() => { db = createTestDb(); });
afterEach(() => db.close());

describe('LoopWorkerExecutorService approval resumption', () => {
  it('keeps repeated execution attempts prepared while approval is pending', async () => {
    db.prepare(`INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode)
      VALUES ('task-1', 'Worker', '', 'awaiting_approval', 'low', 'low', 'local')`).run();
    db.prepare(`INSERT INTO approvals
      (id, task_id, status, risk_level, request_type, request_message, request_data)
      VALUES ('approval-1', 'task-1', 'pending', 'low', 'high_risk_action', 'approve', '{}')`).run();
    const updateWorkerLeaseStatus = vi.fn();
    const service = new LoopWorkerExecutorService(db, { updateWorkerLeaseStatus } as any);

    await expect((service as any).executeViaEngine(
      { id: 'run-1' },
      { id: 'lease-1', metadata: { execution_task_id: 'task-1' } },
      'opencode', 'prompt', '/tmp', 1_000, false,
    )).rejects.toThrow('LOOP_WORKER_APPROVAL_REQUIRED');

    expect(updateWorkerLeaseStatus).toHaveBeenCalledWith('lease-1', 'prepared', {
      execution_task_id: 'task-1', approval_id: 'approval-1',
    });
  });
});
