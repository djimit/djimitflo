/**
 * Discussion turn protocol (L4 part 2).
 *
 * Adds ordered, multi-round turns on top of the existing `discussions`
 * substrate. The "turn scheduler" is computed-on-read (no scheduler table) —
 * `computeNextTurn` derives the next speaker from the participant roster in
 * `discussions.metadata.participants` plus the committed-turn count, the same
 * shape as `swarm-status-service.tickScheduler` and
 * `SpecialistPanelService.computeConsensus`. `tick` returns a hint only; it
 * spawns nothing.
 */

import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';

export interface DiscussionTurn {
  id: string;
  discussion_id: string;
  agent_id: string;
  turn_index: number;
  parent_turn_id: string | null;
  content: string;
  status: 'open' | 'committed' | 'superseded';
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface AppendTurnInput {
  agent_id: string;
  content: string;
  parent_turn_id?: string | null;
}

export interface NextTurnHint {
  next_agent_id: string | null;
  turn_index: number | null;
  awaiting_commit: boolean;
  reason: string;
}

function parseTurn(row: any): DiscussionTurn {
  return {
    ...row,
    parent_turn_id: row.parent_turn_id ?? null,
    metadata: JSON.parse(row.metadata || '{}'),
  };
}

export class DiscussionTurnService {
  constructor(private readonly db: Database) {}

  private getParticipants(discussionId: string): string[] {
    const row = this.db.prepare('SELECT metadata FROM discussions WHERE id = ?').get(discussionId) as any;
    if (!row) return [];
    try {
      const meta = JSON.parse(row.metadata || '{}');
      const participants = meta?.participants;
      return Array.isArray(participants) ? participants.map(String) : [];
    } catch {
      return [];
    }
  }

  private loadDiscussion(discussionId: string): any {
    return this.db.prepare('SELECT * FROM discussions WHERE id = ?').get(discussionId) as any;
  }

  appendTurn(discussionId: string, input: AppendTurnInput): DiscussionTurn {
    if (!input.agent_id || !input.content) {
      throw new Error('TURN_INPUT_REQUIRED');
    }
    const discussion = this.loadDiscussion(discussionId);
    if (!discussion) throw new Error('DISCUSSION_NOT_FOUND');
    if (discussion.status !== 'open') throw new Error('DISCUSSION_NOT_OPEN');

    const participants = this.getParticipants(discussionId);
    if (participants.length > 0 && !participants.includes(input.agent_id)) {
      throw new Error('AGENT_NOT_IN_DISCUSSION');
    }

    // One open turn at a time.
    const openTurn = this.db
      .prepare("SELECT id FROM discussion_turns WHERE discussion_id = ? AND status = 'open' LIMIT 1")
      .get(discussionId) as any;
    if (openTurn) throw new Error('OPEN_TURN_PENDING');

    if (input.parent_turn_id) {
      const parent = this.db
        .prepare('SELECT status FROM discussion_turns WHERE id = ? AND discussion_id = ?')
        .get(input.parent_turn_id, discussionId) as any;
      if (!parent) throw new Error('INVALID_PARENT_TURN');
      if (parent.status !== 'committed') throw new Error('INVALID_PARENT_TURN');
    }

    const maxRow = this.db
      .prepare('SELECT MAX(turn_index) AS max_index FROM discussion_turns WHERE discussion_id = ?')
      .get(discussionId) as any;
    const turnIndex = (maxRow?.max_index ?? 0) + 1;

    const id = randomUUID();
    const now = new Date().toISOString();
    const metadata = JSON.stringify({});

    this.db
      .prepare(`
        INSERT INTO discussion_turns (
          id, discussion_id, agent_id, turn_index, parent_turn_id,
          content, status, metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)
      `)
      .run(id, discussionId, input.agent_id, turnIndex, input.parent_turn_id ?? null, input.content, metadata, now, now);

    const row = this.db.prepare('SELECT * FROM discussion_turns WHERE id = ?').get(id) as any;
    return parseTurn(row);
  }

  listTurns(discussionId: string): DiscussionTurn[] {
    const rows = this.db
      .prepare('SELECT * FROM discussion_turns WHERE discussion_id = ? ORDER BY turn_index ASC')
      .all(discussionId) as any[];
    return rows.map(parseTurn);
  }

  /** Computed-on-read next-speaker selection (round-robin over participants). */
  computeNextTurn(discussionId: string): NextTurnHint {
    const discussion = this.loadDiscussion(discussionId);
    if (!discussion) throw new Error('DISCUSSION_NOT_FOUND');

    const participants = this.getParticipants(discussionId);
    if (participants.length === 0) {
      return { next_agent_id: null, turn_index: null, awaiting_commit: false, reason: 'no participants configured' };
    }

    const turns = this.listTurns(discussionId);
    const openTurn = turns.find((t) => t.status === 'open');
    if (openTurn) {
      return {
        next_agent_id: openTurn.agent_id,
        turn_index: openTurn.turn_index,
        awaiting_commit: true,
        reason: 'open turn awaiting commit',
      };
    }

    const committedCount = turns.filter((t) => t.status === 'committed').length;
    const nextAgent = participants[committedCount % participants.length];
    const nextIndex = turns.length + 1;
    return {
      next_agent_id: nextAgent,
      turn_index: nextIndex,
      awaiting_commit: false,
      reason: 'round-robin',
    };
  }

  setTurnStatus(discussionId: string, turnId: string, status: 'committed' | 'superseded'): DiscussionTurn {
    const row = this.db
      .prepare('SELECT * FROM discussion_turns WHERE id = ? AND discussion_id = ?')
      .get(turnId, discussionId) as any;
    if (!row) throw new Error('TURN_NOT_FOUND');

    const allowed: Record<string, string[]> = {
      open: ['committed', 'superseded'],
      committed: ['superseded'],
      superseded: [],
    };
    const fromStatus = row.status as string;
    if (!(allowed[fromStatus] ?? []).includes(status)) {
      throw new Error('INVALID_TURN_STATUS');
    }

    const now = new Date().toISOString();
    this.db.prepare('UPDATE discussion_turns SET status = ?, updated_at = ? WHERE id = ?').run(status, now, turnId);
    const updated = this.db.prepare('SELECT * FROM discussion_turns WHERE id = ?').get(turnId) as any;
    return parseTurn(updated);
  }
}