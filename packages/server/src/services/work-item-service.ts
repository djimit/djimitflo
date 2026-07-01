import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

export type RiskClass = 'low' | 'medium' | 'high' | 'critical';
export type WorkItemStatus = 'candidate' | 'triaged' | 'planned' | 'leased' | 'blocked' | 'done' | 'discarded';

export interface WorkItemRecord {
  id: string;
  title: string;
  description: string;
  source: string;
  source_ref: string | null;
  risk_class: RiskClass;
  value_score: number;
  confidence: number;
  status: WorkItemStatus;
  recommended_loop: string | null;
  assigned_agent_id: string | null;
  assigned_runtime: string | null;
  parent_goal_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface WorkItemCreateInput {
  title: string;
  description: string;
  source?: string;
  source_ref?: string | null;
  risk_class?: RiskClass;
  value_score?: number;
  confidence?: number;
  status?: WorkItemStatus;
  recommended_loop?: string | null;
  assigned_agent_id?: string | null;
  assigned_runtime?: string | null;
  parent_goal_id?: string | null;
  metadata?: Record<string, unknown>;
}

export interface WorkItemUpdateInput {
  title?: string;
  description?: string;
  risk_class?: RiskClass;
  value_score?: number;
  confidence?: number;
  status?: WorkItemStatus;
  recommended_loop?: string | null;
  assigned_agent_id?: string | null;
  assigned_runtime?: string | null;
  parent_goal_id?: string | null;
  metadata?: Record<string, unknown>;
}

const VALID_RISKS: RiskClass[] = ['low', 'medium', 'high', 'critical'];
const VALID_STATUSES: WorkItemStatus[] = ['candidate', 'triaged', 'planned', 'leased', 'blocked', 'done', 'discarded'];

export class WorkItemService {
  constructor(private db: Database) {}

