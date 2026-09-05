import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { errorHandler } from '../middleware/error-handler';
import { createWorkItemRoutes } from '../routes/work-items';

let requestedPermissions: string[] = [];
let denyApproval = false;
const auth = {
  requirePermission: (permission: string) => (req: any, res: any, next: any) => {
    requestedPermissions.push(permission);
    if (permission === 'approve:task' && denyApproval) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Forbidden' } });
      return;
    }
    req.user = { sub: 'integration-test-operator' };
    next();
  },
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

function securityFindingPayload(sourceIdentity = 'git:sha256:abc123', severity: 'low' | 'medium' | 'high' | 'critical' = 'high') {
  return {
    source: 'security_finding',
    source_ref: 'codeql:upstream-alert-42',
    title: 'Authorization bypass in admin route',
    description: 'A user-controlled identifier reaches an administrative operation without an ownership check.',
    risk_class: 'low',
    recommended_loop: 'repo-maintenance-loop',
    metadata: {
      security: {
        target: 'packages/server/src/routes/admin.ts',
        source_identity: sourceIdentity,
        tool: 'CodeQL',
        rule_id: 'js/missing-authorization',
        location: 'packages/server/src/routes/admin.ts:42',
        severity,
        cia_impact: ['confidentiality', 'integrity'],
        threat: 'An authenticated tenant user can modify another tenant.',
        attack_path: ['HTTP route parameter', 'admin update handler'],
        evidence_refs: ['artifact:codeql-sarif:run-42'],
        standard_refs: ['OWASP:A01'],
      },
    },
  };
}

