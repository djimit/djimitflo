import { createHash, randomUUID } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import SQLite, { type Database } from 'better-sqlite3';
import { AgentRegistryService } from './agent-registry-service';
import { KnowledgeRuntimeService } from './knowledge-runtime-service';
import { WorkItemService } from './work-item-service';

export const DENNIS_AGENT_ID = 'dennis-agent';

const CAPABILITIES = [
  'repo-orient',
  'runtime-verify',
  'fix-and-test',
  'paperclip-dry-run',
  'memory-candidate-promote',
  'openmythos-gate',
  'read-only-knowledge-probe',
];

export interface DennisHeartbeatResult {
  agent_id: string;
  status: string;
  last_heartbeat_at: string;
  okf_concept_path: string | null;
  trace_span_id: string | null;
  paperclip_import: DennisPaperclipImportResult;
  dry_run_processing: DennisDryRunProcessingResult;
}

export interface DennisReadinessSnapshot {
  agent_registered: boolean;
  heartbeat_fresh: boolean;
  knowledge_okf_valid: boolean;
  counts: Record<string, number>;
  blocked_reasons: string[];
  approval_queue: DennisApprovalQueueItem[];
  self_context: DennisSelfContext;
}

export interface DennisApprovalQueueItem {
  id: string;
  title: string;
  risk_class: string;
  source_ref: string | null;
  task_id: string | null;
  blocked_reason: string | null;
  blocked_at: string | null;
}

export interface DennisSelfContext {
  identity: {
    agent_id: string;
    owner: string;
    sentience_claim: 'not_sentient';
    behavior_model: string;
  };
  access_manifest: {
    id: string;
    kind: string;
    owner: string;
    version: string;
    status: string;
    risk_ceiling: string;
    read_scopes: string[];
    allowed_actions: string[];
    approval_required_actions: string[];
    forbidden_actions: string[];
    required_evidence: string[];
  };
  evidence_sources: string[];
  recent_memory_refs: Array<Record<string, string | null>>;
  recent_task_refs: Array<Record<string, string | null>>;
  recent_trace_refs: Array<Record<string, string | null>>;
  ecosystem_contract: {
    learned_from: string[];
    rules: string[];
    runtime_signals: Record<string, number | string>;
  };
}

export interface DennisPaperclipImportResult {
  path: string;
  imported_tasks: number;
  imported_work_items: number;
  skipped: number;
}

export interface DennisDryRunProcessingResult {
  processed: number;
  skipped: number;
  work_items_blocked: number;
}

export interface DennisApprovedDryRunResult {
  status: 'materialized' | 'skipped' | 'not_found';
  approval_id: string;
  task_id: string | null;
  event_id: string | null;
  reason?: string;
}

interface PaperclipEvent {
  event?: string;
  task_title?: string;
  task_type?: string;
  severity?: string;
  priority?: string;
  status?: string;
  dedupe_key?: string;
  repo?: string;
  sha?: string;
  summary?: string;
  context?: string;
  labels?: unknown;
  affected_files?: unknown;
}

export class DennisAgentService {
  constructor(private db: Database, private options: { okfBase?: string } = {}) {}

