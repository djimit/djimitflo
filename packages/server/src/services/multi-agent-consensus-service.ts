/**
 * MultiAgentConsensusService — structured debate and consensus mechanism.
 *
 * Agents propose solutions, debate merits, and reach consensus through:
 * 1. Proposal phase — each agent submits a solution
 * 2. Debate phase — agents critique each other's proposals
 * 3. Voting phase — weighted voting based on agent expertise
 * 4. Resolution phase — consensus or escalation
 *
 * Inspired by:
 * - Constitutional AI (Anthropic) — structured self-critique
 * - Federated learning — weighted aggregation
 * - Deliberative democracy — structured debate protocols
 */

import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

type ConsensusStatus = 'proposing' | 'debating' | 'voting' | 'resolved' | 'escalated';
type VoteType = 'strong_agree' | 'agree' | 'neutral' | 'disagree' | 'strong_disagree';

interface Proposal {
  id: string;
  debateId: string;
  agentId: string;
  content: string;
  evidence: string[];
  confidence: number;
  votes: Vote[];
  score: number;
  createdAt: string;
}

interface Vote {
  agentId: string;
  proposalId: string;
  type: VoteType;
  reason: string;
  weight: number;
  timestamp: string;
}

interface Debate {
  id: string;
  topic: string;
  context: string;
  status: ConsensusStatus;
  proposals: Proposal[];
  winningProposalId?: string;
  consensusScore: number;
  createdAt: string;
  resolvedAt?: string;
}

export class MultiAgentConsensusService {
  constructor(private db: Database) {
    this.ensureTables();
  }

  /**
   * Initiate a new consensus debate.
   */
  createDebate(topic: string, context: string): Debate {
    const debate: Debate = {
      id: randomUUID(),
      topic,
      context,
      status: 'proposing',
      proposals: [],
      consensusScore: 0,
      createdAt: new Date().toISOString(),
    };

    this.db.prepare(`
      INSERT INTO consensus_debates (id, topic, context, status, created_at)
      VALUES (?, ?, ?, 'proposing', ?)
    `).run(debate.id, topic, context, debate.createdAt);

    return debate;
  }

  /**
   * Submit a proposal to the debate.
   */
  submitProposal(debateId: string, agentId: string, content: string, evidence: string[] = [], confidence = 0.7): Proposal {
    const proposal: Proposal = {
      id: randomUUID(),
      debateId,
      agentId,
      content,
      evidence,
      confidence,
      votes: [],
      score: 0,
      createdAt: new Date().toISOString(),
    };

    this.db.prepare(`
      INSERT INTO consensus_proposals (id, debate_id, agent_id, content, evidence_json, confidence, score, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?)
    `).run(proposal.id, debateId, agentId, content, JSON.stringify(evidence), confidence, proposal.createdAt);

    return proposal;
  }

  /**
   * Cast a vote on a proposal.
   */
  vote(debateId: string, proposalId: string, agentId: string, type: VoteType, reason: string): void {
    const weight = this.calculateVoteWeight(agentId, proposalId);
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO consensus_votes (id, debate_id, proposal_id, agent_id, type, reason, weight, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), debateId, proposalId, agentId, type, reason, weight, now);

