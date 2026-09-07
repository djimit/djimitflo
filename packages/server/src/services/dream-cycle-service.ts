import { createHash } from 'crypto';
import type { Database } from 'better-sqlite3';

export interface DreamOpportunity {
  id: string;
  capabilityId: string;
  score: number;
  kind: 'improve' | 'create' | 'evaluate';
  title: string;
  rationale: string;
  suggestedAction: string;
  status: 'proposed';
}

/**
 * Ranks capability leverage and records bounded proposals. It never executes
 * code, mutates capability state, or bypasses Paperclip approval.
 */
export class DreamCycleService {
  constructor(private readonly db: Database) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS dream_opportunities (
      id TEXT PRIMARY KEY, capability_id TEXT NOT NULL, score REAL NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('improve','create','evaluate')),
      title TEXT NOT NULL, rationale TEXT NOT NULL, suggested_action TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'proposed' CHECK(status = 'proposed'),
      dedupe_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    ); CREATE INDEX IF NOT EXISTS idx_dream_opportunities_score ON dream_opportunities(score DESC);`);
  }

  runCycle(limit = 10): DreamOpportunity[] {
    const capabilities = this.db.prepare(
      `SELECT id, kind, status, eval_score, eval_threshold, risk_ceiling
       FROM swarm_capabilities WHERE status IN ('candidate','validated') ORDER BY eval_score ASC LIMIT 200`
    ).all() as Array<{ id: string; kind: string; status: string; eval_score: number; eval_threshold: number; risk_ceiling: string }>;
    const result: DreamOpportunity[] = [];
    for (const capability of capabilities) {
      const stats = this.db.prepare('SELECT COUNT(*) AS total, COALESCE(AVG(success), 0) AS success_rate FROM skill_outcomes WHERE skill_id = ?').get(capability.id) as { total: number; success_rate: number };
      const gap = Math.max(0, (capability.eval_threshold || 0.8) - (capability.eval_score || 0));
      const failureSignal = stats.total > 0 ? 1 - Number(stats.success_rate) : 0.35;
      const evidenceSignal = stats.total < 3 ? 0.25 : 0;
      const score = Number((gap * 0.55 + failureSignal * 0.3 + evidenceSignal * 0.15).toFixed(4));
      const kind = stats.total < 3 ? 'evaluate' : gap > 0 ? 'improve' : 'create';
      const title = `${kind === 'improve' ? 'Improve' : kind === 'evaluate' ? 'Evaluate' : 'Extend'} capability ${capability.id}`;
      const rationale = `leverage=${score.toFixed(4)} gap=${gap.toFixed(3)} success_rate=${Number(stats.success_rate).toFixed(3)} observations=${stats.total}`;
      const suggestedAction = kind === 'evaluate' ? 'Run an independent OpenMythos/DAPS evaluation with baseline and holdout evidence.' : kind === 'improve' ? 'Design the smallest isolated change, then require independent review and outcome measurement.' : 'Draft a bounded capability proposal only after a demonstrated capability gap.';
      const dedupeKey = createHash('sha256').update(`${capability.id}:${capability.status}:${kind}`).digest('hex');
      const id = `dream:${dedupeKey.slice(0, 24)}`;
      this.db.prepare(`INSERT INTO dream_opportunities
        (id, capability_id, score, kind, title, rationale, suggested_action, dedupe_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(dedupe_key) DO UPDATE SET
          score = excluded.score,
          title = excluded.title,
          rationale = excluded.rationale,
          suggested_action = excluded.suggested_action`).run(id, capability.id, score, kind, title, rationale, suggestedAction, dedupeKey);
      result.push({ id, capabilityId: capability.id, score, kind, title, rationale, suggestedAction, status: 'proposed' });
    }
    return result.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  list(limit = 20): DreamOpportunity[] {
    return this.db.prepare('SELECT id, capability_id capabilityId, score, kind, title, rationale, suggested_action suggestedAction, status FROM dream_opportunities ORDER BY score DESC LIMIT ?').all(limit) as DreamOpportunity[];
  }
}
