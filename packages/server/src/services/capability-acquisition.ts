import type { Database } from 'better-sqlite3';
import { SwarmIntelligenceService } from './swarm-intelligence-service';
import { knowledgeBus } from './knowledge-bus';
import { swarmEventBus } from './swarm-event-bus';

/**
 * G23: CapabilityAcquisitionService — autonomous capability acquisition.
 *
 * When a specialist encounters a novel problem with no matching capability, it emits
 * a `capability_gap` claim on the knowledge bus. This service receives the claim and
 * creates a candidate capability in swarm_capabilities. The system can then assign
 * it, measure its competence, and auto-promote or auto-deprecate it.
 */

export class CapabilityAcquisitionService {
  private unsub: (() => void) | null = null;

  constructor(
    private db: Database,
    private intelligence: SwarmIntelligenceService,
  ) {}

  /**
   * Start listening for capability_gap claims on the knowledge bus.
   */
  start(): void {
    this.unsub = knowledgeBus.subscribe('*', (claim) => {
      if (claim.predicate === 'capability_gap') {
        this.handleCapabilityGap(claim);
      }
    });
  }

  stop(): void {
    this.unsub?.();
    this.unsub = null;
  }

  /**
   * Handle a capability_gap: create a candidate capability.
   */
  private handleCapabilityGap(claim: {
    claim_id: string;
    capability_id: string | null;
    subject_ref: string;
    provenance_run: string | null;
    created_from: string | null;
  }): void {
    const capId = claim.capability_id || `auto-cap-${Date.now()}`;

    // Check if the capability already exists.
    const existing = this.db.prepare('SELECT id FROM swarm_capabilities WHERE id = ?').get(capId) as { id: string } | undefined;
    if (existing) return;

    try {
      this.intelligence.createCandidate({
        id: capId,
        kind: 'skill',
        owner: 'autonomous',
        version: '0.1.0',
        risk_ceiling: 'low',
        input_schema_ref: 'none',
        output_schema_ref: 'none',
        allowed_actions: ['spawn_runtime_worker'],
        forbidden_actions: ['deploy', 'push'],
        required_evidence: ['proof:test'],
        eval_threshold: 0.5,
        removal_strategy: 'demote_on_fail',
        metadata: {
          autonomously_acquired: true,
          acquired_from: claim.created_from,
          acquired_at: new Date().toISOString(),
          provenance_run: claim.provenance_run,
        },
      });

      swarmEventBus.emit('capability_transition', {
        capability_id: capId,
        old_status: 'none',
        new_status: 'candidate',
        reason: 'autonomous acquisition from capability_gap claim',
      });
    } catch (error) {
      // Non-fatal — the capability might already exist or validation failed.
    }
  }

  /**
   * Static helper: emit a capability_gap claim.
   */
  static emitCapabilityGap(
    fromLeaseId: string,
    fromRunId: string,
    capabilityNeeded: string,
    reason: string,
  ): void {
    knowledgeBus.publish({
      claim_id: `cap_gap_${Date.now()}`,
      capability_id: capabilityNeeded,
      predicate: 'capability_gap',
      subject_ref: `lease:${fromLeaseId}`,
      confidence: 0.5,
      status: 'supported',
      trust: 0.5,
      provenance_run: fromRunId,
      evidence_refs: [],
      created_from: fromLeaseId,
    });

    swarmEventBus.emit('convergence', {
      capability_acquisition: 'gap_detected',
      capability_needed: capabilityNeeded,
      reason,
      from_lease: fromLeaseId,
    });
  }
}