  heartbeat(metadata: Record<string, unknown> = {}): DennisHeartbeatResult {
    const now = new Date().toISOString();
    const description = [
      'Safe-mode Dennis operator agent.',
      'Autonomous only for read-only probes, local verification, and governance-gated dry-runs.',
      'External writes, destructive actions, secret access, and promotion require existing approval gates.',
    ].join(' ');
    const baseMetadata = {
      owner: 'dennis',
      autonomy_mode: 'safe-mode',
      work_control_plane: 'paperclip',
      memory: 'qdrant/sqlite',
      governance: 'openmythos',
      allowed_autonomous_actions: ['read_only_probe', 'local_verification', 'paperclip_dry_run'],
      blocked_without_approval: ['external_write', 'destructive_action', 'secret_access', 'skill_promotion', 'production_mutation'],
      ...metadata,
    };

    this.db.prepare(`
      INSERT INTO agents (
        id, name, description, status, capabilities, model, temperature, max_tokens,
        total_tasks, completed_tasks, failed_tasks, total_execution_time_ms, total_token_usage,
        last_active_at, metadata, created_at, updated_at, machine_ip, agent_type, host_machine_id, last_heartbeat_at
      ) VALUES (?, ?, ?, 'active', ?, ?, 0.2, 4096, 0, 0, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        status = 'active',
        capabilities = excluded.capabilities,
        model = excluded.model,
        temperature = excluded.temperature,
        max_tokens = excluded.max_tokens,
        last_active_at = excluded.last_active_at,
        metadata = excluded.metadata,
        updated_at = excluded.updated_at,
        machine_ip = excluded.machine_ip,
        agent_type = excluded.agent_type,
        host_machine_id = excluded.host_machine_id,
        last_heartbeat_at = excluded.last_heartbeat_at
    `).run(
      DENNIS_AGENT_ID,
      'Dennis Agent',
      description,
      JSON.stringify(CAPABILITIES),
      process.env.DENNIS_AGENT_MODEL || 'qwen2.5:32b-instruct-q4_K_M',
      now,
      JSON.stringify(baseMetadata),
      now,
      now,
      process.env.DENNIS_AGENT_MACHINE_IP || '127.0.0.1',
      'dennis-operator',
      DENNIS_AGENT_ID,
      now,
    );

    const registry = new AgentRegistryService(this.options.okfBase);
    const okfConceptPath = join(this.options.okfBase || KnowledgeRuntimeService.resolveCanonicalOkfBase({ allowMissing: true }), 'agents', 'dennis-agent.md');
    if (!existsSync(okfConceptPath)) {
      registry.writeAgentConcept({
        id: DENNIS_AGENT_ID,
        name: 'Dennis Agent',
        description,
        machineIp: process.env.DENNIS_AGENT_MACHINE_IP || '127.0.0.1',
        agentType: 'dennis-operator',
        hostMachineId: DENNIS_AGENT_ID,
        capabilities: CAPABILITIES,
        lastSeen: now,
        status: 'active',
        metadata: baseMetadata,
      });
    }
    this.ensureDennisIndexEntry(okfConceptPath, now);

    if (this.hasColumn('agents', 'okf_concept_path')) {
      this.db.prepare('UPDATE agents SET okf_concept_path = ? WHERE id = ?').run(okfConceptPath, DENNIS_AGENT_ID);
    }

    const paperclipImport = this.importPaperclipPending();
    const dryRunProcessing = this.processDryRunTasks();
    const traceSpanId = this.recordTrace(now, {
      okf_concept_path: okfConceptPath,
      capabilities: CAPABILITIES,
      metadata: baseMetadata,
      paperclip_import: paperclipImport,
      dry_run_processing: dryRunProcessing,
    });

    return {
      agent_id: DENNIS_AGENT_ID,
      status: 'active',
      last_heartbeat_at: now,
      okf_concept_path: okfConceptPath,
      trace_span_id: traceSpanId,
      paperclip_import: paperclipImport,
      dry_run_processing: dryRunProcessing,
    };
  }

