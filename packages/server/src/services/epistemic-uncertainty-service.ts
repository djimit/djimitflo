import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

export interface UncertaintyRecord {
  id: string;
  domain: string;
  uncertainty: number;
  reason: string;
  timestamp: string;
}

export interface HallucinationFlag {
  id: string;
  claimRef: string;
  reason: string;
  confidence: number;
  timestamp: string;
}

export interface KnowledgeGap {
  id: string;
  domain: string;
  description: string;
  priority: number;
  status: 'open' | 'addressing' | 'closed';
}

interface UncertaintyRow {
  id: string;
  domain: string;
  uncertainty: number;
  reason: string;
  created_at: string;
}

interface GapRow {
  id: string;
  domain: string;
  description: string;
  priority: number;
  status: string;
  created_at: string;
}

export class EpistemicUncertaintyService {
  constructor(private db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS uncertainty_log (
        id TEXT PRIMARY KEY,
        domain TEXT NOT NULL,
        uncertainty REAL NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hallucination_flags (
        id TEXT PRIMARY KEY,
        claim_ref TEXT NOT NULL,
        reason TEXT NOT NULL,
        confidence REAL NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_gaps (
        id TEXT PRIMARY KEY,
        domain TEXT NOT NULL,
        description TEXT NOT NULL,
        priority REAL NOT NULL DEFAULT 0.5,
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  assessUncertainty(domain: string, sampleSize: number, successRate: number): number {
    const sampleUncertainty = sampleSize < 5 ? 0.5 : Math.max(0, 0.3 - sampleSize * 0.01);
    const rateUncertainty = Math.abs(successRate - 0.5) < 0.2 ? 0.3 : 0;
    const total = Math.min(1, sampleUncertainty + rateUncertainty);

    this.db.prepare(`
      INSERT INTO uncertainty_log (id, domain, uncertainty, reason)
      VALUES (?, ?, ?, ?)
    `).run(randomUUID(), domain, total, `sample_size=${sampleSize}, success_rate=${successRate}`);

    return total;
  }

  flagHallucination(claimRef: string, reason: string, confidence: number): HallucinationFlag {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO hallucination_flags (id, claim_ref, reason, confidence)
      VALUES (?, ?, ?, ?)
    `).run(id, claimRef, reason, confidence);
    return { id, claimRef, reason, confidence, timestamp: now };
  }

  detectHallucinations(claimRef: string, evidenceRefs: string[]): HallucinationFlag[] {
    const flags: HallucinationFlag[] = [];

    if (evidenceRefs.length === 0) {
      flags.push(this.flagHallucination(claimRef, 'no_evidence', 0.8));
    }

    const claim = this.db.prepare('SELECT confidence FROM swarm_claims WHERE id = ?').get(claimRef) as { confidence: number } | undefined;
    if (claim && claim.confidence > 0.9 && evidenceRefs.length < 2) {
      flags.push(this.flagHallucination(claimRef, 'high_confidence_low_evidence', 0.6));
    }

    return flags;
  }

  identifyKnowledgeGap(domain: string, description: string): KnowledgeGap {
    const id = randomUUID();

    const existingCount = this.db.prepare('SELECT COUNT(*) as c FROM worker_leases WHERE capability_id = ?').get(domain) as { c: number };
    const priority = existingCount.c === 0 ? 0.9 : 0.5;

    this.db.prepare(`
      INSERT INTO knowledge_gaps (id, domain, description, priority, status)
      VALUES (?, ?, ?, ?, 'open')
    `).run(id, domain, description, priority);

    return { id, domain, description, priority, status: 'open' };
  }

  getKnowledgeGaps(status: string = 'open'): KnowledgeGap[] {
    const rows = this.db.prepare('SELECT * FROM knowledge_gaps WHERE status = ? ORDER BY priority DESC').all(status) as GapRow[];
    return rows.map(r => ({ id: r.id, domain: r.domain, description: r.description, priority: r.priority, status: r.status as KnowledgeGap['status'] }));
  }

  getUncertaintyHistory(domain: string, limit: number = 10): UncertaintyRecord[] {
    const rows = this.db.prepare('SELECT * FROM uncertainty_log WHERE domain = ? ORDER BY created_at DESC LIMIT ?').all(domain, limit) as UncertaintyRow[];
    return rows.map(r => ({ id: r.id, domain: r.domain, uncertainty: r.uncertainty, reason: r.reason, timestamp: r.created_at }));
  }

  addressGap(gapId: string): void {
    this.db.prepare("UPDATE knowledge_gaps SET status = 'addressing' WHERE id = ?").run(gapId);
  }

  closeGap(gapId: string): void {
    this.db.prepare("UPDATE knowledge_gaps SET status = 'closed' WHERE id = ?").run(gapId);
  }
}
