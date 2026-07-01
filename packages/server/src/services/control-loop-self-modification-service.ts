import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

export interface ContractProposal {
  id: string;
  targetContract: string;
  proposedChanges: Record<string, unknown>;
  rationale: string;
  evalScore: number | null;
  status: 'draft' | 'evaluating' | 'approved' | 'applied' | 'rolled_back';
  createdAt: string;
  appliedAt: string | null;
}

interface ProposalRow {
  id: string;
  target_contract: string;
  proposed_changes_json: string;
  rationale: string;
  eval_score: number | null;
  status: string;
  snapshot_json: string | null;
  created_at: string;
  applied_at: string | null;
  rolled_back_at: string | null;
}

export class ControlLoopSelfModificationService {
  private evalThreshold = 0.75;

  constructor(private db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contract_proposals (
        id TEXT PRIMARY KEY,
        target_contract TEXT NOT NULL,
        proposed_changes_json TEXT NOT NULL,
        rationale TEXT NOT NULL,
        eval_score REAL,
        status TEXT NOT NULL DEFAULT 'draft',
        snapshot_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        applied_at TEXT,
        rolled_back_at TEXT
      )
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_contract_proposals_status ON contract_proposals(status)');
  }

  proposeChange(contractId: string, changes: Record<string, unknown>, rationale: string): ContractProposal {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO contract_proposals (id, target_contract, proposed_changes_json, rationale, status)
      VALUES (?, ?, ?, ?, 'draft')
    `).run(id, contractId, JSON.stringify(changes), rationale);

    return { id, targetContract: contractId, proposedChanges: changes, rationale, evalScore: null, status: 'draft', createdAt: now, appliedAt: null };
  }

  evaluateProposal(proposalId: string): number {
    const proposal = this.db.prepare('SELECT * FROM contract_proposals WHERE id = ?').get(proposalId) as ProposalRow | undefined;
    if (!proposal) return 0;

    this.db.prepare("UPDATE contract_proposals SET status = 'evaluating' WHERE id = ?").run(proposalId);

    const changes = JSON.parse(proposal.proposed_changes_json) as Record<string, unknown>;
    const changeCount = Object.keys(changes).length;
    const score = Math.max(0, 1 - changeCount * 0.1);

    this.db.prepare('UPDATE contract_proposals SET eval_score = ? WHERE id = ?').run(score, proposalId);
    return score;
  }

  approveProposal(proposalId: string): void {
    const proposal = this.db.prepare('SELECT eval_score, status FROM contract_proposals WHERE id = ?').get(proposalId) as { eval_score: number | null; status: string } | undefined;
    if (!proposal) throw new Error('Proposal not found');
    if (proposal.status !== 'draft' && proposal.status !== 'evaluating') throw new Error(`Cannot approve proposal in status: ${proposal.status}`);
    if (proposal.eval_score !== null && proposal.eval_score < this.evalThreshold) throw new Error(`Eval score ${proposal.eval_score} below threshold ${this.evalThreshold}`);

    this.db.prepare("UPDATE contract_proposals SET status = 'approved' WHERE id = ?").run(proposalId);
  }

  applyProposal(proposalId: string): void {
    const proposal = this.db.prepare('SELECT * FROM contract_proposals WHERE id = ?').get(proposalId) as ProposalRow | undefined;
    if (!proposal) throw new Error('Proposal not found');
    if (proposal.status !== 'approved') throw new Error(`Cannot apply proposal in status: ${proposal.status}`);

    const snapshot = this.createSnapshot(proposal.target_contract, JSON.parse(proposal.proposed_changes_json));
    this.db.prepare("UPDATE contract_proposals SET status = 'applied', applied_at = datetime('now'), snapshot_json = ? WHERE id = ?").run(JSON.stringify(snapshot), proposalId);
  }

  rollbackProposal(proposalId: string): void {
    const proposal = this.db.prepare('SELECT * FROM contract_proposals WHERE id = ?').get(proposalId) as ProposalRow | undefined;
    if (!proposal) throw new Error('Proposal not found');
    if (proposal.status !== 'applied') throw new Error(`Cannot rollback proposal in status: ${proposal.status}`);

    if (proposal.snapshot_json) {
      const snapshot = JSON.parse(proposal.snapshot_json) as Record<string, unknown>;
      void snapshot;
    }
    this.db.prepare("UPDATE contract_proposals SET status = 'rolled_back', rolled_back_at = datetime('now') WHERE id = ?").run(proposalId);
  }

  getProposalHistory(contractId?: string): ContractProposal[] {
    const rows = contractId
      ? this.db.prepare('SELECT * FROM contract_proposals WHERE target_contract = ? ORDER BY created_at DESC').all(contractId) as ProposalRow[]
      : this.db.prepare('SELECT * FROM contract_proposals ORDER BY created_at DESC').all() as ProposalRow[];
    return rows.map(this.rowToProposal);
  }

  getProposal(proposalId: string): ContractProposal | null {
    const row = this.db.prepare('SELECT * FROM contract_proposals WHERE id = ?').get(proposalId) as ProposalRow | undefined;
    return row ? this.rowToProposal(row) : null;
  }

  getPendingProposals(): ContractProposal[] {
    const rows = this.db.prepare("SELECT * FROM contract_proposals WHERE status IN ('draft', 'evaluating', 'approved') ORDER BY created_at DESC").all() as ProposalRow[];
    return rows.map(this.rowToProposal);
  }

  private createSnapshot(contractId: string, _changes: Record<string, unknown>): Record<string, unknown> {
    try {
      const contract = this.db.prepare('SELECT * FROM loop_contracts WHERE id = ?').get(contractId) as Record<string, unknown> | undefined;
      return contract ? { ...contract } : { id: contractId, snapshot: true };
    } catch {
      return { id: contractId, snapshot: true };
    }
  }

  private rowToProposal(row: ProposalRow): ContractProposal {
    return {
      id: row.id,
      targetContract: row.target_contract,
      proposedChanges: JSON.parse(row.proposed_changes_json) as Record<string, unknown>,
      rationale: row.rationale,
      evalScore: row.eval_score,
      status: row.status as ContractProposal['status'],
      createdAt: row.created_at,
      appliedAt: row.applied_at,
    };
  }
}
