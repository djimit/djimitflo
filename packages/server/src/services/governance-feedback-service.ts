/**
 * GovernanceFeedbackService — self-improving governance from corrections.
 *
 * Learned from OpenMythos deep analysis:
 * - Jurist corrects classification → feedback stored as training data
 * - Engine analyzes correction pattern → proposes keyword update
 * - After validation → keyword added to engine
 * - New engine version tested → CI gates → publish
 *
 * DjimFlo-specific:
 * - Connect OpenMythos case results to strategy evolution
 * - Agent runtime violations → governance rule updates
 * - Human approval/rejection patterns → threshold tuning
 */

import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

interface FeedbackEntry {
  id: string;
  source: 'openmythos_case' | 'runtime_violation' | 'human_correction' | 'self_modification';
  category: string;
  originalDecision: string;
  correctedDecision: string;
  reason: string;
  confidence: number;
  applied: boolean;
  appliedAt?: string;
  createdAt: string;
}

interface FeedbackLoopStats {
  totalFeedback: number;
  appliedFeedback: number;
  pendingFeedback: number;
  byCategory: Record<string, number>;
  bySource: Record<string, number>;
}

export class GovernanceFeedbackService {
  constructor(private db: Database) {
    this.ensureTables();
  }

  /**
   * Record a feedback entry from any source.
   */
  recordFeedback(input: {
    source: FeedbackEntry['source'];
    category: string;
    originalDecision: string;
    correctedDecision: string;
    reason: string;
    confidence?: number;
  }): FeedbackEntry {
    const entry: FeedbackEntry = {
      id: randomUUID(),
      source: input.source,
      category: input.category,
      originalDecision: input.originalDecision,
      correctedDecision: input.correctedDecision,
      reason: input.reason,
      confidence: input.confidence ?? 0.5,
      applied: false,
      createdAt: new Date().toISOString(),
    };

    this.db.prepare(`
      INSERT INTO governance_feedback
      (id, source, category, original_decision, corrected_decision, reason, confidence, applied, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      entry.id, entry.source, entry.category, entry.originalDecision,
      entry.correctedDecision, entry.reason, entry.confidence, entry.createdAt,
    );

    return entry;
  }

  /**
   * Analyze pending feedback and generate improvement proposals.
   */
  analyzeFeedback(): Array<{
    pattern: string;
    count: number;
    proposal: string;
    confidence: number;
  }> {
    const pending = this.db.prepare(`
      SELECT category, original_decision, corrected_decision, COUNT(*) as count
      FROM governance_feedback
      WHERE applied = 0
      GROUP BY category, original_decision, corrected_decision
      HAVING count >= 2
      ORDER BY count DESC
      LIMIT 20
    `).all() as Array<{ category: string; original_decision: string; corrected_decision: string; count: number }>;

    return pending.map((row) => ({
      pattern: `${row.category}: "${row.original_decision}" → "${row.corrected_decision}"`,
      count: row.count,
      proposal: `Update governance rules: ${row.category} should classify "${row.original_decision}" as "${row.corrected_decision}"`,
      confidence: Math.min(1, row.count / 5),
    }));
  }

  /**
   * Apply a feedback proposal (mark as applied).
   */
  applyFeedback(pattern: string): void {
    this.db.prepare(`
      UPDATE governance_feedback SET applied = 1, applied_at = ?
      WHERE category || ': "' || original_decision || '" → "' || corrected_decision || '"' = ?
        AND applied = 0
    `).run(new Date().toISOString(), pattern);
  }

  /**
   * Get feedback loop statistics.
   */
  getStats(): FeedbackLoopStats {
    const total = (this.db.prepare('SELECT COUNT(*) as c FROM governance_feedback').get() as any)?.c || 0;
    const applied = (this.db.prepare('SELECT COUNT(*) as c FROM governance_feedback WHERE applied = 1').get() as any)?.c || 0;

    const byCategory = (this.db.prepare(`
      SELECT category, COUNT(*) as c FROM governance_feedback GROUP BY category
    `).all() as Array<{ category: string; c: number }>).reduce((acc, row) => {
      acc[row.category] = row.c;
      return acc;
    }, {} as Record<string, number>);

    const bySource = (this.db.prepare(`
      SELECT source, COUNT(*) as c FROM governance_feedback GROUP BY source
    `).all() as Array<{ source: string; c: number }>).reduce((acc, row) => {
      acc[row.source] = row.c;
      return acc;
    }, {} as Record<string, number>);

    return {
      totalFeedback: total,
      appliedFeedback: applied,
      pendingFeedback: total - applied,
      byCategory,
      bySource,
    };
  }

  /**
   * Get recent feedback entries.
   */
  getRecentFeedback(limit = 20): FeedbackEntry[] {
    return (this.db.prepare(`
      SELECT * FROM governance_feedback ORDER BY created_at DESC LIMIT ?
    `).all(limit) as any[]).map((r) => ({
      id: r.id,
      source: r.source,
      category: r.category,
      originalDecision: r.original_decision,
      correctedDecision: r.corrected_decision,
      reason: r.reason,
      confidence: r.confidence,
      applied: !!r.applied,
      appliedAt: r.applied_at,
      createdAt: r.created_at,
    }));
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS governance_feedback (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL CHECK(source IN ('openmythos_case', 'runtime_violation', 'human_correction', 'self_modification')),
        category TEXT NOT NULL DEFAULT '',
        original_decision TEXT NOT NULL DEFAULT '',
        corrected_decision TEXT NOT NULL DEFAULT '',
        reason TEXT NOT NULL DEFAULT '',
        confidence REAL NOT NULL DEFAULT 0.5,
        applied INTEGER NOT NULL DEFAULT 0,
        applied_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_governance_feedback_applied ON governance_feedback(applied);
      CREATE INDEX IF NOT EXISTS idx_governance_feedback_category ON governance_feedback(category);
    `);
  }
}
