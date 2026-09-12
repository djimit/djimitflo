import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { LoopService } from './loop-service';
import { SwarmIntelligenceService } from './swarm-intelligence-service';
import { swarmEventBus } from './swarm-event-bus';
import { AuditEventType } from '@djimitflo/shared';
import { AuditService } from './audit-service';
import { createError } from '../middleware/error-handler';
import { LoopRunMutationService } from './loop-run-mutation-service';

export interface InterventionRequest {
  id: string;
  runId: string;
  reason: string;
  context: Record<string, unknown>;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  createdAt: string;
  resolvedAt: string | null;
  resolution: string | null;
}

interface InterventionRow {
  id: string;
  run_id: string;
  reason: string;
  context_json: string;
  status: string;
  created_at: string;
  resolved_at: string | null;
  resolution: string | null;
}

/**
 * G22: OperatorInterventionService — structured operator intervention protocol.
 *
 * Allows the operator to:
 * - pause a quiescent goal (active/prepared work must settle or be stopped first)
 * - resume only its operator-owned pause, without redispatch or recovery approval
 * - inject knowledge (add a claim to the semantic store)
 * - record an advisory gate decision, never replace executable verification
 *
 * Each intervention emits an event on the SSE stream (G14) + is logged in the audit trail.
 */

export class OperatorInterventionService {
  constructor(
    private db: Database,
    private loops: LoopService,
    private intelligence: SwarmIntelligenceService,
  ) {}

  private goal(goalId: string) {
    if (!this.db.prepare('SELECT id FROM goals WHERE id = ?').get(goalId)) throw createError(404, 'GOAL_NOT_FOUND', 'GOAL_NOT_FOUND');
    return this.loops.getGoal(goalId);
  }

  private audit(goalId: string, action: string, actorId?: string, metadata: Record<string, unknown> = {}) {
    return new AuditService(this.db).record({ event_type: AuditEventType.CONFIG_CHANGED, action: `operator.${action}`, resource_type: 'goal', resource_id: goalId, user_id: actorId, metadata });
  }

  /**
   * Pause admission only when quiescent. This does not pretend to checkpoint a CLI.
   */
  async pauseGoal(goalId: string, actorId?: string): Promise<{ paused: boolean; drained: number }> {
    const changed = this.db.transaction(() => {
      const goal = this.goal(goalId);
      if (goal.metadata.operator_paused === true) return false;
      if (['completed', 'failed', 'cancelled', 'blocked'].includes(goal.status)) throw createError(409, 'GOAL_NOT_PAUSABLE', 'GOAL_NOT_PAUSABLE');
      const runs = (this.db.prepare("SELECT id FROM loop_runs WHERE goal_id = ? AND status NOT IN ('completed','failed','cancelled','escalated')").all(goalId) as { id: string }[]).map(row => this.loops.getLoopRun(row.id));
      const busy = this.db.prepare("SELECT 1 FROM worker_leases w JOIN loop_runs r ON r.id=w.loop_run_id WHERE r.goal_id=? AND w.status IN ('prepared','running') LIMIT 1").get(goalId);
      const task = this.db.prepare("SELECT 1 FROM tasks t JOIN loop_runs r ON r.id=json_extract(CASE WHEN json_valid(t.metadata) THEN t.metadata ELSE '{}' END,'$.loop_run_id') WHERE r.goal_id=? AND (t.status NOT IN ('completed','failed','cancelled') OR json_extract(t.metadata,'$.execution_recovery_hold')=1) LIMIT 1").get(goalId);
      if (busy || task) throw createError(409, 'OPERATOR_GOAL_BUSY: settle or stop existing workers before pausing; live checkpoint/drain is unavailable', 'OPERATOR_GOAL_BUSY');
      if (runs.some(run => run.status === 'interrupted')) throw createError(409, 'GOAL_RECOVERY_REQUIRED', 'GOAL_RECOVERY_REQUIRED');
      const now = new Date().toISOString();
      const mutations = new LoopRunMutationService(this.db);
      for (const run of runs) mutations.updateStatus(run.id, 'interrupted', { operator_paused: true, operator_pause_previous_status: run.status, interrupted_reason: 'operator_pause', interrupted_at: now });
      this.db.prepare('UPDATE goals SET status=?,metadata=?,updated_at=? WHERE id=?').run('blocked', JSON.stringify({ ...goal.metadata, operator_paused: true, operator_pause_previous_status: goal.status }), now, goalId);
      this.audit(goalId, 'pause', actorId, { run_ids: runs.map(run => run.id), drained: 0, checkpointed: false });
      return true;
    })();
    if (changed) swarmEventBus.emit('convergence', { intervention: 'pause', goal_id: goalId, drained: 0, checkpointed: false });
    return { paused: true, drained: 0 };
  }

