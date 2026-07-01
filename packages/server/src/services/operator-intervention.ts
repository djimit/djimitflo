import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { LoopService } from './loop-service';
import { SwarmIntelligenceService } from './swarm-intelligence-service';
import { swarmEventBus } from './swarm-event-bus';

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
 * - pause a goal (drain in-flight leases via G9)
 * - resume a paused goal (re-queue via G10)
 * - inject knowledge (add a claim to the semantic store)
 * - override a gate decision (force proceed or stop)
 *
 * Each intervention emits an event on the SSE stream (G14) + is logged in the audit trail.
 */

export class OperatorInterventionService {
  constructor(
    private db: Database,
    private loops: LoopService,
    private intelligence: SwarmIntelligenceService,
  ) {}

  /**
   * G22: Pause a goal — drain in-flight leases gracefully (G9).
   */
  async pauseGoal(goalId: string): Promise<{ paused: boolean; drained: number }> {
    // Find the active loop run for this goal.
    const run = this.db.prepare(
      'SELECT id FROM loop_runs WHERE goal_id = ? AND status IN (\'running\', \'verifying\', \'planning\') ORDER BY created_at DESC LIMIT 1',
    ).get(goalId) as { id: string } | undefined;

    if (!run) {
      return { paused: false, drained: 0 };
    }

    // Drain runtime leases for this run.
    const drainResult = await this.loops.drainRuntimeLeases(30_000);

    // Mark the run as interrupted (resumable by G10).
    this.db.prepare('UPDATE loop_runs SET status = ?, metadata = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run('interrupted', JSON.stringify({ interrupted_reason: 'operator_pause', interrupted_at: new Date().toISOString() }), run.id);

    // Mark the goal as blocked.
    this.db.prepare('UPDATE goals SET status = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run('blocked', goalId);

    swarmEventBus.emit('convergence', {
      intervention: 'pause',
      goal_id: goalId,
      run_id: run.id,
      drained: drainResult.drained,
      checkpointed: drainResult.checkpointed,
    });

    return { paused: true, drained: drainResult.drained };
  }

  /**
   * G22: Resume a paused goal — re-queue pending findings via G10.
   */
  resumeGoal(goalId: string): { resumed: boolean; requeued: number } {
    const run = this.db.prepare(
      'SELECT id FROM loop_runs WHERE goal_id = ? AND status = \'interrupted\' ORDER BY created_at DESC LIMIT 1',
    ).get(goalId) as { id: string } | undefined;

    if (!run) {
      return { resumed: false, requeued: 0 };
    }

    const result = this.loops.resumeInterruptedRun(run.id);

    // Mark the goal as running again.
    if (result.resumed) {
      this.db.prepare('UPDATE goals SET status = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run('running', goalId);
    }

    swarmEventBus.emit('convergence', {
      intervention: 'resume',
      goal_id: goalId,
      run_id: run.id,
      resumed: result.resumed,
      requeued: result.requeuedFindings.length,
    });

    return { resumed: result.resumed, requeued: result.requeuedFindings.length };
  }

  /**
   * G22: Inject knowledge — add a claim to the semantic store.
   */
  injectKnowledge(goalId: string, claim: {
    predicate: string;
    subject_ref: string;
    confidence: number;
    evidence: string;
  }): { injected: boolean; claim_id: string } {
    const claimId = `operator_inject_${Date.now()}`;

    this.intelligence.createClaim({
      claim: `Operator injection: ${claim.evidence}`,
      claim_type: 'observation',
      subject_ref: claim.subject_ref,
      predicate: claim.predicate,
      confidence: claim.confidence,
      status: 'supported',
      evidence_refs: [`operator:${goalId}`],
      verified_by_gate: 'operator_injection',
      created_from: 'operator_intervention',
      metadata: { goal_id: goalId, operator_injected: true },
    });

    swarmEventBus.emit('convergence', {
      intervention: 'inject',
      goal_id: goalId,
      claim_id: claimId,
      predicate: claim.predicate,
    });

    return { injected: true, claim_id: claimId };
  }

  /**
   * G22: Override a gate decision — force proceed or stop.
   */
  overrideGate(goalId: string, gateName: string, decision: 'proceed' | 'stop', reason: string): { overridden: boolean } {
    const run = this.db.prepare(
      'SELECT id, gates_json FROM loop_runs WHERE goal_id = ? ORDER BY created_at DESC LIMIT 1',
    ).get(goalId) as { id: string; gates_json: string } | undefined;

    if (!run) {
      return { overridden: false };
    }

    const gates = JSON.parse(run.gates_json || '[]') as Array<{ name: string; status: string; evidence: string }>;
    const updatedGates = gates.map(g => {
      if (g.name === gateName) {
        return {
          ...g,
          status: decision === 'proceed' ? 'pass' : 'fail',
          evidence: `OPERATOR OVERRIDE: ${reason}`,
        };
      }
      return g;
    });

    this.db.prepare('UPDATE loop_runs SET gates_json = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(JSON.stringify(updatedGates), run.id);

    swarmEventBus.emit('convergence', {
      intervention: 'override',
      goal_id: goalId,
      run_id: run.id,
      gate: gateName,
      decision,
      reason,
    });

    return { overridden: true };
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
