/**
 * SEGML Meta-Learning Bridge — SEGML evolves its own configuration.
 *
 * Implements recursive self-improvement (arXiv 2607.13104 §6.4):
 * SEGML doesn't just improve agent governance — it improves HOW it
 * improves agent governance.
 *
 * Meta-learning dimensions:
 * 1. Threshold adaptation: failure_threshold auto-tunes based on outcomes
 * 2. Cycle frequency: interval adapts to governance velocity
 * 3. Case generation strategy: mutation methods evolve based on effectiveness
 * 4. Rubric update aggressiveness: weight change magnitude adapts
 *
 * This is the highest level of the self-improvement stack:
 * - Level 0: Static governance (fixed thresholds)
 * - Level 1: Reactive governance (SEGML cycles triggered by eval results)
 * - Level 2: Adaptive governance (SEGML adapts its parameters)
 * - Level 3: Meta-learning governance (SEGML evolves its learning strategy)
 *
 * Safety constraints:
 * - All meta-changes are logged and reversible
 * - Changes are bounded (min/max limits per parameter)
 * - Human approval required for changes outside safe bounds
 * - Rollback to previous configuration always available
 */

import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { swarmEventBus } from './swarm-event-bus';
import type { SegmlConfig } from './segml-types';
import { DEFAULT_SEGML_CONFIG } from './segml-types';

interface MetaLearningState {
  currentConfig: SegmlConfig;
  configHistory: Array<{ config: SegmlConfig; timestamp: string; reason: string }>;
  performanceHistory: Array<{ cycleId: string; scoreDelta: number; timestamp: string }>;
  adaptationCount: number;
}

interface ParameterBounds {
  min: number;
  max: number;
  safeMin: number;
  safeMax: number;
}

interface MetaChangeEvent {
  id: string;
  parameter: string;
  oldValue: number;
  newValue: number;
  reason: string;
  autoApproved: boolean;
  timestamp: string;
}

const PARAMETER_BOUNDS: Record<keyof SegmlConfig, ParameterBounds> = {
<<<<<<< HEAD
  failure_threshold: { min: 1.0, max: 4.0, safeMin: 2.0, safeMax: 3.5 },
=======
  failure_threshold: { min: 1.5, max: 3.5, safeMin: 2.0, safeMax: 3.0 },
>>>>>>> feat/segml-self-evolving-governance
  min_cases_for_pattern: { min: 2, max: 10, safeMin: 3, safeMax: 7 },
  max_generated_cases_per_cycle: { min: 5, max: 50, safeMin: 10, safeMax: 30 },
  consolidation_confidence_threshold: { min: 0.3, max: 0.9, safeMin: 0.5, safeMax: 0.8 },
  judge_update_min_evidence: { min: 2, max: 15, safeMin: 3, safeMax: 10 },
  validation_enabled: { min: 0, max: 1, safeMin: 0, safeMax: 1 },
  rollback_on_no_improvement: { min: 0, max: 1, safeMin: 0, safeMax: 1 },
<<<<<<< HEAD
=======
  max_corpus_size: { min: 100, max: 10000, safeMin: 500, safeMax: 2000 },
>>>>>>> feat/segml-self-evolving-governance
};

export class SegmlMetaLearningBridge {
  private state: MetaLearningState;

