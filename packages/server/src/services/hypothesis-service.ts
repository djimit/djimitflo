/**
 * HypothesisService — scientific hypothesis lifecycle for swarm intelligence.
 *
 * Extracted from SwarmIntelligenceService (Phase B1 decomposition).
 * Handles: hypothesis creation, state transitions, lineage tracking.
 */

import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

interface HypothesisRecord {
  id: string;
  title: string;
  description: string;
  state: string;
  evidence_refs: string[];
  created_at: string;
  updated_at: string;
}

export class HypothesisService {
  constructor(private db: Database) {}

  createHypothesis(input: {
    title: string;
    description: string;
    evidence_refs?: string[];
  }): HypothesisRecord {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO swarm_hypotheses (id, title, description, state, evidence_refs_json, created_at, updated_at)
      VALUES (?, ?, ?, 'proposed', ?, ?, ?)
    `).run(id, input.title, input.description, JSON.stringify(input.evidence_refs || []), now, now);

    return this.getHypothesis(id)!;
  }

  getHypothesis(id: string): HypothesisRecord | null {
    const row = this.db.prepare('SELECT * FROM swarm_hypotheses WHERE id = ?').get(id) as any;
    return row ? {
      id: row.id,
      title: row.title,
      description: row.description,
      state: row.state,
      evidence_refs: JSON.parse(row.evidence_refs_json || '[]'),
      created_at: row.created_at,
      updated_at: row.updated_at,
    } : null;
  }

  listHypotheses(limit = 100): HypothesisRecord[] {
    return (this.db.prepare('SELECT * FROM swarm_hypotheses ORDER BY created_at DESC LIMIT ?').all(limit) as any[]).map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      state: row.state,
      evidence_refs: JSON.parse(row.evidence_refs_json || '[]'),
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));
  }

  transitionHypothesis(id: string, toState: string, evidence?: string[]): HypothesisRecord {
    const existing = this.getHypothesis(id);
    if (!existing) throw new Error('HYPOTHESIS_NOT_FOUND');

    const validStates = ['proposed', 'supported', 'contradicted', 'resolved', 'rejected'];
    if (!validStates.includes(toState)) throw new Error(`HYPOTHESIS_STATE_INVALID: ${toState}`);

    const now = new Date().toISOString();
    const evidenceRefs = evidence || existing.evidence_refs;

    this.db.prepare(`
      UPDATE swarm_hypotheses SET state = ?, evidence_refs_json = ?, updated_at = ? WHERE id = ?
    `).run(toState, JSON.stringify(evidenceRefs), now, id);

    return this.getHypothesis(id)!;
  }
}
