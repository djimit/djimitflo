import type { Database } from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { createHash } from 'crypto';
import { KnowledgeRuntimeService } from './knowledge-runtime-service';
import { yamlScalar } from '../utils/yaml-scalar';

// Resolved per call so operators/tests can override without a rebuild.
const DEFAULT_UAMS_URL = 'http://192.168.1.28:8000';
const DEFAULT_QDRANT_URL = 'http://192.168.1.28:6333';
const uamsUrl = (): string => process.env.UAMS_URL || DEFAULT_UAMS_URL;
const qdrantUrl = (): string => process.env.QDRANT_URL || DEFAULT_QDRANT_URL;

// Writes may target a different Qdrant than reads (e.g. the read-only credential
// is intentional, while writes go to the service store). Falls back to the read pair.
const qdrantWriteUrl = (): string => process.env.QDRANT_WRITE_URL || qdrantUrl();
const qdrantWriteApiKey = (): string | undefined => process.env.QDRANT_WRITE_API_KEY || process.env.QDRANT_API_KEY;

function authHeaders(apiKey: string | undefined, scheme: 'bearer' | 'api-key'): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers[scheme === 'bearer' ? 'Authorization' : 'api-key'] = scheme === 'bearer' ? `Bearer ${apiKey}` : apiKey;
  return headers;
}

const EMBED_MODEL = process.env.DJIMITFLO_EMBED_MODEL || process.env.OLLAMA_EMBED_MODEL || 'snowflake-arctic-embed:s';
const EMBED_TIMEOUT_MS = Number(process.env.EMBEDDING_TIMEOUT_MS) || 10_000;

/**
 * Task ids are not valid Qdrant point ids: they are UUIDs or composite strings
 * like `loop-worker-<uuid>-<hex>`. Derive a stable UUIDv5-shaped id from the task
 * id so upserts are deterministic and idempotent.
 */
function pointIdForTask(taskId: string): string {
  const hex = createHash('sha256').update(taskId).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const h = hex.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Embed via Ollama using the same endpoint fallback as OllamaEmbeddingProvider.
 * Returns null (never throws) so a missing embedding model degrades the Qdrant
 * leg only; UAMS/OKF are unaffected.
 */
async function embedText(text: string): Promise<number[] | null> {
  const base = (process.env.OLLAMA_URL || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const call = async (path: string, body: Record<string, unknown>): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });
  try {
    let res = await call('/api/embed', { model: EMBED_MODEL, input: text });
    if (res.status === 404) res = await call('/api/embeddings', { model: EMBED_MODEL, prompt: text });
    if (!res.ok) return null;
    const payload = (await res.json()) as { embedding?: number[]; embeddings?: number[][] };
    const vector = payload.embedding || payload.embeddings?.[0];
    return vector?.length && vector.every((v) => Number.isFinite(v)) ? vector : null;
  } catch {
    return null;
  }
}

export class MemorySyncService {
  private db: Database;
  private okfTasksDir: string;

  constructor(db: Database) {
    this.db = db;
    this.okfTasksDir = path.join(KnowledgeRuntimeService.resolveCanonicalOkfBase({ allowMissing: true }), 'tasks');
  }

  async onTaskCompleted(taskId: string): Promise<void> {
    const task = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any;
    if (!task) return;

    const agent = task.agent_id
      ? (this.db.prepare('SELECT * FROM agents WHERE id = ?').get(task.agent_id) as any)
      : null;

    const content = task.description || task.title || '';
    const machineId = task.created_by || 'unknown';
    const agentType = agent?.agent_type || 'unknown';

    await Promise.allSettled([
      this.syncToUAMS(taskId, content, machineId, agentType),
      this.syncToQdrant(taskId, content, machineId, agentType),
      Promise.resolve(this.writeOKFConcept(task, machineId, agentType)),
    ]);
  }