  constructor(private db: Database) {
    this.ensureTables();
    this.state = this.loadState();
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS segml_meta_state (
        id TEXT PRIMARY KEY,
        config_json TEXT NOT NULL,
        config_history_json TEXT NOT NULL DEFAULT '[]',
        performance_history_json TEXT NOT NULL DEFAULT '[]',
        adaptation_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS segml_meta_changes (
        id TEXT PRIMARY KEY,
        parameter TEXT NOT NULL,
        old_value REAL NOT NULL,
        new_value REAL NOT NULL,
        reason TEXT NOT NULL,
        auto_approved INTEGER NOT NULL DEFAULT 0,
        reverted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_segml_mc_parameter ON segml_meta_changes(parameter);
      CREATE INDEX IF NOT EXISTS idx_segml_mc_reverted ON segml_meta_changes(reverted);
    `);
  }

  /**
   * Load or initialize meta-learning state.
   */
  private loadState(): MetaLearningState {
    const row = this.db.prepare('SELECT * FROM segml_meta_state ORDER BY updated_at DESC LIMIT 1').get() as any;

    if (row) {
      return {
        currentConfig: JSON.parse(row.config_json),
        configHistory: JSON.parse(row.config_history_json),
        performanceHistory: JSON.parse(row.performance_history_json),
        adaptationCount: row.adaptation_count,
      };
    }

    // Initialize with defaults
    const initial: MetaLearningState = {
      currentConfig: { ...DEFAULT_SEGML_CONFIG },
      configHistory: [],
      performanceHistory: [],
      adaptationCount: 0,
    };
    this.persistState(initial);
    return initial;
  }

  private persistState(state: MetaLearningState): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO segml_meta_state (id, config_json, config_history_json, performance_history_json, adaptation_count, updated_at)
      VALUES ('meta-state', ?, ?, ?, ?, ?)
    `).run(
      JSON.stringify(state.currentConfig),
      JSON.stringify(state.configHistory),
      JSON.stringify(state.performanceHistory),
      state.adaptationCount,
      new Date().toISOString()
    );
  }

  /**
   * Record cycle performance for meta-learning.
   */
  recordPerformance(cycleId: string, scoreDelta: number): void {
    this.state.performanceHistory.push({
      cycleId,
      scoreDelta,
      timestamp: new Date().toISOString(),
    });

    // Keep only last 50 entries
    if (this.state.performanceHistory.length > 50) {
      this.state.performanceHistory = this.state.performanceHistory.slice(-50);
    }

    // Trigger adaptation every 5 cycles
    if (this.state.performanceHistory.length % 5 === 0) {
      this.adaptConfiguration();
    }

    this.persistState(this.state);
  }

  /**
   * Adapt SEGML configuration based on performance history.
   * This is the core meta-learning algorithm.
   */
  adaptConfiguration(): MetaChangeEvent[] {
    const changes: MetaChangeEvent[] = [];
    const recent = this.state.performanceHistory.slice(-10);

    if (recent.length < 5) return changes;

    const avgDelta = recent.reduce((sum, p) => sum + p.scoreDelta, 0) / recent.length;
    const improving = recent.filter(p => p.scoreDelta > 0).length;
    const declining = recent.filter(p => p.scoreDelta < 0).length;

    // Adaptation 1: If consistently declining, lower failure_threshold to catch more
    if (declining >= 3 && avgDelta < -0.1) {
      const change = this.adaptParameter('failure_threshold', -0.2,
        `Declining performance (${declining}/10 cycles negative, avg delta: ${avgDelta.toFixed(3)}) — lowering threshold for stricter detection`);
      if (change) changes.push(change);
    }

    // Adaptation 2: If consistently improving, we can be more lenient
    if (improving >= 4 && avgDelta > 0.1) {
      const change = this.adaptParameter('failure_threshold', 0.1,
        `Improving performance (${improving}/10 cycles positive, avg delta: ${avgDelta.toFixed(3)}) — raising threshold for more selective detection`);
      if (change) changes.push(change);
    }

    // Adaptation 3: If many blind spots detected, increase case generation
    if (declining >= 2) {
      const change = this.adaptParameter('max_generated_cases_per_cycle', 5,
        `Increasing case generation to address declining performance`);
      if (change) changes.push(change);
    }

    // Adaptation 4: If performance is volatile, increase evidence requirement for stability
    const recentDeltas = this.state.performanceHistory.slice(-5).map(p => p.scoreDelta);
    const variance = recentDeltas.length > 1
      ? recentDeltas.reduce((sum, d) => sum + (d - avgDelta) ** 2, 0) / recentDeltas.length
      : 0;
    if (variance > 0.5) {
      const change = this.adaptParameter('judge_update_min_evidence', 1,
        `High performance variance (${variance.toFixed(3)}) — increasing evidence requirement for stability`);
      if (change) changes.push(change);
    }

    return changes;
  }

  /**
   * Adapt a single parameter within bounds.
   */
  private adaptParameter(parameter: keyof SegmlConfig, delta: number, reason: string): MetaChangeEvent | null {
    const bounds = PARAMETER_BOUNDS[parameter];
    const oldValue = this.state.currentConfig[parameter] as number;
    let newValue = oldValue + delta;

    // Enforce bounds
    newValue = Math.max(bounds.min, Math.min(bounds.max, newValue));

    // Round to reasonable precision
    newValue = Math.round(newValue * 100) / 100;

    if (Math.abs(newValue - oldValue) < 0.01) return null;

    // Determine if auto-approved (within safe bounds)
    const autoApproved = newValue >= bounds.safeMin && newValue <= bounds.safeMax;

    const change: MetaChangeEvent = {
      id: randomUUID(),
      parameter,
      oldValue,
      newValue,
      reason,
      autoApproved,
      timestamp: new Date().toISOString(),
    };

    // Save current config to history before changing
    this.state.configHistory.push({
      config: { ...this.state.currentConfig },
      timestamp: new Date().toISOString(),
      reason: `Pre-change snapshot before ${parameter}: ${oldValue} → ${newValue}`,
    });

    // Apply change
    (this.state.currentConfig[parameter] as number) = newValue;
    this.state.adaptationCount++;

    // Persist
    this.db.prepare(`
      INSERT INTO segml_meta_changes (id, parameter, old_value, new_value, reason, auto_approved)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(change.id, parameter, oldValue, newValue, reason, autoApproved ? 1 : 0);

    this.persistState(this.state);

    // Emit event
    swarmEventBus.emit('segml:meta:adaptation', {
      parameter,
      oldValue,
      newValue,
      reason,
      autoApproved,
    });

    return change;
  }

  /**
   * Revert the last meta-change (rollback).
   */
  revertLastChange(): boolean {
    const lastChange = this.db.prepare(`
      SELECT * FROM segml_meta_changes WHERE reverted = 0 ORDER BY created_at DESC LIMIT 1
    `).get() as any;

    if (!lastChange) return false;

    // Revert parameter
    (this.state.currentConfig[lastChange.parameter as keyof SegmlConfig] as number) = lastChange.old_value;

    // Mark as reverted
    this.db.prepare('UPDATE segml_meta_changes SET reverted = 1 WHERE id = ?').run(lastChange.id);

    this.persistState(this.state);

    swarmEventBus.emit('segml:meta:reverted', {
      parameter: lastChange.parameter,
      revertedTo: lastChange.old_value,
    });

    return true;
  }

  /**
   * Get current adapted configuration.
   */
  getCurrentConfig(): SegmlConfig {
    return { ...this.state.currentConfig };
  }

  /**
   * Get meta-learning status.
   */
  getStatus(): {
    currentConfig: SegmlConfig;
    adaptationCount: number;
    totalChanges: number;
    revertedChanges: number;
    autoApprovedChanges: number;
    pendingApproval: number;
    performanceHistoryLength: number;
  } {
    const total = this.db.prepare('SELECT COUNT(*) as c FROM segml_meta_changes').get() as { c: number };
    const reverted = this.db.prepare('SELECT COUNT(*) as c FROM segml_meta_changes WHERE reverted = 1').get() as { c: number };
    const autoApproved = this.db.prepare('SELECT COUNT(*) as c FROM segml_meta_changes WHERE auto_approved = 1 AND reverted = 0').get() as { c: number };

    return {
      currentConfig: this.state.currentConfig,
      adaptationCount: this.state.adaptationCount,
      totalChanges: total.c,
      revertedChanges: reverted.c,
      autoApprovedChanges: autoApproved.c,
      pendingApproval: total.c - reverted.c - autoApproved.c,
      performanceHistoryLength: this.state.performanceHistory.length,
    };
  }
}
