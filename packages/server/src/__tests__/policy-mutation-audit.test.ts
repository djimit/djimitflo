import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { createPolicyRoutes } from '../routes/policies';

describe('policy mutation audit', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(schema);
    runMigrations(db);
  });

  afterEach(() => db.close());

  it('increments versions and records before/after evidence for update and delete', () => {
    const router = createPolicyRoutes(db);
    const handler = (method: 'patch' | 'delete') => (router as any).stack.find((candidate: any) =>
      candidate.route?.path === '/:id' && candidate.route.methods[method],
    ).route.stack.at(-1).handle;
    const policyId = 'policy-low-task-allow';
    const user = { sub: 'admin-1' };
    let updated: any;

    handler('patch')(
      { params: { id: policyId }, body: { description: 'Updated policy' }, user },
      { json: (body: unknown) => { updated = body; } },
      vi.fn(),
    );

    expect(updated).toMatchObject({ id: policyId, version: 2, description: 'Updated policy' });
    const updateAudit = db.prepare("SELECT user_id, before, after FROM audit_events WHERE action = 'approval_policy.updated'").get() as any;
    expect(updateAudit.user_id).toBe('admin-1');
    expect(JSON.parse(updateAudit.before)).toMatchObject({ id: policyId, version: 1 });
    expect(JSON.parse(updateAudit.after)).toMatchObject({ id: policyId, version: 2 });

    const response = { status: vi.fn().mockReturnThis(), send: vi.fn() };
    handler('delete')({ params: { id: policyId }, user }, response, vi.fn());

    expect(response.status).toHaveBeenCalledWith(204);
    expect(db.prepare('SELECT id FROM approval_policies WHERE id = ?').get(policyId)).toBeUndefined();
    const deleteAudit = db.prepare("SELECT before, after FROM audit_events WHERE action = 'approval_policy.deleted'").get() as any;
    expect(JSON.parse(deleteAudit.before)).toMatchObject({ id: policyId, version: 2 });
    expect(JSON.parse(deleteAudit.after)).toEqual({ deleted: true });
  });
});