    // Update proposal score
    this.updateProposalScore(proposalId);
  }

  /**
   * Resolve the debate — determine consensus.
   */
  resolve(debateId: string): {
    debateId: string;
    winningProposalId: string | null;
    consensusScore: number;
    status: ConsensusStatus;
  } {
    const proposals = this.db.prepare(`
      SELECT * FROM consensus_proposals WHERE debate_id = ? ORDER BY score DESC
    `).all(debateId) as any[];

    if (proposals.length === 0) {
      return { debateId, winningProposalId: null, consensusScore: 0, status: 'escalated' };
    }

    const winner = proposals[0];
    const consensusScore = winner.score;

    // Determine if consensus is strong enough
    const status: ConsensusStatus = consensusScore >= 0.6 ? 'resolved' : 'escalated';

    this.db.prepare(`
      UPDATE consensus_debates SET status = ?, winning_proposal_id = ?, consensus_score = ?, resolved_at = ?
      WHERE id = ?
    `).run(status, winner.id, consensusScore, new Date().toISOString(), debateId);

    return { debateId, winningProposalId: winner.id, consensusScore, status };
  }

  /**
   * Get debate status.
   */
  getDebate(debateId: string): Debate | null {
    const row = this.db.prepare('SELECT * FROM consensus_debates WHERE id = ?').get(debateId) as any;
    if (!row) return null;

    const proposals = (this.db.prepare('SELECT * FROM consensus_proposals WHERE debate_id = ?').all(debateId) as any[]).map((p) => ({
      id: p.id,
      debateId: p.debate_id,
      agentId: p.agent_id,
      content: p.content,
      evidence: JSON.parse(p.evidence_json || '[]'),
      confidence: p.confidence,
      votes: (this.db.prepare('SELECT * FROM consensus_votes WHERE proposal_id = ?').all(p.id) as any[]).map((v) => ({
        agentId: v.agent_id,
        proposalId: v.proposal_id,
        type: v.type,
        reason: v.reason,
        weight: v.weight,
        timestamp: v.timestamp,
      })),
      score: p.score,
      createdAt: p.created_at,
    }));

    return {
      id: row.id,
      topic: row.topic,
      context: row.context,
      status: row.status,
      proposals,
      winningProposalId: row.winning_proposal_id,
      consensusScore: row.consensus_score,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
    };
  }

  /**
   * Get statistics.
   */
  getStats(): {
    totalDebates: number;
    resolved: number;
    escalated: number;
    avgConsensusScore: number;
    totalProposals: number;
    totalVotes: number;
  } {
    const debates = (this.db.prepare('SELECT COUNT(*) as c FROM consensus_debates').get() as any)?.c || 0;
    const resolved = (this.db.prepare("SELECT COUNT(*) as c FROM consensus_debates WHERE status = 'resolved'").get() as any)?.c || 0;
    const escalated = (this.db.prepare("SELECT COUNT(*) as c FROM consensus_debates WHERE status = 'escalated'").get() as any)?.c || 0;
    const proposals = (this.db.prepare('SELECT COUNT(*) as c FROM consensus_proposals').get() as any)?.c || 0;
    const votes = (this.db.prepare('SELECT COUNT(*) as c FROM consensus_votes').get() as any)?.c || 0;
    const avgScore = (this.db.prepare('SELECT AVG(consensus_score) as avg FROM consensus_debates WHERE status = ?').get('resolved') as any)?.avg || 0;

    return { totalDebates: debates, resolved, escalated, avgConsensusScore: avgScore, totalProposals: proposals, totalVotes: votes };
  }

  // ─── Private ──────────────────────────────────────────────────────────

  private calculateVoteWeight(agentId: string, proposalId: string): number {
    // Weight based on:
    // 1. Agent's historical accuracy (past votes that aligned with consensus)
    // 2. Domain expertise (agent's capabilities match proposal topic)
    // 3. Participation level (agents that vote more get slightly higher weight)

    let weight = 1.0;

    // Check if agent is voting on own proposal (reduce weight)
    const proposal = this.db.prepare('SELECT agent_id FROM consensus_proposals WHERE id = ?').get(proposalId) as any;
    if (proposal && proposal.agent_id === agentId) {
      weight *= 0.5; // Reduce weight for self-voting
    }

    // Boost for agents with proven track record
    const trackRecord = this.db.prepare(`
      SELECT COUNT(*) as total,
             SUM(CASE WHEN cd.winning_proposal_id = cp.id THEN 1 ELSE 0 END) as wins
      FROM consensus_votes cv
      JOIN consensus_proposals cp ON cv.proposal_id = cp.id
      JOIN consensus_debates cd ON cv.debate_id = cd.id
      WHERE cv.agent_id = ? AND cd.status = 'resolved'
    `).get(agentId) as any;

    if (trackRecord.total > 0) {
      const accuracy = (trackRecord.wins || 0) / trackRecord.total;
      weight *= (0.5 + accuracy); // 0.5x to 1.5x based on accuracy
    }

    return Math.max(0.1, Math.min(2.0, weight));
  }

  private updateProposalScore(proposalId: string): void {
    const votes = this.db.prepare('SELECT * FROM consensus_votes WHERE proposal_id = ?').all(proposalId) as any[];

    const voteValues: Record<VoteType, number> = {
      strong_agree: 2,
      agree: 1,
      neutral: 0,
      disagree: -1,
      strong_disagree: -2,
    };

    let totalScore = 0;
    let totalWeight = 0;

    for (const vote of votes) {
      totalScore += voteValues[vote.type as VoteType] * vote.weight;
      totalWeight += vote.weight;
    }

    const normalizedScore = totalWeight > 0 ? (totalScore / totalWeight + 2) / 4 : 0.5;

    this.db.prepare('UPDATE consensus_proposals SET score = ? WHERE id = ?').run(normalizedScore, proposalId);
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS consensus_debates (
        id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'proposing' CHECK(status IN ('proposing', 'debating', 'voting', 'resolved', 'escalated')),
        winning_proposal_id TEXT,
        consensus_score REAL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT
      );

      CREATE TABLE IF NOT EXISTS consensus_proposals (
        id TEXT PRIMARY KEY,
        debate_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        content TEXT NOT NULL,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        confidence REAL NOT NULL DEFAULT 0.7,
        score REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (debate_id) REFERENCES consensus_debates(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS consensus_votes (
        id TEXT PRIMARY KEY,
        debate_id TEXT NOT NULL,
        proposal_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('strong_agree', 'agree', 'neutral', 'disagree', 'strong_disagree')),
        reason TEXT NOT NULL DEFAULT '',
        weight REAL NOT NULL DEFAULT 1.0,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (debate_id) REFERENCES consensus_debates(id) ON DELETE CASCADE,
        FOREIGN KEY (proposal_id) REFERENCES consensus_proposals(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_consensus_debates_status ON consensus_debates(status);
      CREATE INDEX IF NOT EXISTS idx_consensus_proposals_debate_id ON consensus_proposals(debate_id);
      CREATE INDEX IF NOT EXISTS idx_consensus_votes_proposal_id ON consensus_votes(proposal_id);
    `);
  }
}
