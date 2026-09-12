import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import Database from 'better-sqlite3';
import { createDiscussionRoutes } from '../routes/discussions';
import { errorHandler } from '../middleware/error-handler';

describe('discussion proposal and consensus HTTP chain', () => {
  const dbs: Database.Database[] = [];
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

  it('persists a proposal, votes, consensus closure and timeline', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    dbs.push(db);
    db.prepare("INSERT INTO agents (id, name, description, status, capabilities) VALUES ('agent-a', 'Agent A', 'fixture', 'idle', '[]'), ('agent-b', 'Agent B', 'fixture', 'idle', '[]')").run();
    const auth = { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any;
    const app = express().use(express.json()).use(createDiscussionRoutes(db, auth)).use(errorHandler);

    expect((await request(app).post('/').send({})).status).toBe(400);
    const created = await request(app).post('/').send({ topic: 'Governance', description: 'Choose a safe action' });
    expect(created.status).toBe(201);
    const discussionId = created.body.id;

    const proposal = await request(app).post(`/${discussionId}/proposals`).send({
      agent_id: 'agent-a', type: 'action', title: 'Apply guard', description: 'Apply the shared guard', data: { risk: 'low' },
    });
    expect(proposal.status).toBe(201);
    const proposalId = proposal.body.id;
    expect(proposal.body.data).toEqual({ risk: 'low' });

    expect((await request(app).get(`/${discussionId}/proposals`)).body.proposals).toHaveLength(1);
    for (const [agent_id, vote] of [['agent-a', 'yes'], ['agent-b', 'no']] as const) {
      const response = await request(app).post(`/${discussionId}/votes`).send({ proposal_id: proposalId, agent_id, vote, confidence: 80, reasoning: 'fixture evidence' });
      expect(response.status).toBe(201);
    }
    expect((await request(app).get(`/${discussionId}/votes`)).body.votes).toHaveLength(2);

    const consensus = await request(app).post(`/${discussionId}/consensus`).send({});
    expect(consensus.status).toBe(200);
    expect(consensus.body.discussion_status).toBe('closed');
    expect(consensus.body.proposals[0]).toMatchObject({ proposal_id: proposalId, status: 'accepted', votes: { yes: 1, no: 1, total: 2 } });

    const fetched = await request(app).get(`/${discussionId}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.status).toBe('closed');
    const timeline = await request(app).get(`/${discussionId}/timeline`);
    expect(timeline.status).toBe(200);
    expect(timeline.body.timeline.map((entry: any) => entry.type)).toEqual(['discussion', 'proposal', 'vote', 'vote']);
  });
});
