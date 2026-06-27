import { EventEmitter } from 'events';
import type { Database } from 'better-sqlite3';

/**
 * G15: KnowledgeBus — in-process pub/sub on typed claims.
 * When a claim is created (via SwarmIntelligenceService.createClaim), the bus
 * publishes it. Subscribers (other loop runs, other capabilities) receive it and
 * can act (e.g., a planner subscribed to `debugging` claims gets notified when a
 * new debugging claim is verified).
 *
 * HTTP transport scaffold: POST /api/knowledge/publish + GET /api/knowledge/subscribe/:capabilityId
 * are the endpoints a remote DjimFlo instance would use to join the bus. In this
 * change, they're scaffolded but the bus is in-process first.
 */

export interface KnowledgeBusClaim {
  claim_id: string;
  capability_id: string | null;
  predicate: string;
  subject_ref: string;
  confidence: number;
  status: string;
  trust: number;
  provenance_run: string | null;
  evidence_refs: string[];
  created_from: string | null;
}

type ClaimCallback = (claim: KnowledgeBusClaim) => void;

class KnowledgeBus extends EventEmitter {
  private subscribers = new Map<string, Set<ClaimCallback>>(); // capabilityId → callbacks
  private globalSubscribers = new Set<ClaimCallback>();

  /**
   * Publish a claim to all subscribers interested in its capability.
   */
  publish(claim: KnowledgeBusClaim): void {
    // Notify capability-specific subscribers.
    const caps = this.subscribers.get(claim.capability_id || '*') ?? new Set();
    for (const cb of caps) {
      try { cb(claim); } catch { /* subscriber error is non-fatal */ }
    }
    // Notify global subscribers (subscribed to all claims).
    for (const cb of this.globalSubscribers) {
      try { cb(claim); } catch { /* subscriber error is non-fatal */ }
    }
    // Also emit on the EventEmitter for SSE transport.
    super.emit('claim', claim);
  }

  /**
   * Subscribe to claims for a specific capability.
   * Use capabilityId = '*' to subscribe to all claims.
   * Returns an unsubscribe function.
   */
  subscribe(capabilityId: string, callback: ClaimCallback): () => void {
    if (capabilityId === '*') {
      this.globalSubscribers.add(callback);
      return () => { this.globalSubscribers.delete(callback); };
    }
    if (!this.subscribers.has(capabilityId)) {
      this.subscribers.set(capabilityId, new Set());
    }
    this.subscribers.get(capabilityId)!.add(callback);
    return () => {
      this.subscribers.get(capabilityId)?.delete(callback);
    };
  }

  /**
   * Get the number of active subscribers (for observability).
   */
  getSubscriberCount(): number {
    let count = this.globalSubscribers.size;
    for (const subs of this.subscribers.values()) {
      count += subs.size;
    }
    return count;
  }
}

// Singleton — shared across the process.
export const knowledgeBus = new KnowledgeBus();

/**
 * Wire the knowledge bus to SwarmIntelligenceService.createClaim.
 * Called at server composition time.
 */
export function wireKnowledgeBusToDB(_db: Database): void {
  // Hook into claim creation by listening to the swarm_claims table insert trigger.
  // Since better-sqlite3 is synchronous, we use a post-insert hook approach:
  // the SwarmIntelligenceService calls knowledgeBus.publish directly in createClaim.
  // This function is a no-op placeholder for future DB-level hook wiring.
}
