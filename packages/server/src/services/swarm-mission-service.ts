/**
 * SwarmMissionService — mission/task/decision state machine.
 *
 * Extracted from SwarmIntelligenceService (~150 LOC) to isolate the
 * mission lifecycle management from the rest of the swarm intelligence system.
 */

import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

type MissionStatus = 'observed' | 'hypothesized' | 'planned' | 'queued' | 'prepared' | 'running' | 'checking' | 'ready_for_human_merge' | 'completed' | 'blocked' | 'rejected' | 'escalated';
type RiskClass = 'low' | 'medium' | 'high' | 'critical';
const RISK_CLASSES: RiskClass[] = ['low', 'medium', 'high', 'critical'];

interface MissionRecord {
  id: string;
  goal_id: string | null;
  title: string;
  description: string;
  risk_class: RiskClass;
  status: MissionStatus;
  panel_id: string | null;
  evidence_refs: string[];
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface TaskRecord {
  id: string;
  mission_id: string;
  title: string;
  description: string;
  status: MissionStatus;
  assigned_lease_id: string | null;
  capability_id: string | null;
  evidence_refs: string[];
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface DecisionRecord {
  id: string;
  mission_id: string;
  task_id: string | null;
  decision_type: string;
  decision: string;
  reason: string;
  actor: string;
  evidence_refs: string[];
  gate_refs: string[];
  blocked_reasons: string[];
  created_at: string;
}

export class SwarmMissionService {
  private static readonly MISSION_TRANSITIONS: Record<string, string[]> = {
    observed: ['hypothesized', 'rejected'],
    hypothesized: ['planned', 'rejected', 'escalated'],
    planned: ['queued', 'rejected', 'escalated'],
    queued: ['prepared', 'blocked', 'escalated'],
    prepared: ['running', 'blocked', 'escalated'],
    running: ['checking', 'blocked', 'escalated'],
    checking: ['ready_for_human_merge', 'blocked', 'rejected', 'escalated'],
    ready_for_human_merge: ['completed', 'rejected', 'escalated'],
    completed: [],
    blocked: ['queued', 'rejected', 'escalated'],
    rejected: [],
    escalated: ['planned', 'rejected'],
  };

  constructor(private db: Database) {
    this.ensureTables();
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS swarm_missions (
        id TEXT PRIMARY KEY, goal_id TEXT, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        risk_class TEXT NOT NULL DEFAULT 'medium', status TEXT NOT NULL DEFAULT 'observed',
        panel_id TEXT, evidence_refs_json TEXT NOT NULL DEFAULT '[]',
        metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS swarm_tasks (
        id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'observed',
        assigned_lease_id TEXT, capability_id TEXT, evidence_refs_json TEXT NOT NULL DEFAULT '[]',
        metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS swarm_decisions (
        id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, task_id TEXT,
        decision_type TEXT NOT NULL, decision TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
        actor TEXT NOT NULL DEFAULT 'system', evidence_refs_json TEXT NOT NULL DEFAULT '[]',
        gate_refs_json TEXT NOT NULL DEFAULT '[]', blocked_reasons_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  private validateTransition(from: string, to: string): void {
    const allowed = SwarmMissionService.MISSION_TRANSITIONS[from];
    if (!allowed || !allowed.includes(to)) {
      throw new Error(`SWARM_INVALID_TRANSITION:${from}:${to}`);
    }
  }

  private stringArray(input?: string[]): string[] {
    return Array.isArray(input) ? input.filter(Boolean).map(String) : [];
  }

  private limit(value: number): number {
    return Math.max(1, Math.min(Math.round(value), 1000));
  }

  private parseMission(row: any): MissionRecord {
    return {
      id: row.id, goal_id: row.goal_id, title: row.title, description: row.description || '',
      risk_class: row.risk_class, status: row.status, panel_id: row.panel_id,
      evidence_refs: JSON.parse(row.evidence_refs_json || '[]'),
      metadata: JSON.parse(row.metadata || '{}'),
      created_at: row.created_at, updated_at: row.updated_at,
    };
  }

  private parseTask(row: any): TaskRecord {
    return {
      id: row.id, mission_id: row.mission_id, title: row.title, description: row.description || '',
      status: row.status, assigned_lease_id: row.assigned_lease_id, capability_id: row.capability_id,
      evidence_refs: JSON.parse(row.evidence_refs_json || '[]'),
      metadata: JSON.parse(row.metadata || '{}'),
      created_at: row.created_at, updated_at: row.updated_at,
    };
  }

  private parseDecision(row: any): DecisionRecord {
    return {
      id: row.id, mission_id: row.mission_id, task_id: row.task_id, decision_type: row.decision_type,
      decision: row.decision, reason: row.reason || '', actor: row.actor || 'system',
      evidence_refs: JSON.parse(row.evidence_refs_json || '[]'),
      gate_refs: JSON.parse(row.gate_refs_json || '[]'),
      blocked_reasons: JSON.parse(row.blocked_reasons_json || '[]'),
      created_at: row.created_at,
    };
  }

  // ─── Missions ─────────────────────────────────────────────────────────

  createMission(input: {
    goal_id?: string | null; title: string; description?: string;
    risk_class?: RiskClass; panel_id?: string | null;
    evidence_refs?: string[]; metadata?: Record<string, unknown>;
  }): MissionRecord {
    if (!input.title?.trim()) throw new Error('SWARM_MISSION_TITLE_REQUIRED');
    const riskClass = input.risk_class || 'medium';
    if (!RISK_CLASSES.includes(riskClass)) throw new Error('SWARM_MISSION_RISK_INVALID');
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO swarm_missions (id, goal_id, title, description, risk_class, status, panel_id, evidence_refs_json, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'observed', ?, ?, ?, ?, ?)
    `).run(id, input.goal_id || null, input.title.trim(), (input.description || '').trim(), riskClass, input.panel_id || null, JSON.stringify(this.stringArray(input.evidence_refs)), JSON.stringify(input.metadata || {}), now, now);
    return this.getMission(id);
  }

  getMission(id: string): MissionRecord {
    const row = this.db.prepare('SELECT * FROM swarm_missions WHERE id = ?').get(id);
    if (!row) throw new Error('SWARM_MISSION_NOT_FOUND');
    return this.parseMission(row as any);
  }

  listMissions(limit = 100): MissionRecord[] {
    return (this.db.prepare('SELECT * FROM swarm_missions ORDER BY created_at DESC LIMIT ?').all(this.limit(limit)) as any[]).map((row) => this.parseMission(row));
  }

  transitionMission(id: string, toStatus: MissionStatus, decisionInput?: {
    reason?: string; actor?: string; evidence_refs?: string[];
    gate_refs?: string[]; blocked_reasons?: string[];
  }): MissionRecord {
    const mission = this.getMission(id);
    if (mission.status === toStatus) return mission;
    this.validateTransition(mission.status, toStatus);
    const now = new Date().toISOString();
    this.db.prepare('UPDATE swarm_missions SET status = ?, updated_at = ? WHERE id = ?').run(toStatus, now, id);
    this.recordDecision({
      mission_id: id, task_id: null, decision_type: 'state_transition',
      decision: `${mission.status}->${toStatus}`, reason: decisionInput?.reason || '',
      actor: decisionInput?.actor || 'system', evidence_refs: decisionInput?.evidence_refs,
      gate_refs: decisionInput?.gate_refs, blocked_reasons: decisionInput?.blocked_reasons,
    });
    return this.getMission(id);
  }

  // ─── Tasks ───────────────────────────────────────────────────────────

  createTask(input: {
    mission_id: string; title: string; description?: string;
    capability_id?: string | null; evidence_refs?: string[]; metadata?: Record<string, unknown>;
  }): TaskRecord {
    if (!input.mission_id?.trim()) throw new Error('SWARM_TASK_MISSION_REQUIRED');
    if (!input.title?.trim()) throw new Error('SWARM_TASK_TITLE_REQUIRED');
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO swarm_tasks (id, mission_id, title, description, status, assigned_lease_id, capability_id, evidence_refs_json, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'observed', NULL, ?, ?, ?, ?, ?)
    `).run(id, input.mission_id.trim(), input.title.trim(), (input.description || '').trim(), input.capability_id || null, JSON.stringify(this.stringArray(input.evidence_refs)), JSON.stringify(input.metadata || {}), now, now);
    return this.getTask(id);
  }

  getTask(id: string): TaskRecord {
    const row = this.db.prepare('SELECT * FROM swarm_tasks WHERE id = ?').get(id);
    if (!row) throw new Error('SWARM_TASK_NOT_FOUND');
    return this.parseTask(row as any);
  }

  listTasks(missionId: string): TaskRecord[] {
    return (this.db.prepare('SELECT * FROM swarm_tasks WHERE mission_id = ? ORDER BY created_at ASC').all(missionId) as any[]).map((row) => this.parseTask(row));
  }

  transitionTask(id: string, toStatus: MissionStatus, decisionInput?: {
    reason?: string; actor?: string; evidence_refs?: string[];
    gate_refs?: string[]; blocked_reasons?: string[];
  }): TaskRecord {
    const task = this.getTask(id);
    if (task.status === toStatus) return task;
    this.validateTransition(task.status, toStatus);
    const now = new Date().toISOString();
    this.db.prepare('UPDATE swarm_tasks SET status = ?, updated_at = ? WHERE id = ?').run(toStatus, now, id);
    this.recordDecision({
      mission_id: task.mission_id, task_id: id, decision_type: 'task_transition',
      decision: `${task.status}->${toStatus}`, reason: decisionInput?.reason || '',
      actor: decisionInput?.actor || 'system', evidence_refs: decisionInput?.evidence_refs,
      gate_refs: decisionInput?.gate_refs, blocked_reasons: decisionInput?.blocked_reasons,
    });
    return this.getTask(id);
  }

  // ─── Decisions ───────────────────────────────────────────────────────

  listDecisions(missionId?: string, limit = 100): DecisionRecord[] {
    const query = missionId
      ? 'SELECT * FROM swarm_decisions WHERE mission_id = ? ORDER BY created_at DESC LIMIT ?'
      : 'SELECT * FROM swarm_decisions ORDER BY created_at DESC LIMIT ?';
    const params = missionId ? [missionId, this.limit(limit)] : [this.limit(limit)];
    return (this.db.prepare(query).all(...params) as any[]).map((row) => this.parseDecision(row));
  }

  private recordDecision(input: {
    mission_id: string; task_id: string | null; decision_type: string;
    decision: string; reason: string; actor: string;
    evidence_refs?: string[]; gate_refs?: string[]; blocked_reasons?: string[];
  }): DecisionRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO swarm_decisions (id, mission_id, task_id, decision_type, decision, reason, actor, evidence_refs_json, gate_refs_json, blocked_reasons_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.mission_id, input.task_id, input.decision_type, input.decision, input.reason, input.actor, JSON.stringify(this.stringArray(input.evidence_refs)), JSON.stringify(this.stringArray(input.gate_refs)), JSON.stringify(this.stringArray(input.blocked_reasons)), now);
    return { id, ...input, evidence_refs: this.stringArray(input.evidence_refs), gate_refs: this.stringArray(input.gate_refs), blocked_reasons: this.stringArray(input.blocked_reasons), created_at: now };
  }
}
