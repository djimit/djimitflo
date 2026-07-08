/**
 * MultiModelIntelligence — capability-aware model routing and ensemble validation.
 *
 * Routes sub-tasks to optimal models based on tracked capabilities:
 * 1. Model Capability Registry — track which models excel at which tasks
 * 2. Dynamic Routing — route to best model based on task type + history
 * 3. Ensemble Validation — use multiple models for critical decisions
 * 4. Cost-Aware Routing — balance quality vs. cost per task
 */

import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

interface ModelCapability {
  modelId: string;
  modelName: string;
  provider: string;
  capabilities: ModelTaskCapability[];
  costPerMtok: number;
  avgLatencyMs: number;
  status: 'active' | 'degraded' | 'offline';
}

interface ModelTaskCapability {
  taskType: string;
  successRate: number;
  avgScore: number;
  sampleCount: number;
  lastEvaluated: string;
}

interface RoutingDecision {
  id: string;
  taskType: string;
  selectedModel: string;
  reason: string;
  alternatives: string[];
  confidence: number;
  timestamp: string;
  cascadeLevel?: number;
  estimatedCost?: number;
}

interface CascadeDecision extends RoutingDecision {
  cascadeLevel: number;
  maxEscalations: number;
  estimatedCost: number;
  modelsAttempted: string[];
}

export class MultiModelIntelligence {
  private modelCache: Map<string, ModelCapability> = new Map();

  constructor(private db: Database) {
    this.ensureTables();
    this.loadModels();
  }

