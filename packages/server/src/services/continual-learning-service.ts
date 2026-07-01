import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

export interface ExperienceRecord {
  id: string;
  capabilityId: string;
  context: Record<string, unknown>;
  outcome: 'success' | 'failure';
  embedding: string;
  createdAt: string;
}

export interface TransferOpportunity {
  id: string;
  sourceDomain: string;
  targetDomain: string;
  similarity: number;
  applied: boolean;
}

interface ExperienceRow {
  id: string;
  capability_id: string;
  context_json: string;
  outcome: string;
  embedding: string;
  created_at: string;
}

interface TransferRow {
  id: string;
  source_domain: string;
  target_domain: string;
  similarity: number;
  applied: number;
  created_at: string;
}

export class ContinualLearningService {
  private replayBufferSize = 100;
  public forgettingThreshold = 0.3;

  constructor(private db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS experience_replay_buffer (
        id TEXT PRIMARY KEY,
        capability_id TEXT NOT NULL,
        context_json TEXT NOT NULL DEFAULT '{}',
        outcome TEXT NOT NULL,
        embedding TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS transfer_opportunities (
        id TEXT PRIMARY KEY,
        source_domain TEXT NOT NULL,
        target_domain TEXT NOT NULL,
        similarity REAL NOT NULL DEFAULT 0,
        applied INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_experience_cap ON experience_replay_buffer(capability_id)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_transfer_source ON transfer_opportunities(source_domain)');
  }

  storeExperience(capabilityId: string, context: Record<string, unknown>, outcome: 'success' | 'failure'): ExperienceRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    const embedding = JSON.stringify(context);

    this.db.prepare(`
      INSERT INTO experience_replay_buffer (id, capability_id, context_json, outcome, embedding)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, capabilityId, JSON.stringify(context), outcome, embedding);

    this.pruneBuffer();

    return { id, capabilityId, context, outcome, embedding, createdAt: now };
  }

  replayExperiences(capabilityId: string, limit: number = 10): ExperienceRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM experience_replay_buffer
      WHERE capability_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(capabilityId, limit) as ExperienceRow[];
    return rows.map(r => ({
      id: r.id,
      capabilityId: r.capability_id,
      context: JSON.parse(r.context_json) as Record<string, unknown>,
      outcome: r.outcome as 'success' | 'failure',
      embedding: r.embedding,
      createdAt: r.created_at,
    }));
  }

  detectTransferOpportunities(): TransferOpportunity[] {
    const capabilities = this.db.prepare(
      'SELECT id, metadata FROM swarm_capabilities'
    ).all() as Array<{ id: string; metadata: string }>;

    const opportunities: TransferOpportunity[] = [];

    for (let i = 0; i < capabilities.length; i++) {
      for (let j = i + 1; j < capabilities.length; j++) {
        const sim = this.calculateSimilarity(capabilities[i].id, capabilities[j].id);
        if (sim > 0.5) {
          const id = randomUUID();
          this.db.prepare(`
            INSERT OR IGNORE INTO transfer_opportunities (id, source_domain, target_domain, similarity)
            VALUES (?, ?, ?, ?)
          `).run(id, capabilities[i].id, capabilities[j].id, sim);
          opportunities.push({ id, sourceDomain: capabilities[i].id, targetDomain: capabilities[j].id, similarity: sim, applied: false });
        }
      }
    }

    return opportunities;
  }

  applyTransfer(sourceDomain: string, targetDomain: string): boolean {
    const sourceExp = this.replayExperiences(sourceDomain, 5);
    if (sourceExp.length === 0) return false;

    for (const exp of sourceExp) {
      this.storeExperience(targetDomain, { ...exp.context, transferred: true }, exp.outcome);
    }

    this.db.prepare(
      'UPDATE transfer_opportunities SET applied = 1 WHERE source_domain = ? AND target_domain = ?'
    ).run(sourceDomain, targetDomain);

    return true;
  }

  measureForgetting(capabilityId: string): number {
    const recent = this.db.prepare(`
      SELECT outcome FROM experience_replay_buffer
      WHERE capability_id = ?
      ORDER BY created_at DESC LIMIT 10
    `).all(capabilityId) as Array<{ outcome: string }>;

    const old = this.db.prepare(`
      SELECT outcome FROM experience_replay_buffer
      WHERE capability_id = ?
      ORDER BY created_at ASC LIMIT 10
    `).all(capabilityId) as Array<{ outcome: string }>;

    const recentRate = recent.filter(r => r.outcome === 'success').length / Math.max(1, recent.length);
    const oldRate = old.filter(r => r.outcome === 'success').length / Math.max(1, old.length);

    return Math.max(0, oldRate - recentRate);
  }

  getTransferHistory(limit: number = 20): TransferOpportunity[] {
    const rows = this.db.prepare('SELECT * FROM transfer_opportunities ORDER BY similarity DESC LIMIT ?').all(limit) as TransferRow[];
    return rows.map(r => ({ id: r.id, sourceDomain: r.source_domain, targetDomain: r.target_domain, similarity: r.similarity, applied: r.applied === 1 }));
  }

  private pruneBuffer(): void {
    const count = this.db.prepare('SELECT COUNT(*) as c FROM experience_replay_buffer').get() as { c: number };
    if (count.c > this.replayBufferSize) {
      this.db.prepare(`
        DELETE FROM experience_replay_buffer
        WHERE id IN (SELECT id FROM experience_replay_buffer ORDER BY created_at ASC LIMIT ?)
      `).run(count.c - this.replayBufferSize);
    }
  }

  private calculateSimilarity(a: string, b: string): number {
    const aWords = new Set(a.toLowerCase().split(/[-_]/));
    const bWords = new Set(b.toLowerCase().split(/[-_]/));
    let intersection = 0;
    for (const w of aWords) { if (bWords.has(w)) intersection++; }
    const union = aWords.size + bWords.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }
}
