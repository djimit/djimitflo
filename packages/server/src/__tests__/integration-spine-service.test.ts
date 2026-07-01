import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { errorHandler } from '../middleware/error-handler';
import { createWorkItemRoutes } from '../routes/work-items';

const auth = {
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
} as any;

let db: Database.Database;
let server: Server;
let baseUrl: string;

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/work-items', createWorkItemRoutes(db, auth));
  app.use(errorHandler);
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
}

function workItemCount(): number {
  return (db.prepare('SELECT COUNT(*) as count FROM work_items').get() as any).count;
}

function insertCapability(id: string, status: 'candidate' | 'validated', risk = 'low', score = 0.9, threshold = 0.75) {
  db.prepare(`
    INSERT INTO swarm_capabilities (
      id, kind, owner, version, status, risk_ceiling, input_schema_ref, output_schema_ref,
      allowed_actions_json, forbidden_actions_json, required_evidence_json, eval_score,
      eval_threshold, cost_model_json, removal_strategy, metadata, created_at, updated_at
    ) VALUES (?, 'openai_mcp_connector', 'test', '1', ?, ?, 'in', 'out', '["propose_work"]', '["start_worker"]', '["source_event"]', ?, ?, '{}', 'disable', '{}', datetime('now'), datetime('now'))
  `).run(id, status, risk, score, threshold);
}

describe('agentic OS integration inbox', () => {
  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    await startApp();
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
    db.close();
  });

  it('previews normalized integration work without writes', async () => {
    const response = await fetch(`${baseUrl}/work-items/integrations/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'telegram_command',
        source_ref: 'telegram:ops:42',
        title: 'Run repo maintenance check',
        description: 'Operator requested a bounded maintenance pass.',
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body).toMatchObject({
      dry_run: true,
      blocked_reasons: [],
      work_item_input: {
        source: 'telegram_command',
        source_ref: 'telegram:ops:42',
        status: 'triaged',
        recommended_loop: 'repo-maintenance-loop',
        metadata: {
          integration: {
            source: 'telegram_command',
            source_ref: 'telegram:ops:42',
          },
        },
      },
    });
    expect(workItemCount()).toBe(0);
  });

  it('imports integration work idempotently by source ref', async () => {
    const payload = {
      source: 'github_issue',
      source_ref: 'djimitflo/app#77',
      title: 'Initial title',
      description: 'Initial issue body.',
      risk_class: 'medium',
      metadata: { github: { issue_number: 77 } },
    };

    const first = await fetch(`${baseUrl}/work-items/integrations/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(first.status).toBe(201);
    const created = await first.json() as any;

    const second = await fetch(`${baseUrl}/work-items/integrations/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, title: 'Updated title' }),
    });
    expect(second.status).toBe(200);
    const updated = await second.json() as any;

    expect(updated.created).toBe(false);
    expect(updated.work_item.id).toBe(created.work_item.id);
    expect(updated.work_item.title).toBe('Updated title');
    expect(workItemCount()).toBe(1);
  });

  it('defaults MCP and OKF drift to their existing loop paths', async () => {
    const mcp = await fetch(`${baseUrl}/work-items/integrations/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'mcp_drift',
        title: 'MCP permission drift',
        description: 'Connector metadata needs review.',
      }),
    });
    const okf = await fetch(`${baseUrl}/work-items/integrations/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'okf_drift',
        title: 'OKF capability drift',
        description: 'Knowledge runtime reports stale capability projection.',
      }),
    });

    expect((await mcp.json() as any).work_item_input.recommended_loop).toBe('mcp-connector-validation-loop');
    expect((await okf.json() as any).work_item_input.recommended_loop).toBe('okf-synchronization-loop');
    expect(workItemCount()).toBe(0);
  });

  it('blocks unvalidated connector capabilities without blocking validated low-risk proposals', async () => {
    insertCapability('cap-candidate', 'candidate');
    insertCapability('cap-live', 'validated');

    const blocked = await fetch(`${baseUrl}/work-items/integrations/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'mcp_drift',
        title: 'Candidate connector wants work',
        description: 'This connector has not been validated.',
        metadata: { integration: { capability_id: 'cap-candidate' } },
      }),
    });
    const allowed = await fetch(`${baseUrl}/work-items/integrations/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'mcp_drift',
        title: 'Validated connector proposes work',
        description: 'This connector can propose bounded work.',
        metadata: { integration: { capability_id: 'cap-live' } },
      }),
    });

    const blockedBody = await blocked.json() as any;
    const allowedBody = await allowed.json() as any;
    expect(blockedBody.blocked_reasons).toContain('capability_not_validated');
    expect(blockedBody.work_item_input.status).toBe('blocked');
    expect(allowedBody.blocked_reasons).toEqual([]);
    expect(allowedBody.work_item_input.status).toBe('triaged');
    expect(workItemCount()).toBe(0);
  });
});
