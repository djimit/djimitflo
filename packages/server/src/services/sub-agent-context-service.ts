/**
 * SubAgentContextService — isolated context windows for nested sub-agents.
 *
 * Implements the Deep Agents pattern (LangChain) for context isolation:
 * 1. Each sub-agent gets its own context budget (token limit)
 * 2. Tool outputs are offloaded to disk when exceeding threshold
 * 3. Context is summarized when budget is exceeded
 * 4. Sub-agent scratch space for intermediate results
 *
 * Integration point: NestedSpawnService.createRoot() and requestSpawn()
 * should use this service to enforce per-agent context limits.
 */

import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import type { Database } from 'better-sqlite3';

interface ContextWindow {
  spawnTreeId: string;
  leaseId: string;
  budget: number;
  consumed: number;
  messageCount: number;
  toolOutputCount: number;
  status: 'active' | 'overflow' | 'summarized' | 'closed';
  lastActivity: string;
}

// Types stored in DB tables sub_agent_tool_outputs and sub_agent_scratch

const DEFAULT_CONTEXT_BUDGET = 4000; // tokens
const TOOL_OUTPUT_OFFLOAD_THRESHOLD = 2000; // bytes
const SCRATCH_DIR = process.env.DJIMITFLO_SCRATCH_DIR || '.data/sub-agent-scratch';

export class SubAgentContextService {
  private scratchDir: string;
  private windows: Map<string, ContextWindow> = new Map();

  constructor(private db: Database) {
    this.scratchDir = SCRATCH_DIR;
    mkdirSync(this.scratchDir, { recursive: true });
  }

  /**
   * Initialize a context window for a sub-agent.
   */
  initializeWindow(spawnTreeId: string, leaseId: string, budget?: number): ContextWindow {
    const window: ContextWindow = {
      spawnTreeId,
      leaseId,
      budget: budget ?? DEFAULT_CONTEXT_BUDGET,
      consumed: 0,
      messageCount: 0,
      toolOutputCount: 0,
      status: 'active',
      lastActivity: new Date().toISOString(),
    };

    this.windows.set(leaseId, window);
    return window;
  }

  /**
   * Record a message in the context window.
   * Returns 'ok' if within budget, 'overflow' if budget exceeded.
   */
  recordMessage(leaseId: string, tokenCount: number): 'ok' | 'overflow' {
    const window = this.windows.get(leaseId);
    if (!window) return 'ok';

    window.consumed += tokenCount;
    window.messageCount++;
    window.lastActivity = new Date().toISOString();

    if (window.consumed >= window.budget) {
      window.status = 'overflow';
      return 'overflow';
    }

    return 'ok';
  }

  /**
   * Handle tool output — offload to disk if large.
   */
  handleToolOutput(leaseId: string, toolName: string, output: string): {
    stored: 'memory' | 'disk';
    reference: string;
    summary: string;
  } {
    const window = this.windows.get(leaseId);
    if (window) {
      window.toolOutputCount++;
      window.lastActivity = new Date().toISOString();
    }

    const outputSize = output.length;

    if (outputSize > TOOL_OUTPUT_OFFLOAD_THRESHOLD) {
      // Offload to disk
      const offloadId = randomUUID();
      const filePath = join(this.scratchDir, `${leaseId}_${offloadId}.txt`);
      writeFileSync(filePath, output);

      const summary = this.summarizeOutput(output);

      // Store metadata
      this.db.prepare(`
        INSERT INTO sub_agent_tool_outputs (id, lease_id, tool_name, original_size, file_path, summary, offloaded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(offloadId, leaseId, toolName, outputSize, filePath, summary, new Date().toISOString());

      return { stored: 'disk', reference: offloadId, summary };
    }

    return { stored: 'memory', reference: output, summary: output.slice(0, 100) };
  }

  /**
   * Retrieve offloaded tool output.
   */
  retrieveToolOutput(offloadId: string): string | null {
    const row = this.db.prepare('SELECT file_path FROM sub_agent_tool_outputs WHERE id = ?').get(offloadId) as any;
    if (!row?.file_path) return null;

    try {
      return readFileSync(row.file_path, 'utf8');
    } catch {
      return null;
    }
  }

  /**
   * Write to sub-agent scratch space.
   */
  writeScratch(leaseId: string, key: string, value: string): void {
    const scratchId = randomUUID();
    this.db.prepare(`
      INSERT INTO sub_agent_scratch (id, lease_id, key, value, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(lease_id, key) DO UPDATE SET value = excluded.value, created_at = excluded.created_at
    `).run(scratchId, leaseId, key, value, new Date().toISOString());
  }

  /**
   * Read from sub-agent scratch space.
   */
  readScratch(leaseId: string, key: string): string | null {
    const row = this.db.prepare('SELECT value FROM sub_agent_scratch WHERE lease_id = ? AND key = ?').get(leaseId, key) as any;
    return row?.value || null;
  }

  /**
   * List all scratch entries for a sub-agent.
   */
  listScratch(leaseId: string): Array<{ key: string; value: string; createdAt: string }> {
    return (this.db.prepare('SELECT key, value, created_at as createdAt FROM sub_agent_scratch WHERE lease_id = ? ORDER BY created_at').all(leaseId) as any[]);
  }

  /**
   * Get context window status.
   */
  getWindowStatus(leaseId: string): ContextWindow | null {
    return this.windows.get(leaseId) || null;
  }

  /**
   * Summarize context when budget is exceeded.
   */
  summarizeContext(leaseId: string): string {
    const window = this.windows.get(leaseId);
    if (!window) return 'No context window found.';

    window.status = 'summarized';

    return `Context window summarized: ${window.messageCount} messages, ${window.toolOutputCount} tool outputs, ${window.consumed}/${window.budget} tokens consumed.`;
  }

  /**
   * Close a context window and clean up resources.
   */
  closeWindow(leaseId: string): void {
    const window = this.windows.get(leaseId);
    if (window) {
      window.status = 'closed';
      this.windows.delete(leaseId);
    }

    // Clean up scratch files
    try {
      const rows = this.db.prepare('SELECT file_path FROM sub_agent_tool_outputs WHERE lease_id = ?').all(leaseId) as any[];
      for (const row of rows) {
        if (row.file_path && existsSync(row.file_path)) {
          rmSync(row.file_path, { force: true });
        }
      }
    } catch { /* best-effort cleanup */ }
  }

  /**
   * Get statistics for all active windows.
   */
  getStats(): {
    activeWindows: number;
    totalConsumed: number;
    totalBudget: number;
    overflowCount: number;
    offloadedOutputs: number;
  } {
    const windows = Array.from(this.windows.values());
    return {
      activeWindows: windows.filter((w) => w.status === 'active').length,
      totalConsumed: windows.reduce((sum, w) => sum + w.consumed, 0),
      totalBudget: windows.reduce((sum, w) => sum + w.budget, 0),
      overflowCount: windows.filter((w) => w.status === 'overflow').length,
      offloadedOutputs: (this.db.prepare('SELECT COUNT(*) as c FROM sub_agent_tool_outputs').get() as any)?.c || 0,
    };
  }

  private summarizeOutput(output: string): string {
    // Simple summarization: first 100 chars + last 50 chars
    if (output.length <= 150) return output;
    return `${output.slice(0, 100)}... [${output.length - 150} chars omitted] ...${output.slice(-50)}`;
  }
}
