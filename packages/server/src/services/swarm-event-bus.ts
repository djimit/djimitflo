import { EventEmitter } from 'events';

/**
 * G14: SwarmEventBus — a bounded event bus for live observability.
 * LoopService + SwarmIntelligenceService emit events here; the SSE route
 * subscribes and streams them to the operator in real-time.
 *
 * Bounded buffer: if the client can't keep up, events are dropped (not queued
 * infinitely). A dropped_events counter is reported so the operator knows data
 * was lost.
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
  | 'council:approval:denied';

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
