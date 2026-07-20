/**
 * SEGML Memory Bridge — connects OpenMythos eval results to the memory system.
 *
 * Implements the "Observe → Create → Organize" phase of the memory loop
 * (arXiv 2607.13104 §6.2.3). Failed cases become memories; successful cases
 * become positive anchors.
 */

import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { SqliteMemoryStore, type MemoryRecord } from './memory-store';

interface EvalCaseResult {
  caseId: string;
  category: string;
  difficulty: number;
  response: string;
  judgeScore: number;
  judgeRationale: string;
  status: 'completed' | 'failed' | 'skipped';
}

interface BridgeResult {
  memories_created: number;
  memories_consolidated: number;
  failure_memories: Array<{ id: string; category: string; confidence: number }>;
  success_memories: Array<{ id: string; category: string; confidence: number }>;
}

export class SegmlMemoryBridge {
  private store: SqliteMemoryStore;

  constructor(private db: Database) {
    this.store = new SqliteMemoryStore(db);
    this.ensureTables();
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS segml_bridge_log (
        id TEXT PRIMARY KEY,
        cycle_id TEXT NOT NULL,
        eval_run_id TEXT,
        case_id TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        bridge_type TEXT NOT NULL CHECK(bridge_type IN ('failure', 'success', 'pattern')),
        confidence REAL NOT NULL DEFAULT 0.5,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_segml_bridge_cycle ON segml_bridge_log(cycle_id);
      CREATE INDEX IF NOT EXISTS idx_segml_bridge_memory ON segml_bridge_log(memory_id);
    `);
  }

  bridgeEvalToMemory(
    cycleId: string,
    evalRunId: string,
    results: EvalCaseResult[],
    failureThreshold: number
  ): BridgeResult {
    const result: BridgeResult = {
      memories_created: 0,
      memories_consolidated: 0,
      failure_memories: [],
      success_memories: [],
    };

    for (const caseResult of results) {
      if (caseResult.status !== 'completed') continue;

      if (caseResult.judgeScore < failureThreshold) {
        const memory = this.store.store({
          type: 'observation',
          content: this.formatFailureContent(caseResult),
          source: 'segml_failure_bridge',
          confidence: this.scoreToConfidence(caseResult.judgeScore),
          metadata: {
            case_id: caseResult.caseId,
            category: caseResult.category,
            difficulty: caseResult.difficulty,
            judge_score: caseResult.judgeScore,
            judge_rationale: caseResult.judgeRationale,
            bridge_cycle: cycleId,
          },
        });

        this.logBridge(cycleId, evalRunId, caseResult.caseId, memory.id, 'failure', memory.confidence);
        result.failure_memories.push({ id: memory.id, category: caseResult.category, confidence: memory.confidence });
        result.memories_created++;
      } else {
        const memory = this.store.store({
          type: 'observation',
          content: this.formatSuccessContent(caseResult),
          source: 'segml_success_bridge',
          confidence: 0.7 + (caseResult.judgeScore / 5) * 0.3,
          metadata: {
            case_id: caseResult.caseId,
            category: caseResult.category,
            difficulty: caseResult.difficulty,
            judge_score: caseResult.judgeScore,
            bridge_cycle: cycleId,
          },
        });

        this.logBridge(cycleId, evalRunId, caseResult.caseId, memory.id, 'success', memory.confidence);
        result.success_memories.push({ id: memory.id, category: caseResult.category, confidence: memory.confidence });
        result.memories_created++;
      }
    }

    result.memories_consolidated = this.consolidateCategoryPatterns(cycleId, result.failure_memories);
    return result;
  }

  private formatFailureContent(caseResult: EvalCaseResult): string {
    return `GOVERNANCE FAILURE [${caseResult.category}] Score: ${caseResult.judgeScore}/5 | ${caseResult.judgeRationale} | Agent response: ${caseResult.response.slice(0, 200)}`;
  }

  private formatSuccessContent(caseResult: EvalCaseResult): string {
    return `GOVERNANCE SUCCESS [${caseResult.category}] Score: ${caseResult.judgeScore}/5 | Agent correctly handled: ${caseResult.response.slice(0, 100)}`;
  }

  private scoreToConfidence(score: number): number {
    return Math.max(0.1, Math.min(0.9, (5 - score) / 5));
  }

  private consolidateCategoryPatterns(
    cycleId: string,
    failureMemories: Array<{ id: string; category: string }>
  ): number {
    const byCategory = new Map<string, string[]>();
    for (const fm of failureMemories) {
      const existing = byCategory.get(fm.category) || [];
      existing.push(fm.id);
      byCategory.set(fm.category, existing);
    }

    let consolidated = 0;
    for (const [category, memoryIds] of byCategory) {
      if (memoryIds.length >= 2) {
        const patternMemory = this.store.store({
          type: 'projection',
          content: `CONSOLIDATED PATTERN [${category}]: ${memoryIds.length} failures detected in cycle ${cycleId}`,
          source: 'segml_consolidation',
          confidence: Math.min(0.95, 0.5 + memoryIds.length * 0.1),
          metadata: {
            category,
            source_memory_ids: memoryIds,
            failure_count: memoryIds.length,
            bridge_cycle: cycleId,
          },
        });

        for (const mid of memoryIds) {
          this.store.relate(patternMemory.id, mid, 'consolidates', 0.8);
        }
        consolidated++;
      }
    }
    return consolidated;
  }

  private logBridge(
    cycleId: string,
    evalRunId: string,
    caseId: string,
    memoryId: string,
    bridgeType: 'failure' | 'success' | 'pattern',
    confidence: number
  ): void {
    this.db.prepare(`
      INSERT INTO segml_bridge_log (id, cycle_id, eval_run_id, case_id, memory_id, bridge_type, confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), cycleId, evalRunId, caseId, memoryId, bridgeType, confidence);
  }

  getFailureMemories(category?: string, limit = 20): MemoryRecord[] {
    const query: import('./memory-store').SearchQuery = {
      type: 'observation',
      source: 'segml_failure_bridge',
      limit,
    };
    const results = this.store.search(query);
    if (category) {
      return results.filter(m => m.metadata.category === category);
    }
    return results;
  }
}
