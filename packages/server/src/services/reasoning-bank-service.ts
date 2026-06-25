import type { Database } from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { KnowledgeRuntimeService } from './knowledge-runtime-service';

const QDRANT_URL = process.env.QDRANT_URL || 'http://192.168.1.28:6333';
const OLLAMA_URL = (process.env.OLLAMA_URL || process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/$/, '');
const COLLECTION_REASONING = 'djimitflo_reasoning';

export class ReasoningBankService {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
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
