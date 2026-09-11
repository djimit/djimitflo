import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/test-db';
import { createEvidenceRoutes } from '../routes/evidence';

describe('evidence route chain', () => {
  const dbs: ReturnType<typeof createTestDb>[] = [];
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

  it('projects task evidence, file changes and audit trail for an owned task', async () => {
    const db = createTestDb();
    dbs.push(db);
    db.exec(`
      ALTER TABLE tasks ADD COLUMN owner_user_id TEXT;
      ALTER TABLE tasks ADD COLUMN created_by TEXT;
      CREATE TABLE execution_events (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, event_type TEXT NOT NULL,
        timestamp TEXT NOT NULL, message TEXT NOT NULL, level TEXT NOT NULL,
        tool_name TEXT, tool_input TEXT, tool_output TEXT, tool_error TEXT,
        approval_id TEXT, artifact_id TEXT, metadata TEXT, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE audit_events (
        id TEXT PRIMARY KEY, event_type TEXT NOT NULL, timestamp TEXT NOT NULL,
        user_id TEXT, agent_id TEXT, task_id TEXT, execution_event_id TEXT,
        action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT,
        risk_level TEXT NOT NULL, before TEXT, after TEXT, ip_address TEXT,
        user_agent TEXT, metadata TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    db.prepare(`INSERT INTO tasks
      (id,title,description,status,priority,risk_level,execution_mode,owner_user_id,created_by,tags,metadata)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      'task-evidence-1', 'Evidence fixture', 'Trace a fixture', 'completed', 'low', 'low', 'local',
      'user-1', 'user-1', '[]', '{}',
    );
    db.prepare(`INSERT INTO execution_events
      (id,task_id,event_type,timestamp,message,level,metadata,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run('event-1', 'task-evidence-1', 'task.completed', '2026-09-11T00:00:00.000Z', 'done', 'info', '{}', '2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z');
    db.prepare(`INSERT INTO execution_evidence
      (id,task_id,execution_event_id,evidence_type,severity,title,summary,details,source,captured_at,metadata)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run('evidence-1', 'task-evidence-1', 'event-1', 'execution_summary', 'info', 'Completed', 'Fixture completed', '{}', 'system', '2026-09-11T00:00:01.000Z', '{}');
    db.prepare(`INSERT INTO file_changes
      (id,task_id,execution_event_id,file_path,change_type,before_hash,after_hash,risk_level,detected_at,metadata)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run('change-1', 'task-evidence-1', 'event-1', 'README.md', 'modified', 'a', 'b', 'low', '2026-09-11T00:00:02.000Z', '{}');
    db.prepare(`INSERT INTO audit_events
      (id,event_type,timestamp,user_id,task_id,action,resource_type,resource_id,risk_level,metadata,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run('audit-1', 'task.completed', '2026-09-11T00:00:03.000Z', 'user-1', 'task-evidence-1', 'complete', 'task', 'task-evidence-1', 'low', '{}', '2026-09-11T00:00:03.000Z', '2026-09-11T00:00:03.000Z');

    const auth = { requireAuth: (req: any, _res: any, next: any) => { req.user = { sub: 'user-1', role: 'viewer' }; next(); } } as any;
    const app = express().use(express.json()).use('/evidence', createEvidenceRoutes(db, auth));
    const evidence = await request(app).get('/evidence/task/task-evidence-1?evidence_type=execution_summary');
    expect(evidence.status).toBe(200);
    expect(evidence.body.evidence).toHaveLength(1);
    const changes = await request(app).get('/evidence/file-changes/task-evidence-1');
    expect(changes.status).toBe(200);
    expect(changes.body.file_changes[0]).toMatchObject({ file_path: 'README.md', change_type: 'modified' });
    const trail = await request(app).get('/evidence/audit-trail/task-evidence-1');
    expect(trail.status).toBe(200);
    expect(trail.body.audit_trail[0]).toMatchObject({ event_type: 'task.completed', resource_id: 'task-evidence-1' });
    expect((await request(app).get('/evidence/task/missing')).status).toBe(404);
  });
});
