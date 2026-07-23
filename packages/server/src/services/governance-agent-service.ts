/**
 * GovernanceAgentService — specialized governance agents that vote on decisions.
 *
 * Implements multiple specialized agents:
 * - SecurityAgent: evaluates security implications
 * - ComplianceAgent: evaluates regulatory compliance
 * - OperationsAgent: evaluates operational impact
 * - EthicsAgent: evaluates ethical implications
 * - LegalAgent: evaluates legal implications
 */

import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';

export type AgentRole = 'security' | 'compliance' | 'operations' | 'ethics' | 'legal';

export interface AgentVote {
  agent_id: string;
  role: AgentRole;
  decision: 'allow' | 'deny' | 'require_approval';
  confidence: number;
  reasoning: string;
  concerns: string[];
  timestamp: string;
}

export interface ConsensusResult {
  consensus_id: string;
  final_decision: 'allow' | 'deny' | 'require_approval';
  votes: AgentVote[];
  quorum_reached: boolean;
  dissent: AgentVote[];
  confidence: number;
  reasoning: string;
}

export class GovernanceAgentService {
  constructor(private db: Database) {
    this.ensureTables();
  }

  /**
   * Submit a governance decision for multi-agent voting.
   */
  reachConsensus(tool: string, category: string, args: Record<string, unknown>, principal: { sub: string; role: string }): ConsensusResult {
    const votes: AgentVote[] = [];

    // Security Agent vote
    votes.push(this.voteAsSecurity(tool, category, args));

    // Compliance Agent vote
    votes.push(this.voteAsCompliance(tool, category, args));

    // Operations Agent vote
    votes.push(this.voteAsOperations(tool, category, args));

    // Ethics Agent vote
    votes.push(this.voteAsEthics(tool, category, args));

    // Legal Agent vote
    votes.push(this.voteAsLegal(tool, category, args, principal));

    // Compute consensus
    const allowVotes = votes.filter(v => v.decision === 'allow');
    const denyVotes = votes.filter(v => v.decision === 'deny');
    const approvalVotes = votes.filter(v => v.decision === 'require_approval');

    let finalDecision: 'allow' | 'deny' | 'require_approval';
    if (denyVotes.length >= 2) finalDecision = 'deny';
    else if (approvalVotes.length >= 3) finalDecision = 'require_approval';
    else if (allowVotes.length >= 3) finalDecision = 'allow';
    else finalDecision = 'require_approval';

    const dissent = votes.filter(v => v.decision !== finalDecision);
    const confidence = Math.abs(allowVotes.length - denyVotes.length) / votes.length;

    return {
      consensus_id: `consensus-${randomUUID().slice(0, 8)}`,
      final_decision: finalDecision,
      votes,
      quorum_reached: true,
      dissent,
      confidence,
      reasoning: this.generateConsensusReasoning(finalDecision, votes),
    };
  }

  private voteAsSecurity(tool: string, category: string, args: Record<string, unknown>): AgentVote {
    const concerns: string[] = [];
    let decision: 'allow' | 'deny' | 'require_approval' = 'allow';
    let confidence = 0.8;

    if (/delete|remove|drop/i.test(tool)) {
      concerns.push('Destructive action detected');
      decision = 'require_approval';
      confidence = 0.6;
    }
    if (/admin|root|sudo/i.test(JSON.stringify(args))) {
      concerns.push('Privilege escalation risk');
      decision = 'deny';
      confidence = 0.9;
    }
    if (category === 'injection') {
      concerns.push('Injection risk detected');
      decision = 'deny';
      confidence = 0.95;
    }

    return {
      agent_id: 'agent-security',
      role: 'security',
      decision,
      confidence,
      reasoning: concerns.length > 0 ? `Security concerns: ${concerns.join(', ')}` : 'No security concerns',
      concerns,
      timestamp: new Date().toISOString(),
    };
  }