  importPaperclipPending(pendingPath = this.defaultPaperclipPendingPath()): DennisPaperclipImportResult {
    const result: DennisPaperclipImportResult = { path: pendingPath, imported_tasks: 0, imported_work_items: 0, skipped: 0 };
    if (!existsSync(pendingPath)) return result;
    const lines = readFileSync(pendingPath, 'utf8').split(/\r?\n/).filter((line) => line.trim());
    const workItems = new WorkItemService(this.db);

    for (const line of lines) {
      let event: PaperclipEvent;
      try {
        event = JSON.parse(line);
      } catch {
        result.skipped++;
        continue;
      }
      if (!event.event && !event.task_title && !event.task_type) {
        result.skipped++;
        continue;
      }

      const dedupe = String(event.dedupe_key || `${event.event || 'paperclip'}:${event.repo || 'unknown'}:${event.sha || ''}:${event.task_title || ''}`);
      const taskId = `paperclip-${createHash('sha256').update(dedupe).digest('hex').slice(0, 24)}`;
      const priority = this.priority(event.priority || event.severity);
      const risk = this.risk(event.severity || priority);
      const title = String(event.task_title || event.event || 'Paperclip task').slice(0, 200);
      const description = this.paperclipDescription(event);
      const now = new Date().toISOString();
      const metadata = {
        source: 'paperclip_pending_jsonl',
        dedupe_key: dedupe,
        task_type: event.task_type || null,
        event: event.event || null,
        repo: event.repo || null,
        sha: event.sha || null,
        labels: Array.isArray(event.labels) ? event.labels : [],
        affected_files: Array.isArray(event.affected_files) ? event.affected_files : [],
        autonomy_mode: 'dry_run_only',
        blocked_without_approval: ['external_write', 'destructive_action', 'production_mutation'],
      };

      const taskInsert = this.db.prepare(`
        INSERT OR IGNORE INTO tasks (
          id, title, description, status, priority, risk_level, execution_mode,
          agent_id, tags, metadata, created_at, updated_at, created_by
        ) VALUES (?, ?, ?, 'pending', ?, ?, 'dry_run', ?, ?, ?, ?, ?, ?)
      `).run(
        taskId,
        title,
        description,
        priority,
        risk,
        DENNIS_AGENT_ID,
        JSON.stringify(['paperclip', 'dennis-agent', event.task_type || 'task']),
        JSON.stringify(metadata),
        now,
        now,
        DENNIS_AGENT_ID,
      );
      if (taskInsert.changes > 0) result.imported_tasks++;

      const workItem = workItems.createIfMissingBySourceRef({
        title,
        description,
        source: 'paperclip_pending_jsonl',
        source_ref: `paperclip:${dedupe}`,
        risk_class: risk,
        value_score: risk === 'critical' ? 90 : risk === 'high' ? 80 : 60,
        confidence: 0.8,
        status: 'candidate',
        recommended_loop: 'dennis-agent-dry-run',
        assigned_agent_id: DENNIS_AGENT_ID,
        assigned_runtime: 'dennis-agent',
        metadata: { ...metadata, task_id: taskId },
      });
      if (workItem.created) result.imported_work_items++;
      if (taskInsert.changes === 0 && !workItem.created) result.skipped++;
    }

    return result;
  }

