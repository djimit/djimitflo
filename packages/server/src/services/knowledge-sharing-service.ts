/**
 * KnowledgeSharingService — inter-agent knowledge graph with contradiction detection.
 *
 * Agents publish learned patterns, subscribe to relevant topics,
 * and reach consensus on conflicting information.
 *
 * Protocol:
 * 1. PUBLISH — Agent shares a learned pattern/fact
 * 2. SUBSCRIBE — Agent subscribes to topics
 * 3. QUERY — Agent queries shared knowledge
 * 4. CONTRADICT — System detects and flags contradictions
 * 5. CONSENSUS — Agents vote on conflicting claims
 */

import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

interface KnowledgeClaim {
  id: string;
  agentId: string;
  topic: string;
  claim: string;
  confidence: number;
  evidence: string[];
  status: 'active' | 'contradicted' | 'confirmed' | 'superseded';
  votes: { agentId: string; agree: boolean; reason: string }[];
  createdAt: string;
}

interface AgentSubscription {
  agentId: string;
  topic: string;
  priority: number;
}

export class KnowledgeSharingService {
  constructor(private db: Database) {
    this.ensureTables();
  }

  /**
   * Publish a knowledge claim.
   */
  publish(input: {
    agentId: string;
    topic: string;
    claim: string;
    confidence?: number;
    evidence?: string[];
  }): KnowledgeClaim {
    const claim: KnowledgeClaim = {
      id: randomUUID(),
      agentId: input.agentId,
      topic: input.topic,
      claim: input.claim,
      confidence: input.confidence ?? 0.7,
      evidence: input.evidence || [],
      status: 'active',
      votes: [],
      createdAt: new Date().toISOString(),
    };

    this.db.prepare(`
      INSERT INTO knowledge_claims (id, agent_id, topic, claim, confidence, evidence_json, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
    `).run(claim.id, claim.agentId, claim.topic, claim.claim, claim.confidence, JSON.stringify(claim.evidence), claim.createdAt);

    // Check for contradictions
    this.detectContradictions(claim);

    return claim;
  }

  /**
   * Subscribe an agent to a topic.
   */
  subscribe(agentId: string, topic: string, priority = 3): AgentSubscription {
    const subscription: AgentSubscription = { agentId, topic, priority };

    this.db.prepare(`
      INSERT OR REPLACE INTO agent_subscriptions (agent_id, topic, priority, subscribed_at)
      VALUES (?, ?, ?, ?)
    `).run(agentId, topic, priority, new Date().toISOString());

    return subscription;
  }

  /**
   * Query knowledge by topic.
   */
  query(topic: string, minConfidence = 0.5): KnowledgeClaim[] {
    return (this.db.prepare(`
      SELECT * FROM knowledge_claims
      WHERE topic = ? AND confidence >= ? AND status = 'active'
      ORDER BY confidence DESC, created_at DESC
    `).all(topic, minConfidence) as any[]).map(parseClaim);
  }

  /**
   * Vote on a knowledge claim.
   */
  vote(claimId: string, agentId: string, agree: boolean, reason: string): void {
    const claim = this.getClaim(claimId);
    if (!claim) return;

    claim.votes.push({ agentId, agree, reason });

    // Update status based on votes
    const agreeVotes = claim.votes.filter((v) => v.agree).length;
    const totalVotes = claim.votes.length;

    if (totalVotes >= 3) {
      const ratio = agreeVotes / totalVotes;
      if (ratio >= 0.7) claim.status = 'confirmed';
      else if (ratio <= 0.3) claim.status = 'contradicted';
    }

    this.db.prepare(`
      UPDATE knowledge_claims SET status = ?, votes_json = ? WHERE id = ?
    `).run(claim.status, JSON.stringify(claim.votes), claimId);
  }

  /**
   * Get all contradictions.
   */
  getContradictions(): Array<{ claim: KnowledgeClaim; contradicting: KnowledgeClaim[] }> {
    const contradicted = (this.db.prepare(`
      SELECT * FROM knowledge_claims WHERE status = 'contradicted'
    `).all() as any[]).map(parseClaim);

    return contradicted.map((claim) => ({
      claim,
      contradicting: this.findContradictingClaims(claim),
    }));
  }

  /**
   * Get statistics.
   */
  getStats(): {
    totalClaims: number;
    confirmed: number;
    contradicted: number;
    active: number;
    totalSubscriptions: number;
  } {
    const claims = this.db.prepare('SELECT * FROM knowledge_claims').all() as any[];
    const subs = (this.db.prepare('SELECT COUNT(*) as c FROM agent_subscriptions').get() as any)?.c || 0;

    return {
      totalClaims: claims.length,
      confirmed: claims.filter((c: any) => c.status === 'confirmed').length,
      contradicted: claims.filter((c: any) => c.status === 'contradicted').length,
      active: claims.filter((c: any) => c.status === 'active').length,
      totalSubscriptions: subs,
    };
  }

  // ─── Private ──────────────────────────────────────────────────────────

  private getClaim(id: string): KnowledgeClaim | null {
    const row = this.db.prepare('SELECT * FROM knowledge_claims WHERE id = ?').get(id) as any;
    return row ? parseClaim(row) : null;
  }

  private detectContradictions(newClaim: KnowledgeClaim): void {
    const existingClaims = this.query(newClaim.topic, 0);

    for (const existing of existingClaims) {
      if (existing.id === newClaim.id) continue;

      // Simple contradiction detection: opposing keywords
      const opposingPatterns = [
        ['is', 'is not'],
        ['should', 'should not'],
        ['always', 'never'],
        ['increases', 'decreases'],
      ];

      for (const [pos, neg] of opposingPatterns) {
        const newHasPos = newClaim.claim.toLowerCase().includes(pos);
        const newHasNeg = newClaim.claim.toLowerCase().includes(neg);
        const existHasPos = existing.claim.toLowerCase().includes(pos);
        const existHasNeg = existing.claim.toLowerCase().includes(neg);

        if ((newHasPos && existHasNeg) || (newHasNeg && existHasPos)) {
          this.db.prepare("UPDATE knowledge_claims SET status = 'contradicted' WHERE id = ? OR id = ?")
            .run(newClaim.id, existing.id);
          break;
        }
      }
    }
  }

  private findContradictingClaims(claim: KnowledgeClaim): KnowledgeClaim[] {
    return this.query(claim.topic, 0).filter((c) => c.id !== claim.id && c.status === 'contradicted');
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_claims (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        topic TEXT NOT NULL,
        claim TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.7,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'active',
        votes_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS agent_subscriptions (
        agent_id TEXT NOT NULL,
        topic TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 3,
        subscribed_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (agent_id, topic)
      );

      CREATE INDEX IF NOT EXISTS idx_knowledge_claims_topic ON knowledge_claims(topic);
      CREATE INDEX IF NOT EXISTS idx_knowledge_claims_status ON knowledge_claims(status);
    `);
  }
}

function parseClaim(row: any): KnowledgeClaim {
  return {
    id: row.id,
    agentId: row.agent_id,
    topic: row.topic,
    claim: row.claim,
    confidence: row.confidence,
    evidence: JSON.parse(row.evidence_json || '[]'),
    status: row.status,
    votes: JSON.parse(row.votes_json || '[]'),
    createdAt: row.created_at,
  };
}