  /**
   * Restore operator-paused admission; execution still requires explicit dispatch.
   */
  resumeGoal(goalId: string, actorId?: string): { resumed: boolean; requeued: number } {
    this.db.transaction(() => {
      const goal = this.goal(goalId);
      if (goal.metadata.operator_paused !== true) throw createError(409, 'GOAL_NOT_OPERATOR_PAUSED', 'GOAL_NOT_OPERATOR_PAUSED');
      if (goal.status !== 'blocked') throw createError(409, 'GOAL_PAUSE_STATE_CHANGED', 'GOAL_PAUSE_STATE_CHANGED');
      const runs = (this.db.prepare('SELECT id FROM loop_runs WHERE goal_id=?').all(goalId) as { id: string }[]).map(row => this.loops.getLoopRun(row.id)).filter(run => run.metadata.operator_paused === true);
      const mutations = new LoopRunMutationService(this.db);
      for (const run of runs) {
        // A stop after pause remains terminal; resume never revives it.
        if (run.status !== 'interrupted') continue;
        const previous = run.metadata.operator_pause_previous_status;
        if (typeof previous !== 'string' || !['created','planning','running','verifying','blocked','ready_for_human_merge'].includes(previous)) throw createError(409, 'GOAL_PAUSE_STATE_INVALID', 'GOAL_PAUSE_STATE_INVALID');
        mutations.updateStatus(run.id, previous as typeof run.status, { operator_paused: false, operator_resumed_at: new Date().toISOString() });
      }
      const previous = goal.metadata.operator_pause_previous_status;
      if (typeof previous !== 'string' || !['created','decomposed','running'].includes(previous)) throw createError(409, 'GOAL_PAUSE_STATE_INVALID', 'GOAL_PAUSE_STATE_INVALID');
      this.db.prepare('UPDATE goals SET status=?,metadata=?,updated_at=? WHERE id=?').run(previous, JSON.stringify({ ...goal.metadata, operator_paused: false }), new Date().toISOString(), goalId);
      this.audit(goalId, 'resume', actorId, { requeued: 0, automatic_dispatch: false });
    })();
    swarmEventBus.emit('convergence', { intervention: 'resume', goal_id: goalId, resumed: true, requeued: 0 });
    return { resumed: true, requeued: 0 };
  }

  /**
   * G22: Inject knowledge — add a claim to the semantic store.
   */
  injectKnowledge(goalId: string, claim: {
    predicate: string;
    subject_ref: string;
    confidence: number;
    evidence: string;
  }, actorId?: string): { injected: boolean; claim_id: string } {
    this.goal(goalId);
    if (!claim || ![claim.evidence, claim.predicate, claim.subject_ref].every(value => typeof value === 'string' && value.trim()) || typeof claim.confidence !== 'number' || !Number.isFinite(claim.confidence) || claim.confidence < 0 || claim.confidence > 1) throw createError(400, 'INTERVENTION_CLAIM_INVALID', 'INTERVENTION_CLAIM_INVALID');
    const stored = this.db.transaction(() => {
      // Audit first: a failed audit must not publish a claim onto the knowledge bus.
      const auditId = this.audit(goalId, 'inject', actorId, { subject_ref: claim.subject_ref, predicate: claim.predicate });
      const result = this.intelligence.createClaim({
      claim: `Operator injection: ${claim.evidence}`,
      claim_type: 'observation',
      subject_ref: claim.subject_ref,
      predicate: claim.predicate,
      confidence: claim.confidence,
      status: 'proposed',
      evidence_refs: [],
      created_from: 'operator_intervention',
      metadata: { goal_id: goalId, operator_injected: true, operator_id: actorId || null, audit_event_id: auditId },
      });
      return result;
    })();

    swarmEventBus.emit('convergence', {
      intervention: 'inject',
      goal_id: goalId,
      claim_id: stored.id,
      predicate: claim.predicate,
    });

    return { injected: true, claim_id: stored.id };
  }

