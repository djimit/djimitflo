/**
 * ContextIsolationService — per-sub-agent context window management.
 *
 * Each nested spawned agent gets its own context budget and message history.
 * When context exceeds budget, it is automatically summarized and offloaded
 * to disk, preventing context pollution between parent and child agents.
 *
 * Backward-compatible: existing spawns without context budget are unaffected.
 */

import { join } from 'path';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import type { Database } from 'better-sqlite3';

interface ContextEntry {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: string;
  tokens?: number;
}

interface ContextSummary {
  summary: string;
  entriesCompressed: number;
  timestamp: string;
}

export class ContextIsolationService {
  private readonly contextDir: string;

  constructor(
    private db: Database,
    dataDir: string = join(process.cwd(), '.data', 'nested-contexts'),
  ) {
    this.contextDir = dataDir;
    mkdirSync(this.contextDir, { recursive: true });
    this.ensureColumns();
  }

  private ensureColumns(): void {
    try {
      const cols = this.db.prepare("PRAGMA table_info(spawn_trees)").all() as Array<{ name: string }>;
      const hasBudget = cols.some((c) => c.name === 'context_budget');
      const hasConsumed = cols.some((c) => c.name === 'context_consumed');
      if (!hasBudget) {
        this.db.exec("ALTER TABLE spawn_trees ADD COLUMN context_budget INTEGER DEFAULT 0");
      }
      if (!hasConsumed) {
        this.db.exec("ALTER TABLE spawn_trees ADD COLUMN context_consumed INTEGER DEFAULT 0");
      }
    } catch {
      // Table may not exist yet — migrations will create it with new columns
    }
  }

  /**
   * Get the context budget for a spawn tree (0 = no isolation, backward-compatible).
   */
  getContextBudget(spawnTreeId: string): number {
    try {
      const row = this.db.prepare('SELECT context_budget FROM spawn_trees WHERE id = ?').get(spawnTreeId) as { context_budget: number } | undefined;
      return row?.context_budget ?? 0;
    } catch {
      return 0;
    }
  }

  getContextConsumed(spawnTreeId: string): number {
    try {
      const row = this.db.prepare('SELECT context_consumed FROM spawn_trees WHERE id = ?').get(spawnTreeId) as { context_consumed: number } | undefined;
      return row?.context_consumed ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Check if a spawn tree has context isolation enabled.
   */
  hasIsolation(spawnTreeId: string): boolean {
    return this.getContextBudget(spawnTreeId) > 0;
  }

  /**
   * Add a message to a sub-agent's context history.
   * Returns true if the context is within budget, false if summarization needed.
   */
  appendMessage(spawnTreeId: string, leaseId: string, entry: ContextEntry): { withinBudget: boolean; summarized: boolean } {
    const budget = this.getContextBudget(spawnTreeId);
    if (budget <= 0) {
      return { withinBudget: true, summarized: false };
    }

    const tokens = entry.tokens ?? this.estimateTokens(entry.content);
    const currentConsumed = this.getContextConsumed(spawnTreeId);
    const newConsumed = currentConsumed + tokens;

    this.db.prepare('UPDATE spawn_trees SET context_consumed = ?, updated_at = datetime(\'now\') WHERE id = ?').run(newConsumed, spawnTreeId);

    // Persist to disk
    const filePath = this.getContextFilePath(spawnTreeId, leaseId);
    const existing = this.loadContext(filePath);
    existing.push(entry);
    writeFileSync(filePath, JSON.stringify(existing, null, 2));

    if (newConsumed > budget) {
      this.summarizeContext(spawnTreeId, leaseId);
      return { withinBudget: false, summarized: true };
    }

    return { withinBudget: true, summarized: false };
  }

  /**
   * Summarize the context history, compress it, and reset the consumed counter.
   */
  summarizeContext(spawnTreeId: string, leaseId: string): ContextSummary {
    const filePath = this.getContextFilePath(spawnTreeId, leaseId);
    const entries = this.loadContext(filePath);

    // Simple summarization: keep last 3 entries, compress the rest
    const keepRecent = 3;
    const toCompress = entries.slice(0, Math.max(0, entries.length - keepRecent));
    const recent = entries.slice(Math.max(0, entries.length - keepRecent));

    const summary: ContextSummary = {
      summary: toCompress.map((e) => `[${e.role}] ${e.content.slice(0, 200)}`).join('\n'),
      entriesCompressed: toCompress.length,
      timestamp: new Date().toISOString(),
    };

    // Write summary to disk
    const summaryPath = this.getSummaryFilePath(spawnTreeId, leaseId);
    const existingSummaries = this.loadSummaries(summaryPath);
    existingSummaries.push(summary);
    writeFileSync(summaryPath, JSON.stringify(existingSummaries, null, 2));

    // Reset context to just the recent entries
    writeFileSync(filePath, JSON.stringify(recent, null, 2));

    // Reset consumed to just the recent entries
    const recentTokens = recent.reduce((sum, e) => sum + (e.tokens ?? this.estimateTokens(e.content)), 0);
    this.db.prepare('UPDATE spawn_trees SET context_consumed = ?, updated_at = datetime(\'now\') WHERE id = ?').run(recentTokens, spawnTreeId);

    return summary;
  }

  /**
   * Load context history for a specific lease.
   */
  loadContext(filePath: string): ContextEntry[] {
    if (!existsSync(filePath)) return [];
    try {
      return JSON.parse(readFileSync(filePath, 'utf8')) as ContextEntry[];
    } catch {
      return [];
    }
  }

  private loadSummaries(filePath: string): ContextSummary[] {
    if (!existsSync(filePath)) return [];
    try {
      return JSON.parse(readFileSync(filePath, 'utf8')) as ContextSummary[];
    } catch {
      return [];
    }
  }

  private getContextFilePath(spawnTreeId: string, leaseId: string): string {
    return join(this.contextDir, `${spawnTreeId}_${leaseId}.json`);
  }

  private getSummaryFilePath(spawnTreeId: string, leaseId: string): string {
    return join(this.contextDir, `${spawnTreeId}_${leaseId}_summaries.json`);
  }

  /**
   * Rough token estimation: ~4 characters per token.
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * Get context status for a spawn tree.
   */
  getStatus(spawnTreeId: string): { budget: number; consumed: number; utilization: number; isolated: boolean } {
    const budget = this.getContextBudget(spawnTreeId);
    const consumed = this.getContextConsumed(spawnTreeId);
    return {
      budget,
      consumed,
      utilization: budget > 0 ? consumed / budget : 0,
      isolated: budget > 0,
    };
  }
}
