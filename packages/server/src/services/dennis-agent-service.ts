import { createHash, randomUUID } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { Database } from 'better-sqlite3';
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
}

export interface DennisReadinessSnapshot {
  agent_registered: boolean;
  heartbeat_fresh: boolean;
  knowledge_okf_valid: boolean;
  counts: Record<string, number>;
  blocked_reasons: string[];
}

export interface DennisPaperclipImportResult {
  path: string;
  imported_tasks: number;
  imported_work_items: number;
  skipped: number;
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
    const traceSpanId = this.recordTrace(now, {
      okf_concept_path: okfConceptPath,
      capabilities: CAPABILITIES,
      metadata: baseMetadata,
      paperclip_import: paperclipImport,
    });

    return {
      agent_id: DENNIS_AGENT_ID,
      status: 'active',
      last_heartbeat_at: now,
      okf_concept_path: okfConceptPath,
      trace_span_id: traceSpanId,
      paperclip_import: paperclipImport,
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

  readinessSnapshot(maxHeartbeatAgeMs = 120_000): DennisReadinessSnapshot {
    const agent = this.db.prepare('SELECT last_heartbeat_at FROM agents WHERE id = ?').get(DENNIS_AGENT_ID) as { last_heartbeat_at?: string } | undefined;
    const lastHeartbeat = agent?.last_heartbeat_at ? Date.parse(agent.last_heartbeat_at) : 0;
    const blockedReasons: string[] = [];
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
        trace_spans: this.count('agent_trace_spans', 'trace_id = ?', [`agent:${DENNIS_AGENT_ID}`]),
      },
      blocked_reasons: [...new Set(blockedReasons)],
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
}
