import fs from 'fs';
import path from 'path';
import type { Database } from 'better-sqlite3';
import { LoopService, type GoalRecord } from './loop-service';

type GoalRisk = 'low' | 'medium' | 'high' | 'critical';

export interface GoalBatchPreviewItem {
  id: string;
  objective: string;
  risk_class: GoalRisk;
  target_ref: string | null;
  acceptance_criteria: string[];
  blocked_reasons: string[];
}

export interface GoalBatchPreviewResult {
  change: string | null;
  total: number;
  valid: number;
  blocked: number;
  items: GoalBatchPreviewItem[];
  errors: Array<{ id: string; error: string }>;
  writes: 0;
}

export interface GoalBatchApplyResult {
  preview: GoalBatchPreviewResult;
  created_goals: GoalRecord[];
  skipped: Array<{ id: string; reason: string }>;
  started_workers: 0;
}

interface GoalBatchInput {
  batch?: unknown;
  path?: string;
  selected_ids?: string[];
}

export class GoalBatchService {
  private loops: LoopService;

  constructor(private db: Database, private repoRoot = process.cwd()) {
    this.loops = new LoopService(db);
  }

  preview(input: GoalBatchInput = {}): GoalBatchPreviewResult {
    const batch = this.resolveBatch(input);
    const rawGoals: unknown[] = Array.isArray((batch as any).ordered_goals)
      ? (batch as any).ordered_goals
      : Array.isArray((batch as any).goals) ? (batch as any).goals : [];
    const selected = new Set((input.selected_ids || []).map((id) => String(id).trim()).filter(Boolean));
    const items = rawGoals
      .map((goal: unknown, index: number) => this.previewItem(goal, index, batch))
      .filter((item) => selected.size === 0 || selected.has(item.id));
    const errors = items
      .filter((item) => item.blocked_reasons.length > 0)
      .map((item) => ({ id: item.id, error: item.blocked_reasons.join(', ') }));
    return {
      change: typeof (batch as any).change === 'string' ? (batch as any).change : null,
      total: items.length,
      valid: items.filter((item) => item.blocked_reasons.length === 0).length,
      blocked: errors.length,
      items,
      errors,
      writes: 0,
    };
  }

  apply(input: GoalBatchInput = {}, ownerUserId?: string): GoalBatchApplyResult {
    const preview = this.preview(input);
    if (preview.errors.length > 0) {
      throw new Error('GOAL_BATCH_INVALID');
    }
    const createdGoals: GoalRecord[] = [];
    const skipped: GoalBatchApplyResult['skipped'] = [];
    const insert = this.db.transaction(() => {
      for (const item of preview.items) {
        const existing = this.db.prepare('SELECT * FROM goals WHERE json_extract(metadata, ?) = ?').get('$.goal_batch.id', item.id);
        if (existing) {
          skipped.push({ id: item.id, reason: 'already_imported' });
          continue;
        }
        createdGoals.push(this.loops.createGoal({
          objective: item.objective,
          acceptance_criteria: item.acceptance_criteria,
          constraints: [`target:${item.target_ref || 'repo'}`],
          risk_class: item.risk_class,
          metadata: {
            goal_batch: {
              id: item.id,
              change: preview.change,
              target_ref: item.target_ref,
            },
            imported_without_worker_start: true,
          },
        }, ownerUserId));
      }
    });
    insert();
    return { preview, created_goals: createdGoals, skipped, started_workers: 0 };
  }

  private resolveBatch(input: GoalBatchInput): unknown {
    if (input.batch && typeof input.batch === 'object') return input.batch;
    const batchPath = path.resolve(this.repoRoot, input.path || 'goals.batch.json');
    const repoRoot = path.resolve(this.repoRoot);
    if (!batchPath.startsWith(`${repoRoot}${path.sep}`) && batchPath !== repoRoot) {
      throw new Error('GOAL_BATCH_PATH_FORBIDDEN');
    }
    if (!fs.existsSync(batchPath)) throw new Error('GOAL_BATCH_NOT_FOUND');
    try {
      return JSON.parse(fs.readFileSync(batchPath, 'utf8'));
    } catch {
      throw new Error('GOAL_BATCH_JSON_INVALID');
    }
  }

  private previewItem(goal: any, index: number, batch: unknown): GoalBatchPreviewItem {
    const body = goal?.api?.body && typeof goal.api.body === 'object' ? goal.api.body : goal || {};
    const id = String(goal?.key || goal?.id || `goal-${index + 1}`).trim();
    const objective = String(body.objective || body.title || goal?.title || '').trim();
    const acceptance = Array.isArray(body.acceptance_criteria)
      ? body.acceptance_criteria.map(String).filter(Boolean)
      : Array.isArray(body.acceptance) ? body.acceptance.map(String).filter(Boolean) : [];
    const riskClass = this.risk(body.risk_class || goal?.risk);
    const targetRef = String(goal?.target || body.metadata?.target || body.metadata?.recommended_loop || '').trim() || null;
    const blockedReasons = [
      !id ? 'id_required' : '',
      !objective ? 'objective_required' : '',
      acceptance.length === 0 ? 'acceptance_criteria_required' : '',
      !riskClass ? 'risk_class_invalid' : '',
      Array.isArray(goal?.depends_on) && goal.depends_on.some((dep: unknown) => !this.batchHasGoal(batch, dep)) ? 'dependency_missing' : '',
    ].filter(Boolean);
    return {
      id,
      objective,
      risk_class: riskClass || 'low',
      target_ref: targetRef,
      acceptance_criteria: acceptance,
      blocked_reasons: blockedReasons,
    };
  }

  private batchHasGoal(batch: unknown, dep: unknown): boolean {
    const id = String(dep || '').trim();
    const goals = Array.isArray((batch as any).ordered_goals) ? (batch as any).ordered_goals : Array.isArray((batch as any).goals) ? (batch as any).goals : [];
    return goals.some((goal: any) => String(goal?.key || goal?.id || '').trim() === id);
  }

  private risk(value: unknown): GoalRisk | null {
    const risk = String(value || 'low').trim();
    return ['low', 'medium', 'high', 'critical'].includes(risk) ? risk as GoalRisk : null;
  }
}
