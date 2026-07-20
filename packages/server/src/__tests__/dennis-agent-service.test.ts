import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { DENNIS_AGENT_ID, DennisAgentService } from '../services/dennis-agent-service';

describe('DennisAgentService', () => {
  let db: Database.Database;
  let okfBase: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    okfBase = fs.mkdtempSync(path.join(os.tmpdir(), 'dennis-agent-okf-'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(okfBase, { recursive: true, force: true });
  });

  it('registers Dennis Agent, writes OKF, and records heartbeat evidence', () => {
    const service = new DennisAgentService(db, { okfBase });

    const result = service.heartbeat({ test: true });

    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(DENNIS_AGENT_ID) as any;
    expect(row.status).toBe('active');
    expect(row.last_heartbeat_at).toBe(result.last_heartbeat_at);
    expect(JSON.parse(row.capabilities)).toContain('openmythos-gate');
    expect(JSON.parse(row.metadata).blocked_without_approval).toContain('production_mutation');
    expect(result.okf_concept_path).toContain('dennis-agent.md');
    expect(fs.existsSync(result.okf_concept_path!)).toBe(true);
    expect(result.trace_span_id).toBeTruthy();

    const snapshot = service.readinessSnapshot();
    expect(snapshot.agent_registered).toBe(true);
    expect(snapshot.heartbeat_fresh).toBe(true);
    expect(snapshot.counts.trace_spans).toBe(1);
    expect(snapshot.self_context.identity).toMatchObject({
      agent_id: DENNIS_AGENT_ID,
      sentience_claim: 'not_sentient',
      behavior_model: 'evidence_driven_digital_twin_context',
    });
    expect(snapshot.self_context.access_manifest).toMatchObject({
      id: 'dennis-agent-safe-mode-v1',
      status: 'candidate',
      risk_ceiling: 'medium',
    });
    expect(snapshot.self_context.access_manifest.read_scopes).toContain('openclaw:state_counts');
    expect(snapshot.self_context.access_manifest.read_scopes).toContain('hermes:presence');
    expect(snapshot.self_context.access_manifest.allowed_actions).toContain('telegram:create_dry_run_task');
    expect(snapshot.self_context.access_manifest.approval_required_actions).toContain('external:message');
    expect(snapshot.self_context.access_manifest.forbidden_actions).toContain('self_approve');
    expect(snapshot.self_context.access_manifest.required_evidence).toContain('openmythos:skill_lifecycle_gate');
    expect(snapshot.self_context.evidence_sources).toContain('agent_trace_spans');
    expect(snapshot.self_context.recent_trace_refs[0]).toMatchObject({
      name: 'dennis-agent-heartbeat',
      status: 'ok',
    });
    expect(snapshot.self_context.ecosystem_contract.learned_from).toContain('OpenClaw');
    expect(snapshot.self_context.ecosystem_contract.learned_from).toContain('Hermes');
    expect(snapshot.self_context.ecosystem_contract.rules).toContain('read_memory_before_planning');
    expect(snapshot.self_context.ecosystem_contract.rules).toContain('openmythos_gate_before_skill_or_behavior_promotion');
  });

  it('upserts without duplicating the agent row', () => {
    const service = new DennisAgentService(db, { okfBase });

    service.heartbeat({ run: 1 });
    service.heartbeat({ run: 2 });

    const row = db.prepare('SELECT COUNT(*) as c FROM agents WHERE id = ?').get(DENNIS_AGENT_ID) as any;
    expect(row.c).toBe(1);
    const metadata = JSON.parse((db.prepare('SELECT metadata FROM agents WHERE id = ?').get(DENNIS_AGENT_ID) as any).metadata);
    expect(metadata.run).toBe(2);
  });

  it('does not rewrite OKF files on every heartbeat', () => {
    const service = new DennisAgentService(db, { okfBase });

    service.heartbeat({ run: 1 });
    const conceptPath = path.join(okfBase, 'agents', 'dennis-agent.md');
    const indexPath = path.join(okfBase, 'agents', 'index.md');
    const concept = fs.readFileSync(conceptPath, 'utf8');
    const index = fs.readFileSync(indexPath, 'utf8');

    service.heartbeat({ run: 2 });

    expect(fs.readFileSync(conceptPath, 'utf8')).toBe(concept);
    expect(fs.readFileSync(indexPath, 'utf8')).toBe(index);
  });

  it('preserves existing OKF agents when regenerating the index', () => {
    fs.mkdirSync(path.join(okfBase, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(okfBase, 'agents', 'index.md'), [
      '---',
      'type: Agent',
      'title: "agents/"',
      'description: "Agent index"',
      '---',
      '# Agents',
      '',
      '* [Workstation](workstation.md) — active',
      '',
      '## Zie ook',
      '',
      '- [[repos/djimitflo]] — Djimitflo',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(okfBase, 'agents', 'workstation.md'), [
      '---',
      'type: Agent',
      'title: Workstation',
      'resource: http://192.168.1.28:3001',
      'tags: [hermes]',
      'timestamp: 2026-07-17T00:00:00Z',
      'status: active',
      'capabilities: [code]',
      '---',
      '',
      '# Workstation',
    ].join('\n'));

    new DennisAgentService(db, { okfBase }).heartbeat();

    const index = fs.readFileSync(path.join(okfBase, 'agents', 'index.md'), 'utf8');
    expect(index).toContain('title: "agents/"');
    expect(index).toContain('workstation.md');
    expect(index).toContain('dennis-agent.md');
    expect(index).toContain('[[repos/djimitflo]]');
  });

  it('imports Paperclip pending JSONL as dry-run Dennis tasks idempotently', () => {
    const pending = path.join(okfBase, 'paperclip.pending.jsonl');
    fs.writeFileSync(pending, [
      JSON.stringify({
        event: 'review.failed',
        task_type: 'review_fix',
        task_title: 'Fix failing review',
        severity: 'high',
        dedupe_key: 'repo:sha:review.failed',
        repo: 'djimit/example',
        sha: 'abc123',
        affected_files: ['src/a.ts'],
      }),
      'not-json',
    ].join('\n'));

    const service = new DennisAgentService(db, { okfBase });
    service.heartbeat();
    const first = service.importPaperclipPending(pending);
    const second = service.importPaperclipPending(pending);

    expect(first.imported_tasks).toBe(1);
    expect(first.imported_work_items).toBe(1);
    expect(first.skipped).toBe(1);
    expect(second.imported_tasks).toBe(0);
    expect(second.imported_work_items).toBe(0);
    expect(second.skipped).toBe(2);

    const task = db.prepare("SELECT * FROM tasks WHERE agent_id = ? AND execution_mode = 'dry_run'").get(DENNIS_AGENT_ID) as any;
    expect(task.title).toBe('Fix failing review');
    expect(task.risk_level).toBe('high');
    expect(JSON.parse(task.metadata).blocked_without_approval).toContain('production_mutation');
  });

  it('processes imported dry-run tasks into completion evidence without executing mutations', () => {
    const pending = path.join(okfBase, 'paperclip.pending.jsonl');
    fs.writeFileSync(pending, JSON.stringify({
      event: 'review.failed',
      task_type: 'review_fix',
      task_title: 'Fix failing review',
      severity: 'high',
      dedupe_key: 'repo:sha:review.failed',
      affected_files: ['src/a.ts'],
    }));

    const service = new DennisAgentService(db, { okfBase });
    service.heartbeat();
    service.importPaperclipPending(pending);

    const result = service.processDryRunTasks();

    expect(result.processed).toBe(1);
    expect(result.work_items_blocked).toBe(1);
    const task = db.prepare("SELECT * FROM tasks WHERE agent_id = ? AND execution_mode = 'dry_run'").get(DENNIS_AGENT_ID) as any;
    expect(task.status).toBe('completed');
    expect(task.completed_at).toBeTruthy();
    const metadata = JSON.parse(task.metadata);
    expect(metadata.dry_run_plan.gates).toContain('human_approval_required_before_execution');
    const event = db.prepare("SELECT * FROM execution_events WHERE task_id = ? AND event_type = 'dennis_dry_run_plan'").get(task.id) as any;
    expect(JSON.parse(event.tool_output).next_actions).toContain('Prepare the smallest safe patch in a branch or worktree.');
    const workItem = db.prepare("SELECT * FROM work_items WHERE assigned_agent_id = ? AND source = 'paperclip_pending_jsonl'").get(DENNIS_AGENT_ID) as any;
    expect(workItem.status).toBe('blocked');
    expect(JSON.parse(workItem.metadata).blocked_reason).toBe('human_approval_required_before_execution');
    const approvalId = JSON.parse(workItem.metadata).approval_id;
    const approval = db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId) as any;
    expect(approval.status).toBe('pending');
    expect(JSON.parse(approval.metadata).dennis_action).toBe('materialize_dry_run');
    const snapshot = service.readinessSnapshot();
    expect(snapshot.counts.dry_run_pending_tasks).toBe(0);
    expect(snapshot.counts.paperclip_blocked_work_items).toBe(1);
    expect(snapshot.blocked_reasons).toContain('paperclip_work_items_waiting_for_human_approval');
    expect(snapshot.approval_queue[0]).toMatchObject({
      title: 'Fix failing review',
      risk_class: 'high',
      task_id: task.id,
      blocked_reason: 'human_approval_required_before_execution',
    });
    expect(snapshot.self_context.recent_task_refs[0]).toMatchObject({
      title: 'Fix failing review',
      status: 'completed',
      risk_level: 'high',
    });

    db.prepare("UPDATE approvals SET status = 'approved', approved_at = ? WHERE id = ?").run(new Date().toISOString(), approvalId);
    const materialized = service.materializeApprovedDryRun(approvalId, 'test-user');
    expect(materialized.status).toBe('materialized');
    expect(materialized.event_id).toBeTruthy();
    const materializedEvent = db.prepare("SELECT * FROM execution_events WHERE id = ? AND event_type = 'dennis_approved_dry_run_materialized'").get(materialized.event_id) as any;
    expect(JSON.parse(materializedEvent.tool_output).executed_mutations).toEqual([]);
    const doneWorkItem = db.prepare('SELECT * FROM work_items WHERE id = ?').get(workItem.id) as any;
    expect(doneWorkItem.status).toBe('done');
  });
});
