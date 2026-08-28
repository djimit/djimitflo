import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import type Database from 'better-sqlite3';
import { createTestDb } from './helpers/test-db';
import { createSelfImprovementRoutes } from '../routes/self-improvement';
import { errorHandler } from '../middleware/error-handler';
import { SelfImprovementService } from '../services/self-improvement-service';
import { SpecialistPanelService } from '../services/specialist-panel-service';

describe('self-improvement routes', () => {
  let db: Database.Database;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    db = createTestDb();
    const app = express();
    app.use(express.json());
    app.use('/self-improve', createSelfImprovementRoutes(db, {
      requirePermission: () => (req: any, _res: any, next: any) => {
        req.user = { sub: 'route-admin', email: 'admin@example.test', role: 'admin' };
        next();
      },
    } as any));
    app.use(errorHandler);
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, () => resolve(listening));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/self-improve`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });

  it('keeps a proposal inert until consensus and records the authenticated operator', async () => {
    const service = new SelfImprovementService(db);
    const [proposal] = service.generateFromReflection({
      whatFailed: ['checker failed'],
      lessonsLearned: ['Preserve checker evidence'],
      proposedImprovements: ['Fix checker evidence capture'],
      loopRunId: 'loop-route',
      reflectionId: 'reflection-route',
    });

    expect((await fetch(`${baseUrl}/proposals/${proposal.id}/approve`, { method: 'POST' })).status).toBe(409);

    const panels = new SpecialistPanelService(db);
    const panel = panels.getPanel(proposal.panelId!);
    for (const specialist of panel.panel) {
      panels.submitReview(panel.id, {
        specialist_id: specialist.id,
        stance: 'support',
        confidence: 0.9,
        evidence_refs: proposal.evidenceRefs,
      }, `route-reviewer-${specialist.id}`);
    }

    const response = await fetch(`${baseUrl}/proposals/${proposal.id}/approve`, { method: 'POST' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ proposal: { status: 'executing', approvedBy: 'route-admin' }, goalCreated: true });
    expect((db.prepare('SELECT COUNT(*) AS count FROM goals').get() as { count: number }).count).toBe(1);
  });

  it('rejects an invalid status filter', async () => {
    expect((await fetch(`${baseUrl}/proposals?status=anything`)).status).toBe(400);
  });
});