  /**
   * Record operator intent separately from measured gate status.
   */
  overrideGate(goalId: string, gateName: string, decision: 'proceed' | 'stop', reason: string, actorId?: string): { overridden: boolean; recorded: boolean } {
    this.goal(goalId);
    if (typeof gateName !== 'string' || !gateName.trim() || !['proceed', 'stop'].includes(decision) || typeof reason !== 'string' || !reason.trim()) throw createError(400, 'INTERVENTION_DECISION_INVALID', 'INTERVENTION_DECISION_INVALID');
    const run = this.db.prepare(
      'SELECT id, gates_json FROM loop_runs WHERE goal_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    ).get(goalId) as { id: string; gates_json: string } | undefined;

    if (!run) {
      throw createError(404, 'LOOP_RUN_NOT_FOUND', 'LOOP_RUN_NOT_FOUND');
    }

    const gates = JSON.parse(run.gates_json || '[]') as Array<{ name: string; status: string; evidence: string }>;
    if (!gates.some(gate => gate.name === gateName)) throw createError(404, 'LOOP_GATE_NOT_FOUND', 'LOOP_GATE_NOT_FOUND');
    this.db.transaction(() => {
      const current = this.loops.getLoopRun(run.id);
      if (['completed','cancelled','failed','escalated'].includes(current.status)) throw createError(409, 'LOOP_RUN_TERMINAL', 'LOOP_RUN_TERMINAL');
      const decisions = Array.isArray(current.metadata.operator_gate_decisions) ? current.metadata.operator_gate_decisions : [];
      const entry = { gate: gateName, decision, reason: reason.trim(), operator_id: actorId || null, recorded_at: new Date().toISOString(), advisory_only: true };
      new LoopRunMutationService(this.db).patchMetadata(run.id, { operator_gate_decisions: [...decisions, entry] });
      this.audit(goalId, 'gate_decision', actorId, { run_id: run.id, ...entry });
    })();

    swarmEventBus.emit('convergence', {
      intervention: 'override',
      goal_id: goalId,
      run_id: run.id,
      gate: gateName,
      decision,
      reason,
    });

    return { overridden: false, recorded: true };
  }

  // G58: Intervention request/approve/reject protocol

  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS intervention_requests (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        context_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT,
        resolution TEXT
      )
    `);
  }

  requestIntervention(runId: string, reason: string, context: Record<string, unknown> = {}): InterventionRequest {
    this.ensureTable();
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO intervention_requests (id, run_id, reason, context_json, status)
      VALUES (?, ?, ?, ?, 'pending')
    `).run(id, runId, reason, JSON.stringify(context));

    swarmEventBus.emit('convergence', {
      intervention: 'requested',
      request_id: id,
      run_id: runId,
      reason,
    });

    return { id, runId, reason, context, status: 'pending', createdAt: now, resolvedAt: null, resolution: null };
  }

  approveIntervention(requestId: string): void {
    this.ensureTable();
    this.db.prepare("UPDATE intervention_requests SET status = 'approved', resolved_at = datetime('now') WHERE id = ?").run(requestId);
    swarmEventBus.emit('convergence', { intervention: 'approved', request_id: requestId });
  }

  rejectIntervention(requestId: string, feedback: string): void {
    this.ensureTable();
    this.db.prepare("UPDATE intervention_requests SET status = 'rejected', resolved_at = datetime('now'), resolution = ? WHERE id = ?").run(feedback, requestId);
    swarmEventBus.emit('convergence', { intervention: 'rejected', request_id: requestId, feedback });
  }

  getPendingInterventions(): InterventionRequest[] {
    this.ensureTable();
    const rows = this.db.prepare("SELECT * FROM intervention_requests WHERE status = 'pending' ORDER BY created_at ASC").all() as InterventionRow[];
    return rows.map(this.rowToRequest);
  }

  getInterventionHistory(limit: number = 20): InterventionRequest[] {
    this.ensureTable();
    const rows = this.db.prepare("SELECT * FROM intervention_requests ORDER BY created_at DESC LIMIT ?").all(limit) as InterventionRow[];
    return rows.map(this.rowToRequest);
  }

  expireIntervention(requestId: string): void {
    this.ensureTable();
    this.db.prepare("UPDATE intervention_requests SET status = 'expired', resolved_at = datetime('now') WHERE id = ? AND status = 'pending'").run(requestId);
  }

  private rowToRequest(row: InterventionRow): InterventionRequest {
    return {
      id: row.id,
      runId: row.run_id,
      reason: row.reason,
      context: JSON.parse(row.context_json) as Record<string, unknown>,
      status: row.status as InterventionRequest['status'],
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
      resolution: row.resolution,
    };
  }
}