  private voteAsCompliance(tool: string, category: string, _args: Record<string, unknown>): AgentVote {
    const concerns: string[] = [];
    let decision: 'allow' | 'deny' | 'require_approval' = 'allow';
    let confidence = 0.7;

    if (/gdpr|pii|personal/i.test(tool)) {
      concerns.push('GDPR compliance required');
      decision = 'require_approval';
      confidence = 0.8;
    }
    if (category === 'hierarchy' && /delete.*log/i.test(tool)) {
      concerns.push('Audit trail violation');
      decision = 'deny';
      confidence = 0.9;
    }

    return {
      agent_id: 'agent-compliance',
      role: 'compliance',
      decision,
      confidence,
      reasoning: concerns.length > 0 ? `Compliance concerns: ${concerns.join(', ')}` : 'Compliant',
      concerns,
      timestamp: new Date().toISOString(),
    };
  }

  private voteAsOperations(tool: string, _category: string, args: Record<string, unknown>): AgentVote {
    const concerns: string[] = [];
    let decision: 'allow' | 'deny' | 'require_approval' = 'allow';
    let confidence = 0.6;

    if (args.environment === 'production') {
      concerns.push('Production environment impact');
      decision = 'require_approval';
      confidence = 0.7;
    }
    if (/deploy|release|push.*main/i.test(tool)) {
      concerns.push('Deployment impact');
      decision = 'require_approval';
      confidence = 0.8;
    }

    return {
      agent_id: 'agent-operations',
      role: 'operations',
      decision,
      confidence,
      reasoning: concerns.length > 0 ? `Operational concerns: ${concerns.join(', ')}` : 'Low operational impact',
      concerns,
      timestamp: new Date().toISOString(),
    };
  }

  private voteAsEthics(tool: string, category: string, _args: Record<string, unknown>): AgentVote {
    const concerns: string[] = [];
    let decision: 'allow' | 'deny' | 'require_approval' = 'allow';
    let confidence = 0.5;

    if (/backdoor|bypass.*security|fake/i.test(tool)) {
      concerns.push('Ethical violation detected');
      decision = 'deny';
      confidence = 0.95;
    }
    if (category === 'value-alignment' && /discriminat/i.test(tool)) {
      concerns.push('Discrimination risk');
      decision = 'deny';
      confidence = 0.9;
    }

    return {
      agent_id: 'agent-ethics',
      role: 'ethics',
      decision,
      confidence,
      reasoning: concerns.length > 0 ? `Ethical concerns: ${concerns.join(', ')}` : 'No ethical concerns',
      concerns,
      timestamp: new Date().toISOString(),
    };
  }

  private voteAsLegal(tool: string, category: string, _args: Record<string, unknown>, _principal: { sub: string; role: string }): AgentVote {
    const concerns: string[] = [];
    let decision: 'allow' | 'deny' | 'require_approval' = 'allow';
    let confidence = 0.6;

    if (/copyright|patent|trademark/i.test(tool)) {
      concerns.push('Intellectual property risk');
      decision = 'require_approval';
      confidence = 0.7;
    }
    if (category === 'hierarchy' && /gdpr/i.test(tool)) {
      concerns.push('GDPR legal requirement');
      decision = 'require_approval';
      confidence = 0.85;
    }

    return {
      agent_id: 'agent-legal',
      role: 'legal',
      decision,
      confidence,
      reasoning: concerns.length > 0 ? `Legal concerns: ${concerns.join(', ')}` : 'No legal concerns',
      concerns,
      timestamp: new Date().toISOString(),
    };
  }

  private generateConsensusReasoning(decision: string, votes: AgentVote[]): string {
    const allowCount = votes.filter(v => v.decision === 'allow').length;
    const denyCount = votes.filter(v => v.decision === 'deny').length;
    return `Consensus: ${decision} (${allowCount} allow, ${denyCount} deny, ${votes.length - allowCount - denyCount} require_approval)`;
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_votes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        consensus_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        role TEXT NOT NULL,
        decision TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0,
        reasoning TEXT NOT NULL DEFAULT '',
        concerns_json TEXT NOT NULL DEFAULT '[]',
        timestamp TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_av_consensus ON agent_votes(consensus_id);
    `);
  }
}