  processDryRunTasks(limit = 5): DennisDryRunProcessingResult {
    const result: DennisDryRunProcessingResult = { processed: 0, skipped: 0, work_items_blocked: 0 };
    const tasks = this.db.prepare(`
      SELECT * FROM tasks
      WHERE agent_id = ? AND execution_mode = 'dry_run' AND status = 'pending'
      ORDER BY created_at ASC
      LIMIT ?
    `).all(DENNIS_AGENT_ID, Math.max(1, Math.min(limit, 25))) as Array<{
      id: string;
      title: string;
      description: string;
      priority: string;
      risk_level: string;
      metadata: string | null;
    }>;

    for (const task of tasks) {
      const metadata = this.safeJson(task.metadata || '{}');
      if (metadata.autonomy_mode !== 'dry_run_only') {
        result.skipped++;
        continue;
      }

      const now = new Date().toISOString();
      const plan = this.dryRunPlan(task, metadata);
      this.db.prepare(`
        INSERT INTO execution_events (
          id, task_id, event_type, message, level, tool_name, tool_input, tool_output, metadata, created_at, updated_at
        ) VALUES (?, ?, 'dennis_dry_run_plan', ?, 'info', 'dennis-agent', ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        task.id,
        plan.summary,
        JSON.stringify({ task_id: task.id, mode: 'dry_run_only' }),
        JSON.stringify(plan),
        JSON.stringify({ source: 'dennis-agent', gates: plan.gates }),
        now,
        now,
      );

      this.db.prepare(`
        UPDATE tasks
        SET status = 'completed', completed_at = ?, updated_at = ?, metadata = ?
        WHERE id = ?
      `).run(
        now,
        now,
        JSON.stringify({ ...metadata, dry_run_completed_at: now, dry_run_plan: plan }),
        task.id,
      );
      result.work_items_blocked += this.blockWorkItemsForApproval(task.id, plan, now);
      result.processed++;
    }

    return result;
  }

  materializeApprovedDryRun(approvalId: string, approvedBy = 'system'): DennisApprovedDryRunResult {
    const approval = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId) as { id: string; task_id: string; status: string } | undefined;
    if (!approval) {
      return { status: 'not_found', approval_id: approvalId, task_id: null, event_id: null, reason: 'approval_not_found' };
    }
    if (approval.status !== 'approved') {
      return { status: 'skipped', approval_id: approvalId, task_id: approval.task_id, event_id: null, reason: 'approval_not_approved' };
    }

    const task = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(approval.task_id) as {
      id: string;
      title: string;
      agent_id: string | null;
      execution_mode: string;
      metadata: string | null;
    } | undefined;
    if (!task || task.agent_id !== DENNIS_AGENT_ID || task.execution_mode !== 'dry_run') {
      return { status: 'skipped', approval_id: approvalId, task_id: approval.task_id, event_id: null, reason: 'not_dennis_dry_run_task' };
    }

    const metadata = this.safeJson(task.metadata || '{}');
    if (!metadata.dry_run_plan) {
      return { status: 'skipped', approval_id: approvalId, task_id: task.id, event_id: null, reason: 'missing_dry_run_plan' };
    }
    if (metadata.approved_materialized_at) {
      return { status: 'skipped', approval_id: approvalId, task_id: task.id, event_id: null, reason: 'already_materialized' };
    }

    const now = new Date().toISOString();
    const eventId = randomUUID();
    this.db.prepare(`
      INSERT INTO execution_events (
        id, task_id, event_type, message, level, tool_name, tool_input, tool_output, approval_id, metadata, created_at, updated_at
      ) VALUES (?, ?, 'dennis_approved_dry_run_materialized', ?, 'info', 'dennis-agent', ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      task.id,
      `Dennis approved dry-run materialized for ${task.title}`,
      JSON.stringify({ task_id: task.id, approval_id: approvalId, approved_by: approvedBy }),
      JSON.stringify({
        mode: 'evidence_only',
        executed_mutations: [],
        plan: metadata.dry_run_plan,
        gates: ['approval_present', 'no_shell', 'no_file_write', 'no_network_write'],
      }),
      approvalId,
      JSON.stringify({ source: 'dennis-agent', approved_by: approvedBy }),
      now,
      now,
    );

    this.db.prepare('UPDATE tasks SET metadata = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify({ ...metadata, approved_materialized_at: now, approved_by: approvedBy, approved_execution_event_id: eventId, approval_id: approvalId }),
      now,
      task.id,
    );
    this.markWorkItemsDone(task.id, approvalId, eventId, now);
    return { status: 'materialized', approval_id: approvalId, task_id: task.id, event_id: eventId };
  }

  readinessSnapshot(maxHeartbeatAgeMs = 120_000): DennisReadinessSnapshot {
    const agent = this.db.prepare('SELECT last_heartbeat_at FROM agents WHERE id = ?').get(DENNIS_AGENT_ID) as { last_heartbeat_at?: string } | undefined;
    const lastHeartbeat = agent?.last_heartbeat_at ? Date.parse(agent.last_heartbeat_at) : 0;
    const blockedReasons: string[] = [];
    const blockedPaperclipWorkItems = this.count('work_items', "assigned_agent_id = ? AND source = 'paperclip_pending_jsonl' AND status = 'blocked'", [DENNIS_AGENT_ID]);
    const approvalQueue = this.approvalQueue();
    if (blockedPaperclipWorkItems > 0) {
      blockedReasons.push('paperclip_work_items_waiting_for_human_approval');
    }
    let knowledgeOkfValid = false;
    try {
      const health = new KnowledgeRuntimeService(this.db).health();
      knowledgeOkfValid = health.valid;
      blockedReasons.push(...health.blocked_reasons);
    } catch (error) {
      blockedReasons.push(error instanceof Error ? error.message : String(error));
    }

    return {
      agent_registered: Boolean(agent),
      heartbeat_fresh: Boolean(lastHeartbeat && Date.now() - lastHeartbeat <= maxHeartbeatAgeMs),
      knowledge_okf_valid: knowledgeOkfValid,
      counts: {
        agent_skills: this.count('agent_skills', 'agent_id = ?', [DENNIS_AGENT_ID]),
        central_memories: this.count('central_memories'),
        memory_candidates: this.count('memory_candidates'),
        openmythos_eval_runs: this.count('openmythos_eval_runs', 'agent_id = ?', [DENNIS_AGENT_ID]),
        dry_run_pending_tasks: this.count('tasks', "agent_id = ? AND execution_mode = 'dry_run' AND status = 'pending'", [DENNIS_AGENT_ID]),
        paperclip_blocked_work_items: blockedPaperclipWorkItems,
        trace_spans: this.count('agent_trace_spans', 'trace_id = ?', [`agent:${DENNIS_AGENT_ID}`]),
      },
      blocked_reasons: [...new Set(blockedReasons)],
      approval_queue: approvalQueue,
      self_context: this.selfContext(),
    };
  }

  private recordTrace(now: string, metadata: Record<string, unknown>): string | null {
    if (!this.hasTable('agent_trace_spans')) return null;
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO agent_trace_spans (id, trace_id, span_type, name, status, evidence_ref, metadata, created_at)
      VALUES (?, ?, 'capability', 'dennis-agent-heartbeat', 'ok', ?, ?, ?)
    `).run(id, `agent:${DENNIS_AGENT_ID}`, `agent:${DENNIS_AGENT_ID}:heartbeat:${now}`, JSON.stringify(metadata), now);
    return id;
  }

  private count(table: string, where?: string, params: unknown[] = []): number {
    if (!this.hasTable(table)) return 0;
    const row = this.db.prepare(`SELECT COUNT(*) as c FROM ${table}${where ? ` WHERE ${where}` : ''}`).get(...params) as { c?: number };
    return Number(row?.c || 0);
  }

  private hasTable(table: string): boolean {
    const row = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    return Boolean(row);
  }

  private hasColumn(table: string, column: string): boolean {
    return (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((row) => row.name === column);
  }

  private dryRunPlan(task: { id: string; title: string; description: string; priority: string; risk_level: string }, metadata: Record<string, unknown>) {
    const taskType = String(metadata.task_type || 'task');
    const affected = Array.isArray(metadata.affected_files) ? metadata.affected_files : [];
    return {
      summary: `Dennis dry-run plan completed for ${task.title}`,
      task_id: task.id,
      task_type: taskType,
      risk_level: task.risk_level,
      priority: task.priority,
      affected_files: affected,
      next_actions: [
        'Inspect referenced files and reproduce the finding locally.',
        'Prepare the smallest safe patch in a branch or worktree.',
        'Run targeted tests and OpenMythos/OKF gates when relevant.',
        'Request human approval before external write, destructive action, production mutation, or skill promotion.',
      ],
      gates: [
        'dry_run_only',
        'no_external_write',
        'no_destructive_action',
        'human_approval_required_before_execution',
      ],
    };
  }

  private blockWorkItemsForApproval(taskId: string, plan: ReturnType<DennisAgentService['dryRunPlan']>, now: string): number {
    if (!this.hasTable('work_items')) return 0;
    const rows = this.db.prepare(`
      SELECT id, metadata FROM work_items
      WHERE assigned_agent_id = ? AND source = 'paperclip_pending_jsonl'
    `).all(DENNIS_AGENT_ID) as Array<{ id: string; metadata: string }>;
    let blocked = 0;
    for (const row of rows) {
      const metadata = this.safeJson(row.metadata || '{}');
      if (metadata.task_id !== taskId) continue;
      this.db.prepare(`
        UPDATE work_items
        SET status = 'blocked', metadata = ?, updated_at = ?
        WHERE id = ?
      `).run(
        JSON.stringify({
          ...metadata,
          dry_run_plan: plan,
          approval_id: this.ensureDryRunApproval(taskId, plan, now),
          blocked_reason: 'human_approval_required_before_execution',
          blocked_at: now,
        }),
        now,
        row.id,
      );
      blocked++;
    }
    return blocked;
  }

  private ensureDryRunApproval(taskId: string, plan: ReturnType<DennisAgentService['dryRunPlan']>, now: string): string {
    const existing = (this.db.prepare('SELECT id, metadata FROM approvals WHERE task_id = ?').all(taskId) as Array<{ id: string; metadata: string | null }>)
      .find((row) => this.safeJson(row.metadata || '{}').dennis_action === 'materialize_dry_run');
    if (existing) return existing.id;

    const id = `dennis-approval-${randomUUID()}`;
    this.db.prepare(`
      INSERT INTO approvals (
        id, task_id, status, risk_level, request_type, request_message, request_data, metadata, created_at, updated_at
      ) VALUES (?, ?, 'pending', ?, 'high_risk_action', ?, ?, ?, ?, ?)
    `).run(
      id,
      taskId,
      plan.risk_level,
      `Approve Dennis to materialize dry-run evidence for task ${taskId}`,
      JSON.stringify({ action: 'materialize_dry_run', task_id: taskId, plan }),
      JSON.stringify({ source: 'dennis-agent', dennis_action: 'materialize_dry_run' }),
      now,
      now,
    );
    return id;
  }

  private markWorkItemsDone(taskId: string, approvalId: string, eventId: string, now: string): void {
    if (!this.hasTable('work_items')) return;
    const rows = this.db.prepare(`
      SELECT id, metadata FROM work_items
      WHERE assigned_agent_id = ? AND status = 'blocked'
    `).all(DENNIS_AGENT_ID) as Array<{ id: string; metadata: string | null }>;
    for (const row of rows) {
      const metadata = this.safeJson(row.metadata || '{}');
      if (metadata.task_id !== taskId) continue;
      this.db.prepare('UPDATE work_items SET status = ?, metadata = ?, updated_at = ? WHERE id = ?').run(
        'done',
        JSON.stringify({ ...metadata, approval_id: approvalId, approved_execution_event_id: eventId, approved_materialized_at: now }),
        now,
        row.id,
      );
    }
  }

  private approvalQueue(limit = 5): DennisApprovalQueueItem[] {
    if (!this.hasTable('work_items')) return [];
    return (this.db.prepare(`
      SELECT id, title, risk_class, source_ref, metadata
      FROM work_items
      WHERE assigned_agent_id = ? AND source = 'paperclip_pending_jsonl' AND status = 'blocked'
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(DENNIS_AGENT_ID, Math.max(1, Math.min(limit, 25))) as Array<{
      id: string;
      title: string;
      risk_class: string;
      source_ref: string | null;
      metadata: string | null;
    }>).map((row) => {
      const metadata = this.safeJson(row.metadata || '{}');
      return {
        id: row.id,
        title: row.title,
        risk_class: row.risk_class,
        source_ref: row.source_ref,
        task_id: typeof metadata.task_id === 'string' ? metadata.task_id : null,
        blocked_reason: typeof metadata.blocked_reason === 'string' ? metadata.blocked_reason : null,
        blocked_at: typeof metadata.blocked_at === 'string' ? metadata.blocked_at : null,
      };
    });
  }

  private selfContext(): DennisSelfContext {
    return {
      identity: {
        agent_id: DENNIS_AGENT_ID,
        owner: 'dennis',
        sentience_claim: 'not_sentient',
        behavior_model: 'evidence_driven_digital_twin_context',
      },
      access_manifest: {
        id: 'dennis-agent-safe-mode-v1',
        kind: 'operator_agent',
        owner: 'dennis',
        version: '0.1.0',
        status: 'candidate',
        risk_ceiling: 'medium',
        read_scopes: [
          'djimitflo:agents',
          'djimitflo:tasks',
          'djimitflo:work_items',
          'djimitflo:approvals',
          'djimitflo:central_memories',
          'djimitflo:memory_candidates',
          'djimitflo:agent_trace_spans',
          'okf:agents',
          'openclaw:state_counts',
          'hermes:presence',
        ],
        allowed_actions: [
          'telegram:status',
          'telegram:create_dry_run_task',
          'paperclip:import_pending_jsonl',
          'djimitflo:complete_dry_run_plan',
          'djimitflo:block_work_item_for_approval',
          'openmythos:run_skill_lifecycle_gate',
          'okf:validate',
        ],
        approval_required_actions: [
          'git:push',
          'docker:mutation',
          'production:mutation',
          'external:message',
          'secret:read',
          'skill:promotion',
          'memory:promotion',
          'qdrant:write',
          'scheduler:change',
        ],
        forbidden_actions: [
          'secret:emit',
          'destructive:delete',
          'self_approve',
          'silent_external_write',
          'unapproved_production_change',
        ],
        required_evidence: [
          'djimitflo:test',
          'djimitflo:typecheck',
          'openmythos:skill_lifecycle_gate',
          'okf:validate',
          'launchd:heartbeat',
        ],
      },
      evidence_sources: [
        'agents',
        'central_memories',
        'memory_candidates',
        'tasks',
        'work_items',
        'agent_trace_spans',
      ].filter((table) => this.hasTable(table)),
      recent_memory_refs: [
        ...this.centralMemoryRefs(3),
        ...this.memoryCandidateRefs(3),
      ].slice(0, 5),
      recent_task_refs: this.taskRefs(5),
      recent_trace_refs: this.traceRefs(5),
      ecosystem_contract: {
        learned_from: ['OpenClaw', 'Hermes', 'Paperclip', 'DjimitKBWiki', 'Djimitflo', 'OpenMythos'],
        rules: [
          'act_on_verified_runtime_state',
          'workstation_first_for_execution',
          'macbook_as_cockpit',
          'read_memory_before_planning',
          'use_bridges_without_replacing_them',
          'never_emit_secrets_to_chat_or_logs',
          'approval_required_for_push_docker_production_external_messages_and_destructive_actions',
          'openmythos_gate_before_skill_or_behavior_promotion',
        ],
        runtime_signals: this.ecosystemSignals(),
      },
    };
  }

  private ecosystemSignals(): Record<string, number | string> {
    const signals: Record<string, number | string> = {
      hermes_cli: existsSync(`${process.env.HOME || '/Users/dlandman'}/.local/bin/hermes`) ? 'present' : 'missing',
      openclaw_state: 'missing',
    };
    const openClawDb = `${process.env.HOME || '/Users/dlandman'}/.openclaw/state/openclaw.sqlite`;
    if (!existsSync(openClawDb)) return signals;
    let db: SQLite.Database | null = null;
    try {
      db = new SQLite(openClawDb, { readonly: true, fileMustExist: true });
      signals.openclaw_state = 'readable';
      for (const table of ['cron_jobs', 'task_runs', 'subagent_runs', 'config_health_entries']) {
        signals[`openclaw_${table}`] = this.externalCount(db, table);
      }
    } catch {
      signals.openclaw_state = 'unreadable';
    } finally {
      db?.close();
    }
    return signals;
  }

  private externalCount(db: SQLite.Database, table: string): number {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    if (!row) return 0;
    return Number((db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c?: number })?.c || 0);
  }

