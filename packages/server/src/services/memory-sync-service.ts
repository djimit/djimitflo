import type { Database } from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const OKF_BASE = process.env.OKF_BASE || path.resolve(__dirname, '../../../knowledge');
const UAMS_URL = process.env.UAMS_URL || 'http://192.168.1.28:8000';
const QDRANT_URL = process.env.QDRANT_URL || 'http://192.168.1.28:6333';

export class MemorySyncService {
  private db: Database;
  private okfTasksDir: string;

  constructor(db: Database) {
    this.db = db;
    this.okfTasksDir = path.join(OKF_BASE, 'tasks');
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
      this.writeOKFConcept(task, machineId, agentType),
    ]);
  }

  private async syncToUAMS(taskId: string, content: string, machineId: string, agentType: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`${UAMS_URL}/memory`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: content.slice(0, 2000),
            tags: [`machine_id:${machineId}`, `agent_type:${agentType}`, `task_id:${taskId}`],
          }),
        });
        if (res.ok) {
          console.log(`Memory synced: task ${taskId} → UAMS`);
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
    const payload = {
      points: [
        {
          id: taskId,
          vector: [], // will be filled by embedding pipeline
          payload: { task_id: taskId, machine_id: machineId, agent_type: agentType, timestamp: new Date().toISOString(), content_excerpt: excerpt },
        },
      ],
    };

    try {
      // Check if collection exists, create if not
      const checkRes = await fetch(`${QDRANT_URL}/collections/djimitflo_swarm`);
      if (checkRes.status === 404) {
        await fetch(`${QDRANT_URL}/collections/djimitflo_swarm`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vectors: { size: 384, distance: 'Cosine' } }),
        });
      }

      // Upsert point (vector will be zero-filled until embedding pipeline runs)
      await fetch(`${QDRANT_URL}/collections/djimitflo_swarm/points`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      console.log(`Memory synced: task ${taskId} → Qdrant`);
    } catch (e) {
      console.warn(`Qdrant sync error for task ${taskId}:`, e);
    }
  }

  private writeOKFConcept(task: any, machineId: string, agentType: string): void {
    fs.mkdirSync(this.okfTasksDir, { recursive: true });
    const filePath = path.join(this.okfTasksDir, `${task.id}.md`);
    const description = (task.description || task.title || '').slice(0, 200);
    const frontmatter = [
      '---',
      `type: CompletedTask`,
      `title: "${(task.title || '').replace(/"/g, '\\"')}"`,
      `description: "${description.replace(/"/g, '\\"')}"`,
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
  }
}