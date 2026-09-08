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
      dedupe_key TEXT PRIMARY KEY, opportunity_id TEXT NOT NULL, envelope_json TEXT, exported_at TEXT,
      emitted_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    try { this.db.exec('ALTER TABLE dream_task_emissions ADD COLUMN envelope_json TEXT'); } catch { /* existing schema */ }
    try { this.db.exec('ALTER TABLE dream_task_emissions ADD COLUMN exported_at TEXT'); } catch { /* existing schema */ }
  }

  plan(limit = 3, minScore = 0.25): DreamTaskEnvelope[] {
    const rows = this.db.prepare(`SELECT id, capability_id capabilityId, score, kind, title, rationale,
      suggested_action suggestedAction, status FROM dream_opportunities WHERE status = 'proposed' AND score >= ?
      ORDER BY score DESC LIMIT ?`).all(minScore, Math.max(1, Math.min(limit, 10))) as DreamOpportunity[];
    const insert = this.db.prepare('INSERT OR IGNORE INTO dream_task_emissions (dedupe_key, opportunity_id) VALUES (?, ?)');
    const planned: DreamTaskEnvelope[] = [];
    for (const opportunity of rows) {
      const dedupeKey = `dream-task:${createHash('sha256').update(opportunity.id).digest('hex').slice(0, 24)}`;
      const evaluate = opportunity.kind === 'evaluate';
      const priority = opportunity.score >= 0.5 ? 'high' : opportunity.score >= 0.35 ? 'medium' : 'low';
      const envelope: DreamTaskEnvelope = {
        event: 'dream.opportunity', task_title: opportunity.title,
        task_type: evaluate ? 'triage' : 'skill_candidate', priority, severity: priority,
        status: 'backlog', dedupe_key: dedupeKey,
        summary: opportunity.rationale,
        context: `${opportunity.suggestedAction} Capability=${opportunity.capabilityId}. This is an inert proposal; Paperclip/DAPS/OpenMythos gates remain authoritative.`,
        assignee_role: evaluate ? 'architecture/security-reviewer' : 'skill-factory-agent',
        labels: ['dream-cycle', 'paperclip-ready', evaluate ? 'evaluation' : 'capability-improvement'],
        metadata: {
          source: 'djimitflo.dream_cycle', opportunity_id: opportunity.id,
          capability_id: opportunity.capabilityId, score: opportunity.score,
          execution_tier: 'A2', human_required: true, reversible: true,
          research_protocol: {
            question: `Does independently evaluating ${opportunity.capabilityId} close the observed evidence gap?`,
            null_hypothesis: `Independent evaluation does not materially change the evidence status of ${opportunity.capabilityId}.`,
            falsification_criteria: ['No reproducible delta from baseline', 'Required attribution or holdout evidence is missing'],
            budget: { max_replications: 30, max_failures: 2 },
          },
        },
      };
      const inserted = insert.run(dedupeKey, opportunity.id);
      if (inserted.changes) {
        this.db.prepare('UPDATE dream_task_emissions SET envelope_json = ? WHERE dedupe_key = ?').run(JSON.stringify(envelope), dedupeKey);
        planned.push(envelope);
      }
      else if (!(this.db.prepare('SELECT envelope_json FROM dream_task_emissions WHERE dedupe_key = ?').get(dedupeKey) as { envelope_json?: string } | undefined)?.envelope_json) {
        this.db.prepare('UPDATE dream_task_emissions SET envelope_json = ? WHERE dedupe_key = ?').run(JSON.stringify(envelope), dedupeKey);
        planned.push(envelope);
      }
      else if (!(this.db.prepare('SELECT exported_at FROM dream_task_emissions WHERE dedupe_key = ?').get(dedupeKey) as { exported_at?: string } | undefined)?.exported_at) planned.push(envelope);
    }
    return planned;
  }

  exportPending(path = process.env.DENNIS_AGENT_PAPERCLIP_PENDING || `${process.env.HOME || '/tmp'}/.djimit/roborev/paperclip-tasks.pending.jsonl`, limit = 1, minScore = 0.25): number {
    const tasks = this.plan(limit, minScore);
    if (!tasks.length) return 0;
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, tasks.map(task => JSON.stringify(task)).join('\n') + '\n', 'utf8');
    const now = new Date().toISOString();
    for (const task of tasks) this.db.prepare('UPDATE dream_task_emissions SET exported_at = ? WHERE dedupe_key = ?').run(now, task.dedupe_key);
    return tasks.length;
  }
}
