import { EventEmitter } from 'events';

/**
 * G14: SwarmEventBus — in-process fan-out for live observability.
 * LoopService + SwarmIntelligenceService emit events here; the SSE route
 * subscribes and streams them to the operator in real-time.
 *
 * The bus itself is a synchronous EventEmitter and never buffers. Bounding happens
 * at the SSE transport (utils/sse.ts, OBS-001): a client that can't keep up has
 * events dropped, not queued, and each drop is recorded here via recordDropped, so
 * getDroppedEvents is the process-wide count of events lost to slow clients.
 * Nothing here is durable: replay comes from persisted records, not this bus.
 */

export type SwarmEventType =
  | 'aimd_state'
  | 'trust_change'
  | 'capability_transition'
  | 'lease_lifecycle'
  | 'budget_burn'
  | 'convergence'
  | 'recovery'
  | 'eval:case:complete'
  | 'eval:run:complete'
  | 'governance:guard:blocked'
  | 'governance:guard:warning'
  | 'governance:guard:approved'
  | 'authority_deny'
  | 'authority_gate'
  | 'governance:improvement:triggered'
  | 'agent_action'
  | 'loop_completed'
  | 'council:session:started'
  | 'council:session:completed'
  | 'council:session:failed'
  | 'council:session:escalated'
  | 'council:diverge:started'
  | 'council:diverge:completed'
  | 'council:review:started'
  | 'council:review:completed'
  | 'council:synthesize:started'
  | 'council:synthesize:completed'
  | 'council:model:registered'
  | 'council:model:deprecated'
  | 'council:approval:required'
  | 'council:approval:granted'
  | 'council:approval:denied'
  | 'segml:cycle:started'
  | 'segml:cycle:complete'
  | 'governance_alert'
  | 'segml:trigger:runtime'
  | 'segml:trigger:predicted_decline'
  | 'segml:cpo:learning_complete'
  | 'segml:cpo:fleet_blind_spots'
  | 'segml:red_team:campaign_queued'
  | 'segml:skill:quarantined'
  | 'segml:meta:adaptation'
  | 'segml:meta:reverted'
  | 'segml:twin:deployment_blocked'
  | 'segml:federation:synced'
  | 'segml:literature:new_categories'
  | 'segml:literature:category_approved'
  | 'segml:finetuning:dataset_created'
  | 'segml:finetuning:job_created'
  | 'segml:finetuning:deployment_recommended'
  | 'segml:l3:dataset_created'
  | 'segml:l3:training_started'
  | 'segml:l3:tool_synthesized'
  | 'segml:l4:tournament_complete'
  | 'segml:l4:population_evolved'
  | 'segml:l4:coevolution_round'
  | 'segml:l5:evolution_step'
  | 'segml:l5:modification_reverted'
  | 'segml:prod:dataset_created'
  | 'segml:prod:adapter_created'
  | 'segml:prod:cycle_complete';

export interface SwarmEvent {
  type: SwarmEventType;
  timestamp: string;
  data: Record<string, unknown>;
}


class SwarmEventBus extends EventEmitter {
  private droppedEvents = 0;

  constructor() {
    super();
    this.setMaxListeners(100);
  }

  emit(event: SwarmEventType, data: Record<string, unknown>): boolean {
    const swarmEvent: SwarmEvent = {
      type: event,
      timestamp: new Date().toISOString(),
      data,
    };
    return super.emit('event', swarmEvent);
  }

  subscribe(callback: (event: SwarmEvent) => void): () => void {
    super.on('event', callback);
    return () => super.off('event', callback);
  }

  recordDropped(count = 1): void {
    this.droppedEvents += count;
  }

  getDroppedEvents(): number {
    return this.droppedEvents;
  }

  /** Get the current buffer depth (listeners count as a proxy). */
  getListenerCount(): number {
    return super.listenerCount('event');
  }
}

// Singleton — shared across the process.
export const swarmEventBus = new SwarmEventBus();
