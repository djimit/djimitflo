import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { createHash } from 'crypto';
import type { Database } from 'better-sqlite3';
import type { DreamOpportunity } from './dream-cycle-service';

export interface DreamTaskEnvelope {
  event: 'dream.opportunity'; task_title: string; task_type: 'skill_candidate' | 'triage';
  priority: 'low' | 'medium' | 'high'; severity: 'low' | 'medium' | 'high';
  status: 'backlog'; dedupe_key: string; summary: string; context: string;
  assignee_role: 'skill-factory-agent' | 'architecture/security-reviewer';
  labels: string[]; metadata: Record<string, unknown>;
}

/** Converts inert dream proposals into idempotent Paperclip-ready backlog events. */
export class DreamTaskPlannerService {
  constructor(private readonly db: Database) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS dream_task_emissions (
      dedupe_key TEXT PRIMARY KEY, opportunity_id TEXT NOT NULL, emitted_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
  }

  plan(limit = 3, minScore = 0.25): DreamTaskEnvelope[] {
    const rows = this.db.prepare(`SELECT id, capability_id capabilityId, score, kind, title, rationale,
      suggested_action suggestedAction, status FROM dream_opportunities WHERE status = 'proposed' AND score >= ?
      ORDER BY score DESC LIMIT ?`).all(minScore, Math.max(1, Math.min(limit, 10))) as DreamOpportunity[];
    const insert = this.db.prepare('INSERT OR IGNORE INTO dream_task_emissions (dedupe_key, opportunity_id) VALUES (?, ?)');
    const planned: DreamTaskEnvelope[] = [];
    for (const opportunity of rows) {
      const dedupeKey = `dream-task:${createHash('sha256').update(opportunity.id).digest('hex').slice(0, 24)}`;
      if (!insert.run(dedupeKey, opportunity.id).changes) continue;
      const evaluate = opportunity.kind === 'evaluate';
      const priority = opportunity.score >= 0.5 ? 'high' : opportunity.score >= 0.35 ? 'medium' : 'low';
      planned.push({
        event: 'dream.opportunity', task_title: opportunity.title,
        task_type: evaluate ? 'triage' : 'skill_candidate', priority, severity: priority,
        status: 'backlog', dedupe_key: dedupeKey,
        summary: opportunity.rationale,
        context: `${opportunity.suggestedAction} Capability=${opportunity.capabilityId}. This is an inert proposal; Paperclip/DAPS/OpenMythos gates remain authoritative.`,
        assignee_role: evaluate ? 'architecture/security-reviewer' : 'skill-factory-agent',
        labels: ['dream-cycle', 'paperclip-ready', evaluate ? 'evaluation' : 'capability-improvement'],
        metadata: { source: 'djimitflo.dream_cycle', opportunity_id: opportunity.id, capability_id: opportunity.capabilityId, score: opportunity.score, execution_tier: 'A2', human_required: true },
      });
    }
    return planned;
  }

  exportPending(path = process.env.DENNIS_AGENT_PAPERCLIP_PENDING || `${process.env.HOME || '/tmp'}/.djimit/roborev/paperclip-tasks.pending.jsonl`, limit = 3, minScore = 0.25): number {
    const tasks = this.plan(limit, minScore);
    if (!tasks.length) return 0;
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, tasks.map(task => JSON.stringify(task)).join('\n') + '\n', 'utf8');
    return tasks.length;
  }
}