  /**
   * Register a model with its capabilities.
   */
  registerModel(input: {
    modelId: string;
    modelName: string;
    provider: string;
    costPerMtok?: number;
    capabilities?: Array<{ taskType: string; successRate?: number }>;
  }): ModelCapability {
    const model: ModelCapability = {
      modelId: input.modelId,
      modelName: input.modelName,
      provider: input.provider,
      capabilities: (input.capabilities || []).map((c) => ({
        taskType: c.taskType,
        successRate: c.successRate || 0.5,
        avgScore: 0,
        sampleCount: 0,
        lastEvaluated: new Date().toISOString(),
      })),
      costPerMtok: input.costPerMtok || 2.0,
      avgLatencyMs: 0,
      status: 'active',
    };

    this.modelCache.set(input.modelId, model);

    this.db.prepare(`
      INSERT OR REPLACE INTO model_capabilities
      (id, model_id, model_name, provider, cost_per_mtok, status, capabilities_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), model.modelId, model.modelName, model.provider,
      model.costPerMtok, model.status, JSON.stringify(model.capabilities), new Date().toISOString(),
    );

    return model;
  }

  /**
   * Route a task to the optimal model.
   */
  routeTask(input: {
    taskType: string;
    minSuccessRate?: number;
    maxCost?: number;
    preferLowLatency?: boolean;
  }): RoutingDecision {
    const models = this.getEligibleModels(input.taskType, input.minSuccessRate, input.maxCost);

    if (models.length === 0) {
      return {
        id: randomUUID(),
        taskType: input.taskType,
        selectedModel: 'workstation-litellm/coding', // Default fallback
        reason: 'No specialized model available, using default',
        alternatives: [],
        confidence: 0.5,
        timestamp: new Date().toISOString(),
      };
    }

    // Score models by: success rate, cost efficiency, latency
    const scored = models.map((model) => {
      const taskCap = model.capabilities.find((c) => c.taskType === input.taskType);
      const successScore = taskCap?.successRate || 0;
      const costScore = input.maxCost ? Math.max(0, 1 - (model.costPerMtok / input.maxCost)) : 0.5;
      const latencyScore = input.preferLowLatency ? 0.3 : 0;

      const totalScore = (successScore * 0.6) + (costScore * 0.2) + (latencyScore * 0.2);

      return { model, score: totalScore, taskCap };
    });

    scored.sort((a, b) => b.score - a.score);
    const selected = scored[0];

    const decision: RoutingDecision = {
      id: randomUUID(),
      taskType: input.taskType,
      selectedModel: selected.model.modelId,
      reason: `Best success rate (${((selected.taskCap?.successRate || 0) * 100).toFixed(0)}%) for ${input.taskType}`,
      alternatives: scored.slice(1, 4).map((s) => s.model.modelId),
      confidence: selected.score,
      timestamp: new Date().toISOString(),
    };

    // Store decision
    this.db.prepare(`
      INSERT INTO model_routing_decisions
      (id, task_type, selected_model, reason, alternatives_json, confidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      decision.id, decision.taskType, decision.selectedModel,
      decision.reason, JSON.stringify(decision.alternatives),
      decision.confidence, decision.timestamp,
    );

    return decision;
  }

  /**
   * Record the outcome of a model execution for learning.
   */
  recordOutcome(input: {
    modelId: string;
    taskType: string;
    success: boolean;
    score?: number;
    latencyMs?: number;
    costDollars?: number;
  }): void {
    const model = this.modelCache.get(input.modelId);
    if (!model) return;

    const cap = model.capabilities.find((c) => c.taskType === input.taskType);
    if (cap) {
      // Exponential moving average for success rate
      const alpha = 0.3;
      const newRate = input.success ? 1 : 0;
      cap.successRate = (cap.successRate * (1 - alpha)) + (newRate * alpha);
      cap.sampleCount++;
      cap.lastEvaluated = new Date().toISOString();

      if (input.score) {
        cap.avgScore = (cap.avgScore * (cap.sampleCount - 1) + input.score) / cap.sampleCount;
      }
    } else {
      model.capabilities.push({
        taskType: input.taskType,
        successRate: input.success ? 1 : 0,
        avgScore: input.score || 0,
        sampleCount: 1,
        lastEvaluated: new Date().toISOString(),
      });
    }

    // Update DB
    this.db.prepare(`
      UPDATE model_capabilities SET capabilities_json = ?, updated_at = ? WHERE model_id = ?
    `).run(JSON.stringify(model.capabilities), new Date().toISOString(), input.modelId);

    // Store outcome
    this.db.prepare(`
      INSERT INTO model_execution_outcomes
      (id, model_id, task_type, success, score, latency_ms, cost_dollars, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), input.modelId, input.taskType, input.success ? 1 : 0,
      input.score || null, input.latencyMs || null, input.costDollars || null,
      new Date().toISOString(),
    );
  }

  /**
   * Get the best models for a specific task type.
   */
  getBestModels(taskType: string, limit = 5): Array<{
    modelId: string;
    modelName: string;
    successRate: number;
    sampleCount: number;
  }> {
    const models = Array.from(this.modelCache.values());
    return models
      .map((m) => ({
        modelId: m.modelId,
        modelName: m.modelName,
        successRate: m.capabilities.find((c) => c.taskType === taskType)?.successRate || 0,
        sampleCount: m.capabilities.find((c) => c.taskType === taskType)?.sampleCount || 0,
      }))
      .filter((m) => m.sampleCount > 0)
      .sort((a, b) => b.successRate - a.successRate)
      .slice(0, limit);
  }

  // ─── Cascade Profile Configuration ─────────────────────────────────────

  private static readonly CASCADE_PROFILES = {
    balanced: { minSuccessRate: 0.60, minSampleCount: 5, maxEscalations: 2 },
    conservative: { minSuccessRate: 0.70, minSampleCount: 10, maxEscalations: 1 },
    aggressive: { minSuccessRate: 0.50, minSampleCount: 3, maxEscalations: 3 },
  } as const;

  private getCascadeProfile(): { minSuccessRate: number; minSampleCount: number; maxEscalations: number } {
    const profile = process.env.COST_CASCADE_PROFILE;
    if (profile && profile in MultiModelIntelligence.CASCADE_PROFILES) {
      return MultiModelIntelligence.CASCADE_PROFILES[profile as keyof typeof MultiModelIntelligence.CASCADE_PROFILES];
    }
    // Fall back to individual env vars, then balanced defaults
    return {
      minSuccessRate: Number(process.env.CASCADE_MIN_SUCCESS_RATE) || MultiModelIntelligence.CASCADE_PROFILES.balanced.minSuccessRate,
      minSampleCount: Number(process.env.CASCADE_MIN_SAMPLES) || MultiModelIntelligence.CASCADE_PROFILES.balanced.minSampleCount,
      maxEscalations: Number(process.env.CASCADE_MAX_ESCALATIONS) || MultiModelIntelligence.CASCADE_PROFILES.balanced.maxEscalations,
    };
  }

  /**
   * Cost-cascade routing: try cheapest model first, escalate on failure.
   *
   * Profile selection via COST_CASCADE_PROFILE env var:
   *   - balanced   (default): 60% min success, 5 samples, 2 escalations
   *   - conservative:         70% min success, 10 samples, 1 escalation
   *   - aggressive:           50% min success, 3 samples, 3 escalations
   *
   * Warm-up mode: when sampleCount < minSampleCount, falls back to standard
   * routeTask() instead of skipping cascade — ensures routing works from day 1.
   */
  routeWithCascade(input: {
    taskType: string;
    minSuccessRate?: number;
    minSampleCount?: number;
    maxEscalations?: number;
  }): CascadeDecision {
    const profile = this.getCascadeProfile();
    const minRate = input.minSuccessRate ?? profile.minSuccessRate;
    const minSamples = input.minSampleCount ?? profile.minSampleCount;
    const maxEscalations = input.maxEscalations ?? profile.maxEscalations;
    const cascadeEnabled = process.env.COST_CASCADE_ENABLED === 'true';

    // Get eligible models sorted by cost (ascending)
    const eligible = Array.from(this.modelCache.values())
      .filter((model) => {
        if (model.status !== 'active') return false;
        const taskCap = model.capabilities.find((c) => c.taskType === input.taskType);
        if (!taskCap) return false;
        if (!cascadeEnabled) return true;
        return taskCap.successRate >= minRate && taskCap.sampleCount >= minSamples;
      })
      .sort((a, b) => a.costPerMtok - b.costPerMtok);

    // Warm-up mode: not enough data for cascade — use standard routing
    if (eligible.length === 0 && cascadeEnabled) {
      const warmup = this.routeTask(input);
      return {
        ...warmup,
        cascadeLevel: 0,
        maxEscalations,
        estimatedCost: 0,
        modelsAttempted: [],
        reason: `[warmup] ${warmup.reason} — insufficient data for cascade (need ${minSamples}+ samples)`,
      };
    }

    if (eligible.length === 0) {
      const fallback = this.routeTask(input);
      return { ...fallback, cascadeLevel: 0, maxEscalations, estimatedCost: 0, modelsAttempted: [] };
    }

    const selected = eligible[0];
    const taskCap = selected.capabilities.find((c) => c.taskType === input.taskType);

    const decision: CascadeDecision = {
      id: randomUUID(),
      taskType: input.taskType,
      selectedModel: selected.modelId,
      reason: cascadeEnabled
        ? `Cascade L0: cheapest ($${selected.costPerMtok}/Mtok, success: ${((taskCap?.successRate || 0) * 100).toFixed(0)}%, samples: ${taskCap?.sampleCount ?? 0})`
        : `Cost-aware: cheapest eligible ($${selected.costPerMtok}/Mtok)`,
      alternatives: eligible.slice(1, maxEscalations + 1).map((m) => m.modelId),
      confidence: taskCap?.successRate || 0.5,
      timestamp: new Date().toISOString(),
      cascadeLevel: 0,
      maxEscalations,
      estimatedCost: selected.costPerMtok,
      modelsAttempted: [],
    };

    this.storeDecision(decision);
    return decision;
  }

  /**
   * Record cascade outcome: on failure, escalate to next model.
   * Supports multi-level escalation (L0 → L1 → L2 → ...).
   * Returns the next model to try, or null if max escalations reached.
   */
  recordCascadeOutcome(input: {
    decisionId: string;
    modelId: string;
    success: boolean;
    latencyMs?: number;
    costDollars?: number;
  }): CascadeDecision | null {
    const existing = this.db.prepare('SELECT * FROM model_routing_decisions WHERE id = ?').get(input.decisionId) as any;
    if (!existing) return null;

    const alternatives = JSON.parse(existing.alternatives_json || '[]');
    const currentLevel = existing.cascade_level || 0;

    // Record outcome for the model that was tried
    this.recordOutcome({
      modelId: input.modelId,
      taskType: existing.task_type,
      success: input.success,
      latencyMs: input.latencyMs,
      costDollars: input.costDollars,
    });

    // Success — no escalation needed
    if (input.success) return null;

    // Failure — check if we can escalate
    if (alternatives.length === 0 || currentLevel >= (existing.max_escalations || 2)) {
      return null; // Max escalations reached
    }

    const nextModelId = alternatives[0];
    const nextModel = this.modelCache.get(nextModelId);
    if (!nextModel) return null;

    const taskCap = nextModel.capabilities.find((c) => c.taskType === existing.task_type);
    const nextLevel = currentLevel + 1;

    const escalation: CascadeDecision = {
      id: randomUUID(),
      taskType: existing.task_type,
      selectedModel: nextModelId,
      reason: `Cascade L${nextLevel}: escalation from ${input.modelId} ($${nextModel.costPerMtok}/Mtok, success: ${((taskCap?.successRate || 0) * 100).toFixed(0)}%)`,
      alternatives: alternatives.slice(1),
      confidence: taskCap?.successRate || 0.5,
      timestamp: new Date().toISOString(),
      cascadeLevel: nextLevel,
      maxEscalations: existing.max_escalations || 2,
      estimatedCost: nextModel.costPerMtok,
      modelsAttempted: [...(existing.models_attempted ? JSON.parse(existing.models_attempted) : []), input.modelId],
    };

    this.storeDecision(escalation, nextLevel, escalation.modelsAttempted);
    return escalation;
  }

  private storeDecision(decision: CascadeDecision | RoutingDecision, cascadeLevel?: number, modelsAttempted?: string[]): void {
    this.db.prepare(`
      INSERT INTO model_routing_decisions
      (id, task_type, selected_model, reason, alternatives_json, confidence, cascade_level, max_escalations, models_attempted, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        cascade_level = excluded.cascade_level,
        models_attempted = excluded.models_attempted
    `).run(
      decision.id, decision.taskType, decision.selectedModel,
      decision.reason, JSON.stringify(decision.alternatives),
      decision.confidence,
      cascadeLevel ?? (decision as CascadeDecision).cascadeLevel ?? 0,
      (decision as CascadeDecision).maxEscalations ?? 0,
      JSON.stringify(modelsAttempted ?? (decision as CascadeDecision).modelsAttempted ?? []),
      decision.timestamp,
    );
  }

  /**
   * Get model registry status.
   */
  getStatus(): {
    totalModels: number;
    activeModels: number;
    totalCapabilities: number;
    routingDecisions: number;
  } {
    const models = Array.from(this.modelCache.values());
    const active = models.filter((m) => m.status === 'active').length;
    const totalCaps = models.reduce((sum, m) => sum + m.capabilities.length, 0);
    const decisions = (this.db.prepare('SELECT COUNT(*) as c FROM model_routing_decisions').get() as any)?.c || 0;

    return { totalModels: models.length, activeModels: active, totalCapabilities: totalCaps, routingDecisions: decisions };
  }

  // ─── Private ──────────────────────────────────────────────────────────

  private getEligibleModels(taskType: string, minSuccessRate?: number, maxCost?: number): ModelCapability[] {
    return Array.from(this.modelCache.values()).filter((model) => {
      if (model.status !== 'active') return false;

      const taskCap = model.capabilities.find((c) => c.taskType === taskType);
      if (!taskCap || taskCap.sampleCount < 2) return false; // Need minimum samples

      if (minSuccessRate && taskCap.successRate < minSuccessRate) return false;
      if (maxCost && model.costPerMtok > maxCost) return false;

      return true;
    });
  }

  private loadModels(): void {
    const rows = this.db.prepare('SELECT * FROM model_capabilities').all() as any[];
    for (const row of rows) {
      const model: ModelCapability = {
        modelId: row.model_id,
        modelName: row.model_name,
        provider: row.provider,
        costPerMtok: row.cost_per_mtok,
        avgLatencyMs: row.avg_latency_ms || 0,
        status: row.status,
        capabilities: JSON.parse(row.capabilities_json || '[]'),
      };
      this.modelCache.set(model.modelId, model);
    }
  }

  /**
   * Get cascade routing statistics for monitoring/optimization.
   */
  getCascadeRoutingStats(): {
    totalDecisions: number;
    cascadeDecisions: number;
    escalations: number;
    escalationRate: number;
    profile: string;
    warmupFallbacks: number;
  } {
    const total = (this.db.prepare('SELECT COUNT(*) as c FROM model_routing_decisions').get() as any)?.c || 0;
    const cascade = (this.db.prepare("SELECT COUNT(*) as c FROM model_routing_decisions WHERE reason LIKE 'Cascade%'").get() as any)?.c || 0;
    const escalations = (this.db.prepare("SELECT COUNT(*) as c FROM model_routing_decisions WHERE cascade_level > 0").get() as any)?.c || 0;
    const warmup = (this.db.prepare("SELECT COUNT(*) as c FROM model_routing_decisions WHERE reason LIKE '[warmup]%'").get() as any)?.c || 0;
    return {
      totalDecisions: total,
      cascadeDecisions: cascade,
      escalations,
      escalationRate: cascade > 0 ? escalations / cascade : 0,
      profile: process.env.COST_CASCADE_PROFILE || 'balanced',
      warmupFallbacks: warmup,
    };
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS model_capabilities (
        id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL UNIQUE,
        model_name TEXT NOT NULL DEFAULT '',
        provider TEXT NOT NULL DEFAULT 'workstation-litellm',
        cost_per_mtok REAL NOT NULL DEFAULT 2.0,
        avg_latency_ms INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'degraded', 'offline')),
        capabilities_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_model_capabilities_status ON model_capabilities(status);

      CREATE TABLE IF NOT EXISTS model_routing_decisions (
        id TEXT PRIMARY KEY,
        task_type TEXT NOT NULL,
        selected_model TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        alternatives_json TEXT NOT NULL DEFAULT '[]',
        confidence REAL NOT NULL DEFAULT 0,
        cascade_level INTEGER NOT NULL DEFAULT 0,
        max_escalations INTEGER NOT NULL DEFAULT 0,
        models_attempted TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS model_execution_outcomes (
        id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL,
        task_type TEXT NOT NULL,
        success INTEGER NOT NULL DEFAULT 0,
        score REAL,
        latency_ms INTEGER,
        cost_dollars REAL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_model_outcomes_model ON model_execution_outcomes(model_id);
      CREATE INDEX IF NOT EXISTS idx_model_outcomes_task ON model_execution_outcomes(task_type);
    `);
  }
}