describe('agentic OS integration inbox', () => {
  beforeEach(async () => {
    requestedPermissions = [];
    denyApproval = false;
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

  it('rejects incomplete security findings at the integration boundary', async () => {
    const response = await fetch(`${baseUrl}/work-items/integrations/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'security_finding',
        title: 'Unproven finding',
        description: 'No scanner identity or evidence was supplied.',
        metadata: { security: { severity: 'high' } },
      }),
    });

    expect(response.status).toBe(400);
    expect((await response.json() as any).error.code).toBe('SECURITY_FINDING_CONTRACT_INCOMPLETE');
    expect(workItemCount()).toBe(0);
  });

  it('normalizes security severity, identity, and loop without trusting caller overrides', async () => {
    const response = await fetch(`${baseUrl}/work-items/integrations/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(securityFindingPayload()),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.work_item_input).toMatchObject({
      source: 'security_finding',
      risk_class: 'high',
      status: 'candidate',
      recommended_loop: 'security-regression-loop',
      metadata: {
        security: {
          source_identity: 'git:sha256:abc123',
          severity: 'high',
        },
        integration: {
          upstream_source_ref: 'codeql:upstream-alert-42',
        },
      },
    });
    expect(body.work_item_input.source_ref).toMatch(/^security:sha256:[a-f0-9]{64}$/);
    expect(body.work_item_input.metadata.security.fingerprint).toBe(body.work_item_input.source_ref);
    expect(workItemCount()).toBe(0);
  });

  it('rejects direct security creation and authorizes terminal changes against resulting risk', async () => {
    const preview = await fetch(`${baseUrl}/work-items/integrations/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(securityFindingPayload()),
    });
    const terminalInput = (await preview.json() as any).work_item_input;
    const direct = await fetch(`${baseUrl}/work-items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...terminalInput,
        status: 'discarded',
        metadata: {
          ...terminalInput.metadata,
          security: {
            ...terminalInput.metadata.security,
            disposition: {
              type: 'false_positive',
              reason: 'Direct terminal creation must not be authoritative.',
              evidence_refs: ['review:direct-create'],
              security_checker_ref: 'review:security-checker',
              human_approval_ref: 'caller:forged',
            },
          },
        },
      }),
    });
    expect(direct.status).toBe(400);
    expect((await direct.json() as any).error.code).toBe('SECURITY_FINDING_IMPORT_REQUIRED');

    const imported = await fetch(`${baseUrl}/work-items/integrations/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(securityFindingPayload('git:sha256:low123', 'low')),
    });
    const lowItem = (await imported.json() as any).work_item;
    requestedPermissions = [];
    denyApproval = true;
    const escalation = await fetch(`${baseUrl}/work-items/${lowItem.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        risk_class: 'high',
        status: 'discarded',
        metadata: {
          ...lowItem.metadata,
          security: {
            ...lowItem.metadata.security,
            severity: 'high',
            disposition: {
              type: 'false_positive',
              reason: 'Attempted combined escalation and closure.',
              evidence_refs: ['review:escalation'],
              security_checker_ref: 'review:security-checker',
              human_approval_ref: 'caller:forged',
            },
          },
        },
      }),
    });
    expect(escalation.status).toBe(403);
    expect(requestedPermissions).toContain('approve:task');
    expect(db.prepare('SELECT status, risk_class FROM work_items WHERE id = ?').get(lowItem.id)).toMatchObject({
      status: 'candidate',
      risk_class: 'low',
    });
  });

  it('keeps scanner provenance immutable outside the import boundary', async () => {
    const imported = await fetch(`${baseUrl}/work-items/integrations/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(securityFindingPayload()),
    });
    const item = (await imported.json() as any).work_item;

    const response = await fetch(`${baseUrl}/work-items/${item.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        metadata: {
          ...item.metadata,
          security: {
            ...item.metadata.security,
            source_identity: 'git:sha256:forged',
            evidence_refs: ['artifact:forged'],
          },
        },
      }),
    });
    expect(response.status).toBe(409);
    expect((await response.json() as any).error.code).toBe('SECURITY_FINDING_PROVENANCE_IMMUTABLE');
  });

  it('preserves active workflow state and server metadata across a new scanner delivery', async () => {
    const imported = await fetch(`${baseUrl}/work-items/integrations/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(securityFindingPayload()),
    });
    const item = (await imported.json() as any).work_item;
    const converted = await fetch(`${baseUrl}/work-items/${item.id}/convert-to-goal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    const planned = (await converted.json() as any).work_item;

    const repeated = await fetch(`${baseUrl}/work-items/integrations/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(securityFindingPayload('git:sha256:next-active')),
    });
    const updated = (await repeated.json() as any).work_item;
    expect(updated.status).toBe('planned');
    expect(updated.parent_goal_id).toBe(planned.parent_goal_id);
    expect(updated.metadata.converted_to_goal_at).toBe(planned.metadata.converted_to_goal_at);
    expect(updated.metadata.security.source_identity).toBe('git:sha256:next-active');
  });

  it('fails closed on security risk downgrade and evidence-free closure', async () => {
    const imported = await fetch(`${baseUrl}/work-items/integrations/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(securityFindingPayload()),
    });
    expect(imported.status).toBe(201);
    const item = (await imported.json() as any).work_item;

    const downgrade = await fetch(`${baseUrl}/work-items/${item.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ risk_class: 'low' }),
    });
    expect(downgrade.status).toBe(409);
    expect((await downgrade.json() as any).error.code).toBe('SECURITY_FINDING_RISK_DOWNGRADE_FORBIDDEN');

    const close = await fetch(`${baseUrl}/work-items/${item.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    });
    expect(close.status).toBe(409);
    expect((await close.json() as any).error.code).toBe('SECURITY_FINDING_CLOSURE_EVIDENCE_REQUIRED');
    expect(db.prepare('SELECT status FROM work_items WHERE id = ?').get(item.id)).toMatchObject({ status: 'candidate' });
  });

  it('requires the finding\'s completed governed loop and preserves closure evidence on recurrence', async () => {
    const imported = await fetch(`${baseUrl}/work-items/integrations/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(securityFindingPayload()),
    });
    const item = (await imported.json() as any).work_item;
    const convertedResponse = await fetch(`${baseUrl}/work-items/${item.id}/convert-to-goal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(convertedResponse.status).toBe(201);
    const converted = await convertedResponse.json() as any;
    const baseClosure = {
      remediation_ref: 'git:commit:def456',
      rescan_ref: 'artifact:codeql-sarif:run-43',
      loop_ref: 'loop:security-loop-43',
      regression_refs: ['test:authorization-boundary'],
    };

    const ungoverned = await fetch(`${baseUrl}/work-items/${item.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        status: 'done',
        metadata: { ...item.metadata, security: { ...item.metadata.security, closure: baseClosure } },
      }),
    });
    expect(ungoverned.status).toBe(409);
    expect((await ungoverned.json() as any).error.code).toBe('SECURITY_FINDING_LOOP_EVIDENCE_REQUIRED');

    db.prepare(`
      INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, gates_json, metadata, completed_at)
      VALUES (?, ?, 'security-regression-loop', 'closed', 'completed', ?, ?, datetime('now'))
    `).run(
      'security-loop-43',
      converted.goal_id,
      JSON.stringify([
        { name: 'maker_checker_separation', status: 'pass' },
        { name: 'checker_verdict', status: 'pass' },
        { name: 'tests_lint_typecheck', status: 'pass' },
        { name: 'security_checker_verdict', status: 'pass' },
      ]),
      JSON.stringify({ human_approval_ref: 'operator:loop-approver' })
    );

    const closed = await fetch(`${baseUrl}/work-items/${item.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        status: 'done',
        metadata: {
          ...item.metadata,
          security: {
            ...item.metadata.security,
            closure: {
              ...baseClosure,
            },
          },
        },
      }),
    });
    expect(closed.status).toBe(200);
    const closedItem = await closed.json() as any;
    expect(closedItem.status).toBe('done');
    expect(closedItem.metadata.security.closure.human_approval_ref).toBe('operator:integration-test-operator');
    expect(requestedPermissions).toContain('approve:task');

    const exactReplay = await fetch(`${baseUrl}/work-items/integrations/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(securityFindingPayload()),
    });
    const replayedItem = (await exactReplay.json() as any).work_item;
    expect(replayedItem.status).toBe('done');
    expect(replayedItem.metadata.security.resolution_history).toBeUndefined();

    const rewriteClosure = await fetch(`${baseUrl}/work-items/${item.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        metadata: {
          ...closedItem.metadata,
          security: {
            ...closedItem.metadata.security,
            closure: { ...closedItem.metadata.security.closure, rescan_ref: 'artifact:forged' },
          },
        },
      }),
    });
    expect(rewriteClosure.status).toBe(409);
    expect((await rewriteClosure.json() as any).error.code).toBe('SECURITY_FINDING_RESOLUTION_IMMUTABLE');

    const manualReopen = await fetch(`${baseUrl}/work-items/${item.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'candidate' }),
    });
    expect(manualReopen.status).toBe(409);
    expect((await manualReopen.json() as any).error.code).toBe('SECURITY_FINDING_REOPEN_IMPORT_REQUIRED');

    const recurrent = await fetch(`${baseUrl}/work-items/integrations/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(securityFindingPayload('git:sha256:new456')),
    });
    expect(recurrent.status).toBe(200);
    const recurrentItem = (await recurrent.json() as any).work_item;
    expect(recurrentItem.id).toBe(item.id);
    expect(recurrentItem.status).toBe('candidate');
    expect(recurrentItem.parent_goal_id).toBeNull();
    expect(recurrentItem.metadata.security.source_identity).toBe('git:sha256:new456');
    expect(recurrentItem.metadata.security.resolution_history[0]).toMatchObject({
      status: 'done',
      source_identity: 'git:sha256:abc123',
      evidence: { loop_ref: 'loop:security-loop-43' },
    });
    expect(workItemCount()).toBe(1);

    const eraseHistory = await fetch(`${baseUrl}/work-items/${item.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        metadata: {
          ...recurrentItem.metadata,
          security: { ...recurrentItem.metadata.security, resolution_history: [] },
        },
      }),
    });
    expect(eraseHistory.status).toBe(409);
    expect((await eraseHistory.json() as any).error.code).toBe('SECURITY_FINDING_HISTORY_IMMUTABLE');
  });
});
