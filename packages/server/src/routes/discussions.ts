/**
 * Discussion routes
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { createError } from '../middleware/error-handler';
import { randomUUID } from 'crypto';
import type { AuthMiddleware } from '../middleware/auth';

function loadDiscussionOr404(db: any, id: string, res: any): any | null {
  const discussion = db.prepare('SELECT * FROM discussions WHERE id = ?').get(id);
  if (!discussion) {
    res.status(404).json({ error: { message: 'Discussion not found', code: 'DISCUSSION_NOT_FOUND' } });
    return null;
  }
  return discussion;
}

function parseDiscussion(discussion: any): any {
  return {
    ...discussion,
    metadata: JSON.parse(discussion.metadata || '{}'),
  };
}

function parseProposal(proposal: any): any {
  return {
    ...proposal,
    data: JSON.parse(proposal.data || '{}'),
    metadata: JSON.parse(proposal.metadata || '{}'),
  };
}

function parseVote(vote: any): any {
  return {
    ...vote,
    metadata: JSON.parse(vote.metadata || '{}'),
  };
}

export function createDiscussionRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());


  // GET /api/discussions - List all discussions
  router.get('/', (req, res, next) => {
    try {
      const { status, agent_id, limit = 100, offset = 0 } = req.query;

      let query = 'SELECT * FROM discussions';
      const params: any[] = [];
      const where: string[] = [];

      if (status) {
        where.push('status = ?');
        params.push(status);
      }

      if (agent_id) {
        where.push('agent_id = ?');
        params.push(agent_id);
      }

      if (where.length > 0) {
        query += ' WHERE ' + where.join(' AND ');
      }

      query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
      params.push(Number(limit), Number(offset));

      const discussions = db.prepare(query).all(...params);
      const parsed = discussions.map((d: any) => parseDiscussion(d));

      res.json({ discussions: parsed, total: discussions.length });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/discussions - Create new discussion
  router.post('/', requirePermission('create:task'), (req, res, next) => {
    try {
      const {
        topic,
        description,
        status = 'open',
        agent_id = null,
        parent_discussion_id = null,
        metadata = {},
      } = req.body;

      if (!topic || !description) {
        throw createError(400, 'Topic and description are required', 'INVALID_INPUT');
      }

      const id = randomUUID();
      const now = new Date().toISOString();
      const actorId = (req as any).user?.sub;
      const enrichedMetadata = { ...metadata, createdBy: actorId };

      db.prepare(`
        INSERT INTO discussions (
          id, topic, description, status, agent_id, parent_discussion_id,
          metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        topic,
        description,
        status,
        agent_id,
        parent_discussion_id,
        JSON.stringify(enrichedMetadata),
        now,
        now
      );

      const discussion = db.prepare('SELECT * FROM discussions WHERE id = ?').get(id) as any;
      res.status(201).json(parseDiscussion(discussion));
    } catch (error) {
      next(error);
    }
  });

  // GET /api/discussions/:id - Get discussion by ID
  router.get('/:id', (req, res, next) => {
    try {
      const { id } = req.params;
      const discussion = loadDiscussionOr404(db, id, res);
      if (!discussion) return;

      res.json(parseDiscussion(discussion));
    } catch (error) {
      next(error);
    }
  });

  // PATCH /api/discussions/:id - Update discussion
  router.patch('/:id', requirePermission('create:task'), (req, res, next) => {
    try {
      const { id } = req.params;
      const discussion = loadDiscussionOr404(db, id, res);
      if (!discussion) return;

      const updates = req.body;
      const allowed = ['topic', 'description', 'status', 'agent_id', 'parent_discussion_id', 'metadata'];
      const setClauses: string[] = [];
      const params: any[] = [];

      for (const key of allowed) {
        if (key in updates) {
          setClauses.push(`${key} = ?`);
          params.push(key === 'metadata' ? JSON.stringify(updates[key]) : updates[key]);
        }
      }

      if (setClauses.length === 0) {
        throw createError(400, 'No valid fields to update', 'INVALID_INPUT');
      }

      setClauses.push('updated_at = ?');
      params.push(new Date().toISOString());
      params.push(id);

      db.prepare(`UPDATE discussions SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);

      const updated = db.prepare('SELECT * FROM discussions WHERE id = ?').get(id) as any;
      res.json(parseDiscussion(updated));
    } catch (error) {
      next(error);
    }
  });

  // POST /api/discussions/:id/proposals - Add proposal to discussion
  router.post('/:id/proposals', requirePermission('create:task'), (req, res, next) => {
    try {
      const { id } = req.params;
      const discussion = loadDiscussionOr404(db, id, res);
      if (!discussion) return;

      const {
        agent_id,
        type,
        title,
        description,
        data = {},
        status = 'pending',
        metadata = {},
      } = req.body;

      if (!agent_id || !type || !title || !description) {
        throw createError(400, 'agent_id, type, title and description are required', 'INVALID_INPUT');
      }

      const proposalId = randomUUID();
      const now = new Date().toISOString();
      const actorId = (req as any).user?.sub;
      const enrichedMetadata = { ...metadata, createdBy: actorId };

      db.prepare(`
        INSERT INTO discussion_proposals (
          id, discussion_id, agent_id, type, title, description,
          data, status, metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        proposalId,
        id,
        agent_id,
        type,
        title,
        description,
        JSON.stringify(data),
        status,
        JSON.stringify(enrichedMetadata),
        now,
        now
      );

      const proposal = db.prepare('SELECT * FROM discussion_proposals WHERE id = ?').get(proposalId) as any;
      res.status(201).json(parseProposal(proposal));
    } catch (error) {
      next(error);
    }
  });

  // GET /api/discussions/:id/proposals - List proposals for discussion
  router.get('/:id/proposals', (req, res, next) => {
    try {
      const { id } = req.params;
      const discussion = loadDiscussionOr404(db, id, res);
      if (!discussion) return;

      const proposals = db.prepare(`
        SELECT * FROM discussion_proposals
        WHERE discussion_id = ?
        ORDER BY created_at DESC
      `).all(id);

      const parsed = proposals.map((p: any) => parseProposal(p));
      res.json({ proposals: parsed });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/discussions/:id/votes - Cast vote on a proposal
  router.post('/:id/votes', requirePermission('create:task'), (req, res, next) => {
    try {
      const { id } = req.params;
      const discussion = loadDiscussionOr404(db, id, res);
      if (!discussion) return;

      const {
        proposal_id,
        agent_id,
        vote,
        confidence = null,
        reasoning = null,
        metadata = {},
      } = req.body;

      if (!proposal_id || !agent_id || !vote) {
        throw createError(400, 'proposal_id, agent_id and vote are required', 'INVALID_INPUT');
      }

      // Verify proposal belongs to this discussion
      const proposal = db.prepare('SELECT * FROM discussion_proposals WHERE id = ? AND discussion_id = ?').get(proposal_id, id) as any;
      if (!proposal) {
        throw createError(404, 'Proposal not found in this discussion', 'PROPOSAL_NOT_FOUND');
      }

      const voteId = randomUUID();
      const now = new Date().toISOString();
      const actorId = (req as any).user?.sub;
      const enrichedMetadata = { ...metadata, createdBy: actorId };

      db.prepare(`
        INSERT INTO discussion_votes (
          id, proposal_id, agent_id, vote, confidence, reasoning,
          metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        voteId,
        proposal_id,
        agent_id,
        vote,
        confidence,
        reasoning,
        JSON.stringify(enrichedMetadata),
        now,
        now
      );

      const createdVote = db.prepare('SELECT * FROM discussion_votes WHERE id = ?').get(voteId) as any;
      res.status(201).json(parseVote(createdVote));
    } catch (error) {
      next(error);
    }
  });

  // GET /api/discussions/:id/votes - List votes for discussion
  router.get('/:id/votes', (req, res, next) => {
    try {
      const { id } = req.params;
      const discussion = loadDiscussionOr404(db, id, res);
      if (!discussion) return;

      const votes = db.prepare(`
        SELECT v.* FROM discussion_votes v
        INNER JOIN discussion_proposals p ON v.proposal_id = p.id
        WHERE p.discussion_id = ?
        ORDER BY v.created_at DESC
      `).all(id);

      const parsed = votes.map((v: any) => parseVote(v));
      res.json({ votes: parsed });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/discussions/:id/consensus - Calculate consensus
  router.post('/:id/consensus', requirePermission('create:task'), (req, res, next) => {
    try {
      const { id } = req.params;
      const discussion = loadDiscussionOr404(db, id, res);
      if (!discussion) return;

      const proposals = db.prepare('SELECT * FROM discussion_proposals WHERE discussion_id = ?').all(id) as any[];
      const votes = db.prepare(`
        SELECT v.* FROM discussion_votes v
        INNER JOIN discussion_proposals p ON v.proposal_id = p.id
        WHERE p.discussion_id = ?
      `).all(id) as any[];

      const proposalResults = proposals.map((proposal: any) => {
        const proposalVotes = votes.filter((v: any) => v.proposal_id === proposal.id);
        const yesCount = proposalVotes.filter((v: any) => v.vote === 'yes').length;
        const noCount = proposalVotes.filter((v: any) => v.vote === 'no').length;
        const abstainCount = proposalVotes.filter((v: any) => v.vote === 'abstain').length;
        const totalVotes = proposalVotes.length;
        const yesPct = totalVotes > 0 ? (yesCount / totalVotes) * 100 : 0;
        const noPct = totalVotes > 0 ? (noCount / totalVotes) * 100 : 0;

        let newStatus = proposal.status;
        if (yesPct >= 50) {
          newStatus = 'accepted';
        } else if (noPct >= 50) {
          newStatus = 'rejected';
        }

        if (newStatus !== proposal.status) {
          db.prepare(`
            UPDATE discussion_proposals SET status = ?, updated_at = ? WHERE id = ?
          `).run(newStatus, new Date().toISOString(), proposal.id);
        }

        return {
          proposal_id: proposal.id,
          title: proposal.title,
          previous_status: proposal.status,
          status: newStatus,
          votes: { yes: yesCount, no: noCount, abstain: abstainCount, total: totalVotes },
          percentages: { yes: yesPct, no: noPct },
        };
      });

      // If any proposal was accepted, close the discussion
      const anyAccepted = proposalResults.some((r: any) => r.status === 'accepted');
      if (anyAccepted && discussion.status !== 'closed') {
        db.prepare(`
          UPDATE discussions SET status = 'closed', updated_at = ? WHERE id = ?
        `).run(new Date().toISOString(), id);
      }

      res.json({
        discussion_id: id,
        discussion_status: anyAccepted ? 'closed' : discussion.status,
        proposals: proposalResults,
      });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/discussions/:id/timeline - Get full timeline
  router.get('/:id/timeline', (req, res, next) => {
    try {
      const { id } = req.params;
      const discussion = loadDiscussionOr404(db, id, res);
      if (!discussion) return;

      const proposals = db.prepare(`
        SELECT * FROM discussion_proposals WHERE discussion_id = ? ORDER BY created_at ASC
      `).all(id) as any[];

      const votes = db.prepare(`
        SELECT v.* FROM discussion_votes v
        INNER JOIN discussion_proposals p ON v.proposal_id = p.id
        WHERE p.discussion_id = ?
        ORDER BY v.created_at ASC
      `).all(id) as any[];

      const timeline: any[] = [];

      timeline.push({
        type: 'discussion',
        id: discussion.id,
        topic: discussion.topic,
        status: discussion.status,
        created_at: discussion.created_at,
      });

      for (const proposal of proposals) {
        timeline.push({
          type: 'proposal',
          id: proposal.id,
          title: proposal.title,
          proposal_type: proposal.type,
          status: proposal.status,
          created_at: proposal.created_at,
        });

        const proposalVotes = votes.filter((v: any) => v.proposal_id === proposal.id);
        for (const vote of proposalVotes) {
          timeline.push({
            type: 'vote',
            id: vote.id,
            proposal_id: vote.proposal_id,
            agent_id: vote.agent_id,
            vote: vote.vote,
            confidence: vote.confidence,
            created_at: vote.created_at,
          });
        }
      }

      timeline.sort((a: any, b: any) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

      res.json({
        discussion: parseDiscussion(discussion),
        timeline,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
