import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { createApprovalRoutes } from '../routes/approvals';
import { ExecutionEngine } from '../execution/execution-engine';
import { errorHandler } from '../middleware/error-handler';

describe('manual action approval lifecycle', () => {
  it('persists review, rejects self-approval, records independent evidence without dispatching', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    const ws = { broadcastTaskEventById: vi.fn(), broadcastTaskEvent: vi.fn() };
    const engine = new ExecutionEngine(db, ws as any);
    const start = vi.spyOn(engine, 'executeTask');
    db.prepare(`INSERT INTO tasks
      (id,title,description,status,priority,risk_level,execution_mode,created_by,owner_user_id)
      VALUES ('manual-task','Review','Review','pending','medium','high','local','maker-1','maker-1')`).run();
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => { req.user = { sub: 'maker-1', role: 'maker', email: 'maker@test' }; next(); });
    app.use('/approvals', createApprovalRoutes(db, engine, undefined, ws as any));
    app.use(errorHandler);
    try {
      await expect(engine.handleApprovalDecision('missing', true, 'approver')).rejects.toThrow('Approval not found');
      expect((await request(app).post('/approvals').send({ action: 'deploy' })).status).toBe(400);
      expect((await request(app).post('/approvals').send({ task_id: 'missing', action: 'deploy', reason: 'review', risk_level: 'high' })).status).toBe(404);
      for (const approved of [true, false]) {
        const response = await request(app).post('/approvals').send({ task_id: 'manual-task', action: 'deploy', reason: 'review', risk_level: 'high' });
        expect(response.status).toBe(201);
        const approval = response.body;
        expect(approval.requested_by).toBe('maker-1');
        expect(Date.parse(approval.expires_at)).toBeGreaterThan(Date.now());
        await expect(engine.handleApprovalDecision(approval.id, true, 'maker-1')).rejects.toThrow('SELF_APPROVAL_FORBIDDEN');
        await engine.handleApprovalDecision(approval.id, approved, 'independent-approver');
        await expect(engine.handleApprovalDecision(approval.id, !approved, 'independent-approver')).rejects.toThrow('Approval already processed');
        expect(db.prepare('SELECT status FROM approvals WHERE id = ?').get(approval.id)).toEqual({ status: approved ? 'approved' : 'denied' });
        expect(db.prepare('SELECT status FROM tasks WHERE id = ?').get('manual-task')).toEqual({ status: 'pending' });
        expect(db.prepare('SELECT count(*) AS n FROM execution_evidence WHERE approval_id = ?').get(approval.id)).toEqual({ n: 1 });
      }
      expect(start).not.toHaveBeenCalled();
      const expiring = await request(app).post('/approvals').send({ task_id: 'manual-task', action: 'deploy', reason: 'review', risk_level: 'high' });
      const now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
      db.prepare('UPDATE approvals SET expires_at = ? WHERE id = ?').run(new Date(now).toISOString(), expiring.body.id);
      try {
        await expect(engine.handleApprovalDecision(expiring.body.id, true, 'independent-approver')).rejects.toThrow('APPROVAL_EXPIRED');
      } finally { clock.mockRestore(); }
      expect(ws.broadcastTaskEventById).toHaveBeenCalled();
    } finally { db.close(); }
  });
});
