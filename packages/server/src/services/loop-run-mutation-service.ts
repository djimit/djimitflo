/**
 * LoopRunMutationService — write operations for loop_runs table.
 *
 * Centralizes all loop_runs INSERT and UPDATE operations.
 * Read operations are handled by LoopRunQueryService.
 *
 * Extracted from LoopService to separate read/write concerns.
 */

import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import type { LoopRunRecord, LoopFinding, LoopGate, LoopName } from './loop-types';

export interface CreateLoopRunInput {
  goalId?: string | null;
  loopName: LoopName;
  mode: 'closed' | 'open';
  repositoryPath?: string | null;
  stateFile?: string | null;
  findings?: LoopFinding[];
  plan?: Record<string, unknown>;
  gates?: LoopGate[];
  nextActions?: string[];
  metadata?: Record<string, unknown>;
}

export class LoopRunMutationService {
  constructor(private db: Database) {}

  /**
   * Create a new loop run.
   */
  create(input: CreateLoopRunInput): string {
    const id = `run-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO loop_runs (
        id, goal_id, loop_name, mode, status, repository_path, state_file,
        findings_json, plan_json, gates_json, next_actions_json, metadata,
        created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.goalId || null,
      input.loopName,
      input.mode,
      'created',
      input.repositoryPath || null,
      input.stateFile || null,
      JSON.stringify(input.findings || []),
      JSON.stringify(input.plan || {}),
      JSON.stringify(input.gates || []),
      JSON.stringify(input.nextActions || []),
      JSON.stringify(input.metadata || {}),
      now,
      now,
      null,
    );

    return id;
  }

  /**
   * Update loop run status.
   */
  updateStatus(id: string, status: LoopRunRecord['status'], metadataPatch: Record<string, unknown> = {}): void {
    const existing = this.db.prepare('SELECT metadata FROM loop_runs WHERE id = ?').get(id) as { metadata?: string } | undefined;
    const metadata = {
      ...(existing ? JSON.parse(existing.metadata || '{}') : {}),
      ...metadataPatch,
    };
    this.db.prepare(
      'UPDATE loop_runs SET status = ?, metadata = ?, updated_at = ? WHERE id = ?'
    ).run(status, JSON.stringify(metadata), new Date().toISOString(), id);
  }

  /**
   * Mark a loop run as completed.
   */
  markCompleted(id: string, metadataPatch: Record<string, unknown> = {}): void {
    const existing = this.db.prepare('SELECT metadata FROM loop_runs WHERE id = ?').get(id) as { metadata?: string } | undefined;
    const metadata = {
      ...(existing ? JSON.parse(existing.metadata || '{}') : {}),
      ...metadataPatch,
    };
    const now = new Date().toISOString();
    this.db.prepare(
      'UPDATE loop_runs SET status = ?, metadata = ?, updated_at = ?, completed_at = ? WHERE id = ?'
    ).run('completed', JSON.stringify(metadata), now, now, id);
  }

  /**
   * Mark a loop run as interrupted.
   */
  markInterrupted(id: string, reason: string): void {
    const metadata = { interrupted_reason: reason, interrupted_at: new Date().toISOString() };
    this.db.prepare(
      'UPDATE loop_runs SET status = ?, metadata = ?, updated_at = ? WHERE id = ?'
    ).run('interrupted', JSON.stringify(metadata), new Date().toISOString(), id);
  }

  /**
   * Mark a loop run as failed.
   */
  markFailed(id: string, reason: string): void {
    const metadata = { failed_reason: reason, failed_at: new Date().toISOString() };
    this.db.prepare(
      'UPDATE loop_runs SET status = ?, metadata = ?, updated_at = ? WHERE id = ?'
    ).run('failed', JSON.stringify(metadata), new Date().toISOString(), id);
  }

  /**
   * Update loop run findings.
   */
  updateFindings(id: string, findings: LoopFinding[]): void {
    this.db.prepare(
      'UPDATE loop_runs SET findings_json = ?, updated_at = ? WHERE id = ?'
    ).run(JSON.stringify(findings), new Date().toISOString(), id);
  }

  /**
   * Update loop run gates.
   */
  updateGates(id: string, gates: LoopGate[]): void {
    this.db.prepare(
      'UPDATE loop_runs SET gates_json = ?, updated_at = ? WHERE id = ?'
    ).run(JSON.stringify(gates), new Date().toISOString(), id);
  }

  /**
   * Update loop run metadata (merge).
   */
  patchMetadata(id: string, metadataPatch: Record<string, unknown>): void {
    const existing = this.db.prepare('SELECT metadata FROM loop_runs WHERE id = ?').get(id) as { metadata?: string } | undefined;
    const metadata = {
      ...(existing ? JSON.parse(existing.metadata || '{}') : {}),
      ...metadataPatch,
    };
    this.db.prepare(
      'UPDATE loop_runs SET metadata = ?, updated_at = ? WHERE id = ?'
    ).run(JSON.stringify(metadata), new Date().toISOString(), id);
  }

  /**
   * Get findings JSON for a loop run.
   */
  getFindingsJson(id: string): string {
    const row = this.db.prepare('SELECT findings_json FROM loop_runs WHERE id = ?').get(id) as { findings_json: string } | undefined;
    return row?.findings_json || '[]';
  }

  /**
   * Get metadata JSON for a loop run.
   */
  getMetadataJson(id: string): string {
    const row = this.db.prepare('SELECT metadata FROM loop_runs WHERE id = ?').get(id) as { metadata: string } | undefined;
    return row?.metadata || '{}';
  }

  /**
   * Delete a loop run.
   */
  delete(id: string): number {
    const result = this.db.prepare('DELETE FROM loop_runs WHERE id = ?').run(id);
    return result.changes;
  }
}
