/**
 * LoopWorkerLeaseService
 * Extracted from loop-service.ts (Task 5.2: LoopService decompositie)
 * Constitution v1.1.0 — Architecture decomposition
 */
import type Database from 'better-sqlite3';
import type { LoopRunRecord, WorkerLeaseRecord } from '@djimitflo/shared';

export class LoopWorkerLeaseService {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  getWorkerLeasePublic(id: string): WorkerLeaseRecord {
    return this.getWorkerLease(id);
  }

}
