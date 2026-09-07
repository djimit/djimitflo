import fs from 'fs';
import path from 'path';
import type { Database } from 'better-sqlite3';
import { LoopService, type GoalRecord } from './loop-service';
import { SwarmEvidenceService } from './swarm-evidence-service';

type GoalRisk = 'low' | 'medium' | 'high' | 'critical';

export interface GoalBatchPreviewItem {
  id: string;
  objective: string;
  risk_class: GoalRisk;
  target_ref: string | null;
  acceptance_criteria: string[];
  constraints: string[];
  falsification_tests: string[];
  blocked_reasons: string[];
  depends_on: string[];
  wave_id: string | null;
  metadata: Record<string, unknown>;
}

export interface GoalBatchPreviewResult {
  schema: string | null;
  campaign_id: string | null;
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

const FLYWHEEL_BATCH_PATH = 'openspec/changes/prove-learning-flywheel-operator-loop/goals.batch.json';
const GOLDEN_LEARNING_BATCH_PATH = 'goals/golden-learning-campaign.batch.json';

export class GoalBatchService {
  private loops: LoopService;

  constructor(private db: Database, private repoRoot = process.cwd()) {
    this.loops = new LoopService(db);
  }

  preview(input: GoalBatchInput = {}): GoalBatchPreviewResult {
    const batch = this.resolveBatch(input);
    const rawGoals = this.batchGoals(batch);
    const selected = new Set((input.selected_ids || []).map((id) => String(id).trim()).filter(Boolean));
    const items = rawGoals
      .map(({ goal, waveId }, index) => this.previewItem(goal, index, batch, waveId))
      .filter((item) => selected.size === 0 || selected.has(item.id));
    const errors = items
      .filter((item) => item.blocked_reasons.length > 0)
      .map((item) => ({ id: item.id, error: item.blocked_reasons.join(', ') }));
    const schema = typeof (batch as any).schema === 'string' ? String((batch as any).schema) : null;
    if (schema && !['djimit.openmythos.goal.v1', 'djimit.openmythos.worldlab.goal.v1'].includes(schema)) {
      errors.push({ id: 'batch', error: 'schema_unsupported' });
    }
    const waves = Array.isArray((batch as any).waves) ? (batch as any).waves : null;
    if (waves && waves.some((wave: any) => this.rawGoals(wave).length > 3)) {
      errors.push({ id: 'batch', error: 'maximum_3_goals_per_wave' });
    } else if (!waves && items.length > 3) {
      errors.push({ id: 'batch', error: 'maximum_3_goals_per_batch' });
    }
    return {
      schema,
      campaign_id: typeof (batch as any).campaign_id === 'string' ? (batch as any).campaign_id : null,
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
          constraints: item.constraints.length > 0 ? item.constraints : [`target:${item.target_ref || 'repo'}`],
          risk_class: item.risk_class,
          budget: { max_failure_count: 2 },
          metadata: {
            goal_batch: {
              id: item.id,
              schema: preview.schema,
              campaign_id: preview.campaign_id,
              wave_id: item.wave_id,
              change: preview.change,
              target_ref: item.target_ref,
            },
            depends_on_goal_keys: item.depends_on,
            falsification_tests: item.falsification_tests,
            ...item.metadata,
            imported_without_worker_start: true,
            execution_source: 'goal_batch_import',
            executor_runtime: null,
            attempt_count: 0,
          },
        }, ownerUserId));
        const created = createdGoals[createdGoals.length - 1];
        const source = item.metadata.openmythos_source as Record<string, unknown> | undefined;
        const findingId = typeof source?.finding_id === 'string' ? source.finding_id : null;
        if (findingId) {
          const evidence = new SwarmEvidenceService(this.db);
          evidence.createEvidenceEdge(`finding:${findingId}`, `goal:${created.id}`, 'proposes_change', { campaign_id: preview.campaign_id, effect_scope: 'isolated' });
          if (typeof source?.evidence_hash === 'string') {
            evidence.createEvidenceEdge(source.evidence_hash, `finding:${findingId}`, 'supports', { effect_scope: 'simulated' });
          }
        }
      }
    });
    insert();
    return { preview, created_goals: createdGoals, skipped, started_workers: 0 };
  }

  private resolveBatch(input: GoalBatchInput): unknown {
    if (input.batch && typeof input.batch === 'object') return input.batch;
    const repoRoot = fs.realpathSync.native(path.resolve(this.repoRoot));
    const requestedPath = input.path === FLYWHEEL_BATCH_PATH
      ? path.join(repoRoot, 'openspec', 'changes', 'prove-learning-flywheel-operator-loop', 'goals.batch.json')
      : input.path === GOLDEN_LEARNING_BATCH_PATH
        ? path.join(repoRoot, 'goals', 'golden-learning-campaign.batch.json')
        : null;
    if (!requestedPath) throw new Error('GOAL_BATCH_PATH_FORBIDDEN');
    if (!fs.existsSync(requestedPath)) throw new Error('GOAL_BATCH_NOT_FOUND');
    const batchPath = fs.realpathSync.native(requestedPath);
    const relativePath = path.relative(repoRoot, batchPath);
    if (relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
      throw new Error('GOAL_BATCH_PATH_FORBIDDEN');
    }
    try {
      return JSON.parse(fs.readFileSync(batchPath, 'utf8'));
    } catch {
      throw new Error('GOAL_BATCH_JSON_INVALID');
    }
  }

  private previewItem(goal: any, index: number, batch: unknown, waveId: string | null): GoalBatchPreviewItem {
    const body = goal?.api?.body && typeof goal.api.body === 'object' ? goal.api.body : goal || {};
    const id = String(goal?.key || goal?.id || `goal-${index + 1}`).trim();
    const objective = String(body.objective || body.title || goal?.title || '').trim();
    const acceptance = Array.isArray(body.acceptance_criteria)
      ? body.acceptance_criteria.map(String).filter(Boolean)
      : Array.isArray(body.acceptance) ? body.acceptance.map(String).filter(Boolean) : [];
    const constraints = Array.isArray(body.constraints) ? body.constraints.map(String).filter(Boolean) : [];
    const falsificationTests = Array.isArray(body.falsification_tests) ? body.falsification_tests.map(String).filter(Boolean) : [];
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
      constraints,
      falsification_tests: falsificationTests,
      blocked_reasons: blockedReasons,
      depends_on: Array.isArray(goal?.depends_on) ? goal.depends_on.map(String).filter(Boolean) : [],
      wave_id: waveId,
      metadata: {
        ...(body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata) ? body.metadata : {}),
        ...(typeof body.recommended_loop === 'string' ? { recommended_loop: body.recommended_loop } : {}),
        ...((batch as any).source && typeof (batch as any).source === 'object' ? { openmythos_source: (batch as any).source } : {}),
        ...((batch as any).finding && typeof (batch as any).finding === 'object' ? { openmythos_finding: (batch as any).finding } : {}),
      },
    };
  }

  private batchHasGoal(batch: unknown, dep: unknown): boolean {
    const id = String(dep || '').trim();
    const inCampaign = this.batchGoals(batch).some(({ goal }) => String(goal?.key || goal?.id || '').trim() === id);
    if (inCampaign) return true;
    return Boolean(this.db.prepare("SELECT id FROM goals WHERE json_extract(metadata, '$.goal_batch.id') = ? LIMIT 1").get(id));
  }

  private rawGoals(batch: any): unknown[] {
    return Array.isArray(batch?.ordered_goals) ? batch.ordered_goals : Array.isArray(batch?.goals) ? batch.goals : [];
  }

  private batchGoals(batch: unknown): Array<{ goal: any; waveId: string | null }> {
    if (Array.isArray((batch as any)?.waves)) {
      return (batch as any).waves.flatMap((wave: any, index: number) => this.rawGoals(wave).map((goal) => ({
        goal,
        waveId: String(wave?.wave_id || wave?.id || `wave-${index + 1}`),
      })));
    }
    return this.rawGoals(batch).map((goal) => ({ goal, waveId: null }));
  }

  private risk(value: unknown): GoalRisk | null {
    const risk = String(value || 'low').trim();
    return ['low', 'medium', 'high', 'critical'].includes(risk) ? risk as GoalRisk : null;
  }
}