  private async syncToUAMS(taskId: string, content: string, machineId: string, agentType: string): Promise<void> {
    if (!content.trim()) {
      console.warn(`UAMS sync skipped for task ${taskId}: empty content`);
      return;
    }
    const apiKey = process.env.UAMS_API_KEY;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`${uamsUrl()}/memory/entry`, {
          method: 'POST',
          headers: authHeaders(apiKey, 'bearer'),
          body: JSON.stringify({
            memory_type: 'active',
            scope: 'system',
            agent_id: machineId,
            topic: `task:${taskId}`,
            content: content.slice(0, 2000),
            metadata: { task_id: taskId, machine_id: machineId, agent_type: agentType },
          }),
        });
        if (res.ok) {
          console.log(`Memory synced: task ${taskId} → UAMS`);
          return;
        }
        if (res.status === 401 || res.status === 403) {
          console.warn(`UAMS sync rejected for task ${taskId}: ${res.status} (check UAMS_API_KEY)`);
          return;
        }
        if (res.status >= 500 && attempt < 2) {
          await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
          continue;
        }
        console.warn(`UAMS sync failed for task ${taskId}: ${res.status}`);
        return;
      } catch (e) {
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
          continue;
        }
        console.warn(`UAMS sync error for task ${taskId}:`, e);
      }
    }
  }

  private async syncToQdrant(taskId: string, content: string, machineId: string, agentType: string): Promise<void> {
    const excerpt = content.slice(0, 500);

    const apiKey = qdrantWriteApiKey();
    const headers = authHeaders(apiKey, 'api-key');
    const base = qdrantWriteUrl();
    const collection = 'djimitflo_swarm';

    try {
      const vector = await embedText(`${taskId} ${content}`);
      if (!vector) {
        console.warn(`Qdrant sync skipped for task ${taskId}: embedding unavailable (set DJIMITFLO_EMBED_MODEL to a served model)`);
        return;
      }

      // Check if collection exists; only recreate an EMPTY mismatched collection
      // (never destroy populated data at a different dimension).
      const checkRes = await fetch(`${base}/collections/${collection}`, { headers });
      if (checkRes.status === 404) {
        const createRes = await fetch(`${base}/collections/${collection}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ vectors: { size: vector.length, distance: 'Cosine' } }),
        });
        if (!createRes.ok) {
          console.warn(`Qdrant sync failed for task ${taskId}: create ${createRes.status}`);
          return;
        }
      } else if (checkRes.ok) {
        const info = (await checkRes.json()) as { result?: { config?: { params?: { vectors?: { size?: number } } }; points_count?: number } };
        const size = info.result?.config?.params?.vectors?.size;
        const count = info.result?.points_count ?? 0;
        if (typeof size === 'number' && size !== vector.length) {
          if (count > 0) {
            console.warn(`Qdrant sync skipped for task ${taskId}: collection is ${size}-dim but embedding is ${vector.length}-dim (not recreating populated data)`);
            return;
          }
          await fetch(`${base}/collections/${collection}`, { method: 'DELETE', headers });
          await fetch(`${base}/collections/${collection}`, {
            method: 'PUT',
            headers,
            body: JSON.stringify({ vectors: { size: vector.length, distance: 'Cosine' } }),
          });
        }
      } else {
        console.warn(`Qdrant sync failed for task ${taskId}: collection check ${checkRes.status}`);
        return;
      }

      const payload = {
        points: [
          {
            id: pointIdForTask(taskId),
            vector,
            payload: { task_id: taskId, machine_id: machineId, agent_type: agentType, timestamp: new Date().toISOString(), content_excerpt: excerpt },
          },
        ],
      };
      const upsertRes = await fetch(`${base}/collections/${collection}/points`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(payload),
      });
      if (!upsertRes.ok) {
        console.warn(`Qdrant sync failed for task ${taskId}: upsert ${upsertRes.status}`);
        return;
      }
      console.log(`Memory synced: task ${taskId} → Qdrant`);
    } catch (e) {
      console.warn(`Qdrant sync error for task ${taskId}:`, e);
    }
  }

  private writeOKFConcept(task: any, machineId: string, agentType: string): void {
    // OKF is a rebuildable projection: a missing/dangling knowledge base must not
    // fail the whole sync (this is synchronous, so an uncaught throw would reject
    // onTaskCompleted before Promise.allSettled can isolate it).
    try {
      fs.mkdirSync(this.okfTasksDir, { recursive: true });
      const filePath = path.join(this.okfTasksDir, `${task.id}.md`);
      const description = (task.description || task.title || '').slice(0, 200);
      const frontmatter = [
        '---',
        `type: CompletedTask`,
        `title: ${yamlScalar(task.title || '')}`,
        `description: ${yamlScalar(description)}`,
        `resource: http://192.168.1.28:3001/api/tasks/${task.id}`,
        `tags: [${machineId}, ${agentType}, ${task.status}]`,
        `timestamp: ${new Date().toISOString()}`,
        `trust_level: agent_generated`,
        '---',
      ].join('\n');

      const body = [
        `# ${task.title || task.id}`,
        '',
        `**Status**: ${task.status}`,
        `**Machine**: ${machineId}`,
        `**Agent type**: ${agentType}`,
        `**Created**: ${task.created_at}`,
        `**Completed**: ${task.completed_at || 'N/A'}`,
        '',
        '## Description',
        '',
        task.description || '_No description_',
        '',
      ].join('\n');

      fs.writeFileSync(filePath, `${frontmatter}\n\n${body}\n`, 'utf8');
      console.log(`OKF concept written: tasks/${task.id}.md`);
    } catch (e) {
      console.warn(`OKF concept write failed for task ${task.id}:`, e instanceof Error ? e.message : String(e));
    }
  }
}
