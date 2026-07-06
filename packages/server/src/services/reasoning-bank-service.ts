import type { Database } from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { KnowledgeRuntimeService } from './knowledge-runtime-service';
import { VectorMemoryService } from './vector-memory-service';
import { TrajectoryStore } from './trajectory-store';

const QDRANT_URL = process.env.QDRANT_URL || 'http://192.168.1.28:6333';
const OLLAMA_URL = (process.env.OLLAMA_URL || process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/$/, '');
const COLLECTION_REASONING = 'djimitflo_reasoning';

export class ReasoningBankService {
  private db: Database;
  private vectorMemory?: VectorMemoryService;
  private trajectoryStore?: TrajectoryStore;

  constructor(db: Database) {
    this.db = db;
  }

  setVectorMemory(service: VectorMemoryService): void {
    this.vectorMemory = service;
  }

  setTrajectoryStore(store: TrajectoryStore): void {
    this.trajectoryStore = store;
  }

  async recordReasoning(taskId: string): Promise<void> {
    const task = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any;
    if (!task) return;

    const agent = task.agent_id
      ? (this.db.prepare('SELECT * FROM agents WHERE id = ?').get(task.agent_id) as any)
      : null;

    const approval = this.db.prepare(
      "SELECT * FROM approvals WHERE task_id = ? ORDER BY created_at DESC LIMIT 1"
    ).get(taskId) as any;

    const outcome = approval?.status === 'approved' ? 'approved'
      : approval?.status === 'denied' ? 'denied'
      : task.status === 'completed' ? 'auto_completed' : 'unknown';

    // Extract context used during task creation
    const metadata = JSON.parse(task.metadata || '{}');
    const swarmContext = metadata.swarm_context || '';

    // Write to OKF as reasoning entry
    const okfDir = path.join(KnowledgeRuntimeService.resolveCanonicalOkfBase({ allowMissing: true }), 'memory');
    fs.mkdirSync(okfDir, { recursive: true });

    const reasoningPath = path.join(okfDir, `${taskId}.md`);
    const description = (task.description || task.title || '').slice(0, 200).replace(/"/g, '\\"');

    const frontmatter = [
      '---',
      `type: Reasoning`,
      `title: "Reasoning: ${(task.title || taskId).replace(/"/g, '\\"')}"`,
      `description: "${description}"`,
      `tags: [reasoning, ${outcome}, ${task.created_by || 'unknown'}]`,
      `task_id: ${taskId}`,
      `outcome: ${outcome}`,
      `agent_type: ${agent?.agent_type || 'unknown'}`,
      `machine_id: ${task.created_by || 'unknown'}`,
      `trust_level: ${outcome === 'approved' ? 'approved' : 'agent_generated'}`,
      `timestamp: ${new Date().toISOString()}`,
      '---',
    ].join('\n');

    const body = [
      `# Reasoning: ${task.title || taskId}`,
      '',
      `**Outcome**: ${outcome}`,
      `**Machine**: ${task.created_by || 'unknown'}`,
      `**Agent type**: ${agent?.agent_type || 'unknown'}`,
      `**Approval**: ${approval?.status || 'none'}`,
      `**Denial reason**: ${approval?.denial_reason || 'N/A'}`,
      '',
      '## Task Prompt',
      '',
      task.description || task.title || 'N/A',
      '',
      `## Context Used`,
      '',
      swarmContext ? swarmContext.slice(0, 500) : '_No swarm context injected_',
      '',
    ].join('\n');

    fs.writeFileSync(reasoningPath, `${frontmatter}\n\n${body}\n`, 'utf8');

    // Upsert to Qdrant djimitflo_reasoning collection
    try {
      const check = await fetch(`${QDRANT_URL}/collections/${COLLECTION_REASONING}`);
      if (check.status === 404) {
        await fetch(`${QDRANT_URL}/collections/${COLLECTION_REASONING}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vectors: { size: 384, distance: 'Cosine' } }),
        });
      }

      // Use MiniLM embedding (matches djimitflo_swarm dimension)
      const embedRes = await fetch(`${OLLAMA_URL}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'all-MiniLM-L6-v2', prompt: `${task.title} ${task.description}` }),
      });

      if (embedRes.ok) {
        const embedJson = (await embedRes.json()) as { embedding: number[] };
        const vector = embedJson.embedding;
        await fetch(`${QDRANT_URL}/collections/${COLLECTION_REASONING}/points`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            points: [{
              id: taskId,
              vector,
              payload: {
                task_id: taskId,
                task_prompt: (task.title || '').slice(0, 200),
                context_used: swarmContext ? 'yes' : 'no',
                outcome,
                denial_reason: approval?.denial_reason || null,
                machine_id: task.created_by || 'unknown',
                agent_type: agent?.agent_type || 'unknown',
                timestamp: new Date().toISOString(),
              },
            }],
          }),
        });
      }
    } catch (e) {
      console.warn(`ReasoningBank Qdrant write failed for ${taskId}:`, e);
    }

    // Feedback loop: reward vector memory entries that were used in this reasoning
    if (this.vectorMemory) {
      const reward = outcome === 'approved' ? 1.0 : outcome === 'denied' ? 0.2 : 0.5;
      try {
        const related = this.vectorMemory.search(`${task.title} ${task.description}`, 3);
        for (const r of related) {
          this.vectorMemory.recordFeedback(r.id, reward);
        }
      } catch { /* best-effort */ }
    }
  }

  /**
   * Get trajectory context for a reasoning search.
   * Returns human-readable trajectory summaries for similar past runs.
   */
  getTrajectoryContext(query: string, limit: number = 3): string {
    if (!this.trajectoryStore) return '';
    const results = this.trajectoryStore.findSimilarTrajectories(
      query.toLowerCase().split(/\s+/).filter(w => w.length > 3),
      limit
    );
    if (results.length === 0) return '';

    const lines: string[] = ['## Trajectory Context', ''];
    for (const r of results) {
      const summary = this.trajectoryStore.getTrajectorySummary(r.runId);
      lines.push(`- **${r.runId.slice(0, 8)}** (${r.outcome}): ${summary}`);
    }
    return lines.join('\n');
  }

  async searchReasoning(query: string, limit: number = 5): Promise<any[]> {
    try {
      const embedRes = await fetch(`${OLLAMA_URL}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'all-MiniLM-L6-v2', prompt: query }),
      });
      if (!embedRes.ok) return [];
      const vector = ((await embedRes.json()) as { embedding: number[] }).embedding;

      const searchRes = await fetch(`${QDRANT_URL}/collections/${COLLECTION_REASONING}/points/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vector, limit, with_payload: true, score_threshold: 0.5 }),
      });
      if (!searchRes.ok) return [];
      const searchJson = (await searchRes.json()) as { result: any[] };
      return searchJson.result || [];
    } catch {
      return [];
    }
  }
}
