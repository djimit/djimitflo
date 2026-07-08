/**
 * SwarmConcurrencyService — concurrency slots and circuit breaker.
 *
 * Extracted from SwarmIntelligenceService (~50 LOC) to isolate the
 * concurrency management and failure tracking logic.
 */

export interface ConcurrencySlot {
  max: number;
  active: number;
}

export interface CircuitBreakerState {
  failures: number;
  tripped: boolean;
  lastFailureAt: string | null;
}

export class SwarmConcurrencyService {
  private readonly CIRCUIT_BREAKER_THRESHOLD = 3;
  private readonly CIRCUIT_BREAKER_COOLDOWN_MS = 60_000;

  constructor(
    private concurrencySlots: Map<string, ConcurrencySlot> = new Map(),
    private circuitBreakerState: Map<string, CircuitBreakerState> = new Map(),
  ) {}

  // ─── Concurrency Slots ────────────────────────────────────────────

  setConcurrencySlot(adapter: string, riskClass: string, maxConcurrent: number): void {
    const key = `${adapter}:${riskClass}`;
    this.concurrencySlots.set(key, { max: maxConcurrent, active: this.concurrencySlots.get(key)?.active || 0 });
  }

  checkConcurrencySlot(adapter: string, riskClass: string): { available: boolean; active: number; max: number } {
    const key = `${adapter}:${riskClass}`;
    const slot = this.concurrencySlots.get(key);
    if (!slot) return { available: true, active: 0, max: Infinity };
    return { available: slot.active < slot.max, active: slot.active, max: slot.max };
  }

  acquireConcurrencySlot(adapter: string, riskClass: string): boolean {
    const key = `${adapter}:${riskClass}`;
    const slot = this.concurrencySlots.get(key);
    if (!slot) return true;
    if (slot.active >= slot.max) return false;
    slot.active++;
    return true;
  }

  releaseConcurrencySlot(adapter: string, riskClass: string): void {
    const key = `${adapter}:${riskClass}`;
    const slot = this.concurrencySlots.get(key);
    if (slot && slot.active > 0) slot.active--;
  }

  // ─── Circuit Breaker ──────────────────────────────────────────────

  checkCircuitBreaker(scope: string): { tripped: boolean; failures: number; reason: string | null } {
    const state = this.circuitBreakerState.get(scope);
    if (!state) return { tripped: false, failures: 0, reason: null };
    if (state.tripped) {
      const cooldownElapsed = state.lastFailureAt
        ? Date.now() - new Date(state.lastFailureAt).getTime() > this.CIRCUIT_BREAKER_COOLDOWN_MS
        : false;
      if (cooldownElapsed) {
        this.circuitBreakerState.set(scope, { failures: 0, tripped: false, lastFailureAt: null });
        return { tripped: false, failures: 0, reason: null };
      }
      return { tripped: true, failures: state.failures, reason: `circuit_breaker_tripped:${scope}:${state.failures}_failures` };
    }
    return { tripped: false, failures: state.failures, reason: null };
  }

  recordCircuitBreakerFailure(scope: string): { tripped: boolean; failures: number } {
    const state = this.circuitBreakerState.get(scope) || { failures: 0, tripped: false, lastFailureAt: null };
    state.failures += 1;
    state.lastFailureAt = new Date().toISOString();
    if (state.failures >= this.CIRCUIT_BREAKER_THRESHOLD) {
      state.tripped = true;
    }
    this.circuitBreakerState.set(scope, state);
    return { tripped: state.tripped, failures: state.failures };
  }

  resetCircuitBreaker(scope: string): void {
    this.circuitBreakerState.delete(scope);
  }
}
