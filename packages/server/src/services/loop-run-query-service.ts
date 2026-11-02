/**
 * LoopRunQueryService — read-only queries for loop_runs.
 *
 * Centralizes all loop_runs table access to ensure consistent
 * parsing, error handling, and query patterns.
 *
 * Extracted from LoopService to reduce its DB query surface
 * and enable independent testing of query logic.
 */

import type { Database } from 'better-sqlite3';
import type { LoopRunRecord } from './loop-types';

export interface LoopRunFilter {
  status?: string;
  goal_id?: string;
  loop_name?: string;
  limit?: number;
  offset?: number;
}

/** The skill outcome remote-gym-service record() wrote for a gym run (task_id = run id), as stored. */
export interface GymSkillOutcome {
  id: string;
  skill_id: string;
  success: boolean;
  /** null = the runtime reported no usage (unknown, never 0); legacy rows may hold 0, which is also unknown */
  tokens_used: number | null;
  /** record() stores 0 when the worker sent no duration: 0 is unknown */
  duration_ms: number;
  model: string | null;
  skill_content_hash: string | null;
  evidence_refs: string[];
  created_at: string;
}

export class LoopRunQueryService {
  constructor(private db: Database) {}

  /**
   * Get a single loop run by ID.
   * @throws Error if not found
   */
  getById(id: string): LoopRunRecord {
    const row = this.db.prepare('SELECT * FROM loop_runs WHERE id = ?').get(id) as any | undefined;
    if (!row) {
      throw new Error('LOOP_RUN_NOT_FOUND');
    }
    return this.parseRow(row);
  }

  /**
   * List loop runs with optional filtering.
   */
  list(filter: LoopRunFilter = {}): LoopRunRecord[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.status) {
      conditions.push('status = ?');
      params.push(filter.status);
    }
    if (filter.goal_id) {
      conditions.push('goal_id = ?');
      params.push(filter.goal_id);
    }
    if (filter.loop_name) {
      conditions.push('loop_name = ?');
      params.push(filter.loop_name);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filter.limit || 100;
    const offset = filter.offset || 0;

    const rows = this.db.prepare(
      `SELECT * FROM loop_runs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as any[];

    return rows.map(row => this.parseRow(row));
  }

  /**
   * Get all active runs (running, verifying, planning).
   */
  getActive(): LoopRunRecord[] {
    const rows = this.db.prepare(
      `SELECT * FROM loop_runs WHERE status IN ('running', 'verifying', 'planning') ORDER BY created_at ASC`
    ).all() as any[];
    return rows.map(row => this.parseRow(row));
  }

  /**
   * Get all interrupted runs.
   */
  getInterrupted(): LoopRunRecord[] {
    const rows = this.db.prepare(
      `SELECT * FROM loop_runs WHERE status = 'interrupted' ORDER BY created_at ASC`
    ).all() as any[];
    return rows.map(row => this.parseRow(row));
  }

  /**
   * Get runs for a specific goal.
   */
  getByGoalId(goalId: string): LoopRunRecord[] {
    const rows = this.db.prepare(
      `SELECT * FROM loop_runs WHERE goal_id = ? ORDER BY created_at DESC`
    ).all(goalId) as any[];
    return rows.map(row => this.parseRow(row));
  }

  /**
   * Count runs matching a filter.
   */
  count(filter: { status?: string; goal_id?: string } = {}): number {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.status) {
      conditions.push('status = ?');
      params.push(filter.status);
    }
    if (filter.goal_id) {
      conditions.push('goal_id = ?');
      params.push(filter.goal_id);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const row = this.db.prepare(`SELECT COUNT(*) as c FROM loop_runs ${where}`).get(...params) as { c: number };
    return row.c;
  }

  /**
   * Check if a run exists.
   */
  exists(id: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM loop_runs WHERE id = ?').get(id);
    return !!row;
  }

  /**
   * Get the latest run for a loop name.
   */
  getLatestByName(loopName: string): LoopRunRecord | null {
    const row = this.db.prepare(
      `SELECT * FROM loop_runs WHERE loop_name = ? ORDER BY created_at DESC LIMIT 1`
    ).get(loopName) as any | undefined;
    return row ? this.parseRow(row) : null;
  }

  /**
   * Read-only: the gym skill outcome of one run (null when record() wrote none — a discard, VOID, canary or TG-001 attempt —
   * or when the skill_outcomes table does not exist yet).
   * @throws Error('LOOP_RUN_NOT_FOUND') if the run does not exist
   */
  getGymSkillOutcome(runId: string): { run_id: string; skill_outcome: GymSkillOutcome | null } {
    if (!this.exists(runId)) throw new Error('LOOP_RUN_NOT_FOUND');
    let row: any;
    try {
      row = this.db.prepare(`SELECT id, skill_id, success, tokens_used, duration_ms, model, skill_content_hash, evidence_refs_json, created_at
        FROM skill_outcomes WHERE domain = 'gym' AND task_id = ? ORDER BY created_at DESC LIMIT 1`).get(runId);
    } catch {
      return { run_id: runId, skill_outcome: null }; // no skill_outcomes table yet: nothing recorded
    }
    if (!row) return { run_id: runId, skill_outcome: null };
    let refs: unknown = [];
    try { refs = JSON.parse(row.evidence_refs_json || '[]'); } catch { /* unreadable refs: shown as none */ }
    return {
      run_id: runId,
      skill_outcome: {
        id: row.id,
        skill_id: row.skill_id,
        success: row.success === 1,
        tokens_used: typeof row.tokens_used === 'number' ? row.tokens_used : null,
        duration_ms: Number(row.duration_ms) || 0,
        model: row.model ?? null,
        skill_content_hash: row.skill_content_hash ?? null,
        evidence_refs: Array.isArray(refs) ? refs.map(String) : [],
        created_at: row.created_at,
      },
    };
  }

  private parseRow(row: any): LoopRunRecord {
    return {
      id: row.id,
      goal_id: row.goal_id || null,
      loop_name: row.loop_name,
      mode: row.mode,
      status: row.status,
      repository_path: row.repository_path || null,
      state_file: row.state_file || null,
      findings: JSON.parse(row.findings_json || '[]'),
      plan: JSON.parse(row.plan_json || '{}'),
      gates: JSON.parse(row.gates_json || '[]'),
      next_actions: JSON.parse(row.next_actions_json || '[]'),
      metadata: JSON.parse(row.metadata || '{}'),
      created_at: row.created_at,
      updated_at: row.updated_at,
      completed_at: row.completed_at || null,
    };
  }
}