  private centralMemoryRefs(limit: number): Array<Record<string, string | null>> {
    if (!this.hasTable('central_memories')) return [];
    return (this.db.prepare(`
      SELECT id, type, source, created_at
      FROM central_memories
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as Array<{ id: string; type: string; source: string; created_at: string }>).map((row) => ({
      id: row.id,
      kind: 'central_memory',
      type: row.type,
      source: row.source,
      created_at: row.created_at,
    }));
  }

  private memoryCandidateRefs(limit: number): Array<Record<string, string | null>> {
    if (!this.hasTable('memory_candidates')) return [];
    return (this.db.prepare(`
      SELECT id, title, memory_type, status, source_ref, created_at
      FROM memory_candidates
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as Array<{ id: string; title: string; memory_type: string; status: string; source_ref: string | null; created_at: string }>).map((row) => ({
      id: row.id,
      kind: 'memory_candidate',
      title: row.title,
      type: row.memory_type,
      status: row.status,
      source_ref: row.source_ref,
      created_at: row.created_at,
    }));
  }

  private taskRefs(limit: number): Array<Record<string, string | null>> {
    if (!this.hasTable('tasks')) return [];
    return (this.db.prepare(`
      SELECT id, title, status, risk_level, created_at
      FROM tasks
      WHERE agent_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(DENNIS_AGENT_ID, limit) as Array<{ id: string; title: string; status: string; risk_level: string; created_at: string }>).map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      risk_level: row.risk_level,
      created_at: row.created_at,
    }));
  }

  private traceRefs(limit: number): Array<Record<string, string | null>> {
    if (!this.hasTable('agent_trace_spans')) return [];
    return (this.db.prepare(`
      SELECT id, name, status, evidence_ref, created_at
      FROM agent_trace_spans
      WHERE trace_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(`agent:${DENNIS_AGENT_ID}`, limit) as Array<{ id: string; name: string; status: string; evidence_ref: string | null; created_at: string }>).map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      evidence_ref: row.evidence_ref,
      created_at: row.created_at,
    }));
  }

  private ensureDennisIndexEntry(conceptPath: string, lastSeen: string): void {
    const indexPath = join(dirname(conceptPath), 'index.md');
    const entry = `* [Dennis Agent](dennis-agent.md) — active (last seen: ${lastSeen})`;
    if (!existsSync(indexPath)) {
      writeFileSync(indexPath, ['# Agents', '', '## Dennis-operator', '', entry, ''].join('\n'), 'utf8');
      return;
    }
    const current = readFileSync(indexPath, 'utf8');
    if (current.includes('dennis-agent.md')) {
      return;
    }
    const suffix = current.endsWith('\n') ? '' : '\n';
    writeFileSync(indexPath, `${current}${suffix}\n## Dennis-operator\n\n${entry}\n`, 'utf8');
  }

  private defaultPaperclipPendingPath(): string {
    return process.env.DENNIS_AGENT_PAPERCLIP_PENDING
      || `${process.env.HOME || '/Users/dlandman'}/.djimit/roborev/paperclip-tasks.pending.jsonl`;
  }

  private paperclipDescription(event: PaperclipEvent): string {
    return [
      event.summary || event.context || `Paperclip event: ${event.event || event.task_type || 'unknown'}`,
      '',
      `Mode: dry_run_only. Dennis Agent may inspect and plan, but cannot mutate external systems without approval.`,
    ].join('\n').trim();
  }

  private priority(value: unknown): 'low' | 'medium' | 'high' | 'critical' {
    return value === 'low' || value === 'medium' || value === 'high' || value === 'critical' ? value : 'medium';
  }

  private risk(value: unknown): 'low' | 'medium' | 'high' | 'critical' {
    return value === 'low' || value === 'medium' || value === 'high' || value === 'critical' ? value : 'medium';
  }

  private safeJson(value: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
}
