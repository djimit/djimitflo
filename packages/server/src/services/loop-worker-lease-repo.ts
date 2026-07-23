/**
 * WorkerLeaseRepo — CRUD operations for worker_leases table.
 *
 * Centralizes all worker lease persistence logic including:
 * - Insert, update, patch operations
 * - Query by ID, loop run ID, status
 * - Nested-spawn lineage tracking
 *
 * Extracted from LoopService to reduce its DB query surface.
 */

import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import type { WorkerLeaseRecord, WorkerRole } from './loop-types';

export interface InsertLeaseInput {
  id: string;
  loopRunId: string;
  role: WorkerRole;
  runtime: string;
  findingId: string;
  worktreePath: string | null;
  branchName: string | null;
  metadata: Record<string, unknown>;
  now: string;
  parentLeaseId?: string | null;
  spawnTreeId?: string | null;
  depth?: number;
  spawnedByAgentId?: string | null;
}

export interface LeaseFilter {
  loop_run_id?: string;
  status?: string;
  role?: string;
  finding_id?: string;
  limit?: number;
  offset?: number;
}

export class WorkerLeaseRepo {
  constructor(private db: Database) {}

  /**
   * Insert a new worker lease.
   */
  insert(input: InsertLeaseInput): void {
    this.db.prepare(`
      INSERT INTO worker_leases (
        id, loop_run_id, role, runtime, status, finding_id, worktree_path,
        branch_name, budget_json, metadata, created_at, updated_at,
        parent_lease_id, spawn_tree_id, depth, spawned_by_agent_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.loopRunId,
      input.role,
      input.runtime,
      'prepared',
      input.findingId,
      input.worktreePath,
      input.branchName,
      JSON.stringify({ max_runtime_minutes: 30, max_retries: 1 }),
      JSON.stringify(input.metadata),
      input.now,
      input.now,
      input.parentLeaseId ?? null,
      input.spawnTreeId ?? null,
      input.depth ?? 0,
      input.spawnedByAgentId ?? null,
    );
  }

  /**
   * Update lease status with metadata merge.
   */
  updateStatus(id: string, status: WorkerLeaseRecord['status'], metadataPatch: Record<string, unknown> = {}): void {
    const existing = this.db.prepare('SELECT metadata FROM worker_leases WHERE id = ?').get(id) as { metadata?: string } | undefined;
    const metadata = {
      ...(existing ? JSON.parse(existing.metadata || '{}') : {}),
      ...metadataPatch,
    };
    this.db.prepare('UPDATE worker_leases SET status = ?, metadata = ?, updated_at = ? WHERE id = ?')
      .run(status, JSON.stringify(metadata), new Date().toISOString(), id);
  }

  /**
   * Update lease runtime.
   */
  updateRuntime(id: string, runtime: string): void {
    this.db.prepare('UPDATE worker_leases SET runtime = ?, updated_at = ? WHERE id = ?')
      .run(runtime, new Date().toISOString(), id);
  }

  /**
   * Patch lease metadata (merge with existing).
   */
  patchMetadata(id: string, metadataPatch: Record<string, unknown>): void {
    const existing = this.db.prepare('SELECT status, metadata FROM worker_leases WHERE id = ?').get(id) as { status?: WorkerLeaseRecord['status']; metadata?: string } | undefined;
    if (!existing?.status) {
      throw new Error('MAKER_LEASE_NOT_FOUND');
    }
    const metadata = {
      ...JSON.parse(existing.metadata || '{}'),
      ...metadataPatch,
    };
    this.db.prepare('UPDATE worker_leases SET metadata = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(metadata), new Date().toISOString(), id);
  }

  /**
   * Get a single lease by ID.
   * @throws Error if not found
   */
  getById(id: string): WorkerLeaseRecord {
    const row = this.db.prepare('SELECT * FROM worker_leases WHERE id = ?').get(id) as any | undefined;
    if (!row) {
      throw new Error('MAKER_LEASE_NOT_FOUND');
    }
    return this.parseRow(row);
  }

  /**
   * List leases for a loop run.
   */
  listByLoopRun(loopRunId: string): WorkerLeaseRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM worker_leases WHERE loop_run_id = ? ORDER BY created_at ASC'
    ).all(loopRunId) as any[];
    return rows.map(row => this.parseRow(row));
  }

  /**
   * Query leases with filters.
   */
  query(filter: LeaseFilter = {}): WorkerLeaseRecord[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.loop_run_id) {
      conditions.push('loop_run_id = ?');
      params.push(filter.loop_run_id);
    }
    if (filter.status) {
      conditions.push('status = ?');
      params.push(filter.status);
    }
    if (filter.role) {
      conditions.push('role = ?');
      params.push(filter.role);
    }
    if (filter.finding_id) {
      conditions.push('finding_id = ?');
      params.push(filter.finding_id);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filter.limit || 100;
    const offset = filter.offset || 0;

    const rows = this.db.prepare(
      `SELECT * FROM worker_leases ${where} ORDER BY created_at ASC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as any[];

    return rows.map(row => this.parseRow(row));
  }

  /**
   * Get running leases.
   */
  getRunning(): WorkerLeaseRecord[] {
    const rows = this.db.prepare(
      `SELECT * FROM worker_leases WHERE status = 'running' ORDER BY created_at ASC`
    ).all() as any[];
    return rows.map(row => this.parseRow(row));
  }

  /**
   * Get distinct loop run IDs for a set of lease IDs.
   */
  getLoopRunIdsForLeases(leaseIds: string[]): Set<string> {
    if (leaseIds.length === 0) return new Set();
    const placeholders = leaseIds.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT DISTINCT loop_run_id FROM worker_leases WHERE id IN (${placeholders})`
    ).all(...leaseIds) as Array<{ loop_run_id: string }>;
    return new Set(rows.map(r => r.loop_run_id));
  }

  /**
   * Get finding IDs and statuses for a loop run.
   */
  getFindingStatuses(loopRunId: string): Array<{ finding_id: string | null; status: string }> {
    return this.db.prepare(
      'SELECT finding_id, status FROM worker_leases WHERE loop_run_id = ?'
    ).all(loopRunId) as Array<{ finding_id: string | null; status: string }>;
  }

  /**
   * Count leases matching a filter.
   */
  count(filter: { loop_run_id?: string; status?: string; role?: string } = {}): number {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.loop_run_id) {
      conditions.push('loop_run_id = ?');
      params.push(filter.loop_run_id);
    }
    if (filter.status) {
      conditions.push('status = ?');
      params.push(filter.status);
    }
    if (filter.role) {
      conditions.push('role = ?');
      params.push(filter.role);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const row = this.db.prepare(`SELECT COUNT(*) as c FROM worker_leases ${where}`).get(...params) as { c: number };
    return row.c;
  }

  /**
   * Check if a lease is cancelled or stopped.
   */
  isCancelled(leaseId: string): boolean {
    const lease = this.getById(leaseId);
    const stopped = lease.metadata.stop_requested_at;
    const wasStopped = lease.metadata.stopped_by_runner || lease.metadata.runtime_was_cancelled;
    return Boolean(stopped || wasStopped || lease.status === 'cancelled');
  }

  /**
   * Delete leases for a loop run.
   */
  deleteByLoopRun(loopRunId: string): number {
    const result = this.db.prepare('DELETE FROM worker_leases WHERE loop_run_id = ?').run(loopRunId);
    return result.changes;
  }

  /**
   * Generate a new lease ID.
   */
  static generateId(): string {
    return `lease-${randomUUID().slice(0, 8)}`;
  }

  private parseRow(row: any): WorkerLeaseRecord {
    return {
      id: row.id,
      loop_run_id: row.loop_run_id,
      role: row.role,
      runtime: row.runtime,
      status: row.status,
      finding_id: row.finding_id || null,
      worktree_path: row.worktree_path || null,
      branch_name: row.branch_name || null,
      budget: JSON.parse(row.budget_json || '{}'),
      metadata: JSON.parse(row.metadata || '{}'),
      created_at: row.created_at,
      updated_at: row.updated_at,
      parent_lease_id: row.parent_lease_id ?? null,
      spawn_tree_id: row.spawn_tree_id ?? null,
      depth: typeof row.depth === 'number' ? row.depth : Number(row.depth ?? 0),
      spawned_by_agent_id: row.spawned_by_agent_id ?? null,
    };
  }
}
