import { LoopService } from './loop-service';
import { NestedSpawnService } from './nested-spawn-service';
import { SwarmIntelligenceService } from './swarm-intelligence-service';
import { knowledgeBus } from './knowledge-bus';
import { swarmEventBus } from './swarm-event-bus';

/**
 * G20: NegotiationCoordinator — inter-agent negotiation protocol.
 *
 * When a maker encounters a harder-than-expected problem, it emits a `help_request`
 * on the knowledge bus. The NegotiationCoordinator receives the request, checks if
 * a specialist with the needed capability is available (and capacity allows), and
 * spawns a nested specialist via NestedSpawnService. The response is emitted as a
 * `help_response` on the knowledge bus.
 *
 * Cycle guard: the coordinator rejects help_requests that would create a spawn cycle
 * (reuses NestedSpawnService's cycle guard via prompt_digest + ancestry check).
 */

export interface HelpRequest {
  type: 'help_request';
  from_lease_id: string;
  from_run_id: string;
  spawn_tree_id: string;
  capability_needed: string;
  reason: string;
  urgency: 'low' | 'medium' | 'high';
}

export interface HelpResponse {
  type: 'help_response';
  to_lease_id: string;
  spawned_lease_id: string | null;
  runtime: string;
  status: 'accepted' | 'rejected';
  reason: string;
}

export class NegotiationCoordinator {
  private unsub: (() => void) | null = null;

  constructor(
    private loops: LoopService,
    private spawns: NestedSpawnService,
    private intelligence: SwarmIntelligenceService,
  ) {}

  /**
   * Start listening for help_request messages on the knowledge bus.
   */
  start(): void {
    this.unsub = knowledgeBus.subscribe('*', (claim) => {
      if (claim.predicate === 'help_request') {
        this.handleHelpRequest(claim as unknown as HelpRequest & { claim_id: string });
      }
    });
  }

  /**
   * Stop listening.
   */
  stop(): void {
    this.unsub?.();
    this.unsub = null;
  }

  /**
   * Handle a help_request: check capability + capacity, spawn a specialist if possible.
   */
  private handleHelpRequest(req: HelpRequest & { claim_id: string }): void {
    try {
      // 1. Check if the needed capability exists.
      const caps = this.intelligence.listCapabilities()
        .filter(c => c.status === 'validated' || c.status === 'candidate');
      const matching = caps.filter(c => {
        const actions = c.allowed_actions as unknown as string[];
        const meta = c.metadata as Record<string, unknown> | undefined;
        const name = meta?.name as string | undefined;
        return actions.includes('spawn_runtime_worker') &&
          (c.id === req.capability_needed || (name !== undefined && name.includes(req.capability_needed)));
      });

      if (matching.length === 0) {
        this.emitHelpResponse(req, null, 'mock', 'rejected', `no capability matching '${req.capability_needed}'`);
        return;
      }

      // 2. Check capacity (AIMD controller).
      const inUse = this.loops.runtimeConcurrencyInUse();
      if (inUse >= 4) { // simplified capacity check
        this.emitHelpResponse(req, null, 'mock', 'rejected', 'capacity exhausted (AIMD limit reached)');
        return;
      }

      // 3. Spawn a nested specialist via NestedSpawnService.
      const best = matching[0];
      const runtime = (best.metadata?.runtime as string) || 'codex';

      try {
        const child = this.spawns.requestSpawn({
          spawn_tree_id: req.spawn_tree_id,
          parent_lease_id: req.from_lease_id,
          requested_by_lease_id: req.from_lease_id,
          role: 'maker',
          runtime: runtime as any,
          prompt: `Help requested: ${req.reason}. Apply capability ${best.id} to resolve the issue.`,
        }, { internal: true });

        if (child.child_lease_id) {
          this.emitHelpResponse(req, child.child_lease_id, runtime, 'accepted', `spawned specialist for ${req.capability_needed}`);
        } else {
          this.emitHelpResponse(req, null, runtime, 'rejected', 'spawn failed (gate rejected)');
        }
      } catch (spawnErr) {
        // Cycle guard or other spawn error.
        const reason = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
        this.emitHelpResponse(req, null, runtime, 'rejected', `spawn rejected: ${reason}`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.emitHelpResponse(req, null, 'mock', 'rejected', `coordinator error: ${reason}`);
    }
  }

  /**
   * Emit a help_response on the knowledge bus + SSE stream.
   */
  private emitHelpResponse(
    req: HelpRequest,
    spawnedLeaseId: string | null,
    _runtime: string,
    status: 'accepted' | 'rejected',
    reason: string,
  ): void {
    // Publish on the knowledge bus so the requesting agent receives it.
    knowledgeBus.publish({
      claim_id: `help_response_${Date.now()}`,
      capability_id: req.capability_needed,
      predicate: 'help_response',
      subject_ref: `lease:${req.from_lease_id}`,
      confidence: status === 'accepted' ? 1.0 : 0.0,
      status: status === 'accepted' ? 'supported' : 'contradicted',
      trust: status === 'accepted' ? 1.0 : 0.0,
      provenance_run: req.from_run_id,
      evidence_refs: spawnedLeaseId ? [spawnedLeaseId] : [],
      created_from: 'negotiation_coordinator',
    });

    // Emit on the SSE stream for observability.
    swarmEventBus.emit('convergence', {
      negotiation: 'help_response',
      from_lease_id: req.from_lease_id,
      spawned_lease_id: spawnedLeaseId,
      status,
      reason,
      capability_needed: req.capability_needed,
    });
  }

  /**
   * Emit a help_request (used by a maker that needs help).
   * This is a static helper that agents can call to request help.
   */
  static emitHelpRequest(
    fromLeaseId: string,
    fromRunId: string,
    _spawnTreeId: string,
    capabilityNeeded: string,
    reason: string,
    urgency: 'low' | 'medium' | 'high' = 'medium',
  ): void {
    knowledgeBus.publish({
      claim_id: `help_request_${Date.now()}`,
      capability_id: capabilityNeeded,
      predicate: 'help_request',
      subject_ref: `lease:${fromLeaseId}`,
      confidence: 0.5,
      status: 'supported',
      trust: 0.5,
      provenance_run: fromRunId,
      evidence_refs: [],
      created_from: fromLeaseId,
    });

    swarmEventBus.emit('convergence', {
      negotiation: 'help_request',
      from_lease_id: fromLeaseId,
      capability_needed: capabilityNeeded,
      reason,
      urgency,
    });
  }
}