  create(input: WorkItemCreateInput): WorkItemRecord {
    this.validateCreate(input);
    const now = new Date().toISOString();
    const id = randomUUID();
    const riskClass = input.risk_class || 'low';
    const valueScore = this.normalizedInteger(input.value_score, 50, 0, 100);
    const confidence = this.normalizedNumber(input.confidence, 0.5, 0, 1);
    const status = input.status || 'candidate';

    this.db.prepare(`
      INSERT INTO work_items (
        id, title, description, source, source_ref, risk_class, value_score,
        confidence, status, recommended_loop, assigned_agent_id, assigned_runtime,
        parent_goal_id, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.title.trim(),
      input.description.trim(),
      (input.source || 'manual').trim(),
      input.source_ref || null,
      riskClass,
      valueScore,
      confidence,
      status,
      input.recommended_loop || null,
      input.assigned_agent_id || null,
      input.assigned_runtime || null,
      input.parent_goal_id || null,
      JSON.stringify(input.metadata || {}),
      now,
      now
    );

    return this.get(id);
  }

  createIfMissingBySourceRef(input: WorkItemCreateInput): { work_item: WorkItemRecord; created: boolean } {
    if (input.source && input.source_ref) {
      const existing = this.db.prepare('SELECT * FROM work_items WHERE source = ? AND source_ref = ?').get(input.source, input.source_ref);
      if (existing) {
        return { work_item: this.parse(existing), created: false };
      }
    }
    return { work_item: this.create(input), created: true };
  }

  upsertBySourceRef(input: WorkItemCreateInput): { work_item: WorkItemRecord; created: boolean } {
    if (!input.source || !input.source_ref) {
      return { work_item: this.create(input), created: true };
    }
    const existing = this.db.prepare('SELECT * FROM work_items WHERE source = ? AND source_ref = ?').get(input.source, input.source_ref);
    if (!existing) {
      return { work_item: this.create(input), created: true };
    }
    return {
      work_item: this.update(this.parse(existing).id, {
        title: input.title,
        description: input.description,
        risk_class: input.risk_class,
        value_score: input.value_score,
        confidence: input.confidence,
        status: input.status,
        recommended_loop: input.recommended_loop,
        assigned_agent_id: input.assigned_agent_id,
        assigned_runtime: input.assigned_runtime,
        parent_goal_id: input.parent_goal_id,
        metadata: input.metadata,
      }),
      created: false,
    };
  }

  list(filter: { status?: string; limit?: number } = {}): WorkItemRecord[] {
    const limit = Math.max(1, Math.min(Number(filter.limit || 100), 500));
    if (filter.status) {
      if (!VALID_STATUSES.includes(filter.status as WorkItemStatus)) {
        throw new Error('WORK_ITEM_STATUS_INVALID');
      }
      return (this.db.prepare('SELECT * FROM work_items WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(filter.status, limit) as any[])
        .map((row) => this.parse(row));
    }
    return (this.db.prepare('SELECT * FROM work_items ORDER BY created_at DESC LIMIT ?').all(limit) as any[])
      .map((row) => this.parse(row));
  }

  get(id: string): WorkItemRecord {
    const row = this.db.prepare('SELECT * FROM work_items WHERE id = ?').get(id);
    if (!row) {
      throw new Error('WORK_ITEM_NOT_FOUND');
    }
    return this.parse(row);
  }

  update(id: string, input: WorkItemUpdateInput): WorkItemRecord {
    const existing = this.get(id);
    const next = {
      title: input.title ?? existing.title,
      description: input.description ?? existing.description,
      risk_class: input.risk_class ?? existing.risk_class,
      value_score: input.value_score ?? existing.value_score,
      confidence: input.confidence ?? existing.confidence,
      status: input.status ?? existing.status,
      recommended_loop: input.recommended_loop ?? existing.recommended_loop,
      assigned_agent_id: input.assigned_agent_id ?? existing.assigned_agent_id,
      assigned_runtime: input.assigned_runtime ?? existing.assigned_runtime,
      parent_goal_id: input.parent_goal_id ?? existing.parent_goal_id,
      metadata: input.metadata ?? existing.metadata,
    };
    this.validateUpdate(next);

    this.db.prepare(`
      UPDATE work_items
      SET title = ?, description = ?, risk_class = ?, value_score = ?, confidence = ?,
          status = ?, recommended_loop = ?, assigned_agent_id = ?, assigned_runtime = ?,
          parent_goal_id = ?, metadata = ?, updated_at = ?
      WHERE id = ?
    `).run(
      next.title.trim(),
      next.description.trim(),
      next.risk_class,
      this.normalizedInteger(next.value_score, existing.value_score, 0, 100),
      this.normalizedNumber(next.confidence, existing.confidence, 0, 1),
      next.status,
      next.recommended_loop || null,
      next.assigned_agent_id || null,
      next.assigned_runtime || null,
      next.parent_goal_id || null,
      JSON.stringify(next.metadata || {}),
      new Date().toISOString(),
      id
    );

    return this.get(id);
  }

  convertToGoal(id: string): { work_item: WorkItemRecord; goal_id: string } {
    const item = this.get(id);
    const now = new Date().toISOString();
    const goalId = randomUUID();
    this.db.prepare(`
      INSERT INTO goals (
        id, objective, constraints_json, acceptance_criteria_json, risk_class,
        budget_json, status, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      goalId,
      item.title,
      JSON.stringify(['created_from_work_item']),
      JSON.stringify([item.description]),
      item.risk_class,
      JSON.stringify({ max_retries: 1, max_failure_count: 3 }),
      'created',
      JSON.stringify({ source_work_item_id: item.id, recommended_loop: item.recommended_loop }),
      now,
      now
    );

    const updated = this.update(id, {
      status: 'planned',
      parent_goal_id: goalId,
      metadata: { ...item.metadata, converted_to_goal_at: now },
    });
    return { work_item: updated, goal_id: goalId };
  }

  private validateCreate(input: WorkItemCreateInput): void {
    if (!input.title?.trim()) {
      throw new Error('WORK_ITEM_TITLE_REQUIRED');
    }
    if (!input.description?.trim()) {
      throw new Error('WORK_ITEM_DESCRIPTION_REQUIRED');
    }
    this.validateUpdate({
      title: input.title,
      description: input.description,
      risk_class: input.risk_class || 'low',
      value_score: input.value_score ?? 50,
      confidence: input.confidence ?? 0.5,
      status: input.status || 'candidate',
    });
  }

  private validateUpdate(input: WorkItemUpdateInput): void {
    if (input.title !== undefined && !input.title.trim()) {
      throw new Error('WORK_ITEM_TITLE_REQUIRED');
    }
    if (input.description !== undefined && !input.description.trim()) {
      throw new Error('WORK_ITEM_DESCRIPTION_REQUIRED');
    }
    if (input.risk_class && !VALID_RISKS.includes(input.risk_class)) {
      throw new Error('WORK_ITEM_RISK_INVALID');
    }
    if (input.status && !VALID_STATUSES.includes(input.status)) {
      throw new Error('WORK_ITEM_STATUS_INVALID');
    }
    if (input.value_score !== undefined) {
      this.normalizedInteger(input.value_score, 50, 0, 100);
    }
    if (input.confidence !== undefined) {
      this.normalizedNumber(input.confidence, 0.5, 0, 1);
    }
  }

  private normalizedInteger(input: unknown, fallback: number, min: number, max: number): number {
    const value = input === undefined ? fallback : Number(input);
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error('WORK_ITEM_NUMERIC_RANGE_INVALID');
    }
    return Math.floor(value);
  }

  private normalizedNumber(input: unknown, fallback: number, min: number, max: number): number {
    const value = input === undefined ? fallback : Number(input);
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error('WORK_ITEM_NUMERIC_RANGE_INVALID');
    }
    return value;
  }

  private parse(row: any): WorkItemRecord {
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      source: row.source,
      source_ref: row.source_ref || null,
      risk_class: row.risk_class,
      value_score: row.value_score,
      confidence: row.confidence,
      status: row.status,
      recommended_loop: row.recommended_loop || null,
      assigned_agent_id: row.assigned_agent_id || null,
      assigned_runtime: row.assigned_runtime || null,
      parent_goal_id: row.parent_goal_id || null,
      metadata: JSON.parse(row.metadata || '{}'),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
