/**
 * CircuitBreakerService — per-executor circuit breaker for provider failure handling.
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Too many failures, requests blocked
 * - HALF_OPEN: Testing recovery, limited requests pass through
 */

import { ExecutorKind } from '../execution/types';

type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface BreakerState {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailureAt: number;
  openedAt: number;
}

const DEFAULT_THRESHOLD = parseInt(process.env.CIRCUIT_BREAKER_THRESHOLD || '3', 10);
const DEFAULT_RECOVERY_MS = parseInt(process.env.CIRCUIT_BREAKER_RECOVERY_MS || '30000', 10);
const DEFAULT_SUCCESS_THRESHOLD = 2;
const WINDOW_MS = 60000; // 1 minute sliding window

export class CircuitBreakerService {
  private states: Map<ExecutorKind, BreakerState> = new Map();
  private threshold: number;
  private recoveryMs: number;
  private successThreshold: number;

  constructor(
    threshold: number = DEFAULT_THRESHOLD,
    recoveryMs: number = DEFAULT_RECOVERY_MS,
    successThreshold: number = DEFAULT_SUCCESS_THRESHOLD,
  ) {
    this.threshold = threshold;
    this.recoveryMs = recoveryMs;
    this.successThreshold = successThreshold;
  }

  private getOrCreate(kind: ExecutorKind): BreakerState {
    let state = this.states.get(kind);
    if (!state) {
      state = { state: 'CLOSED', failures: 0, successes: 0, lastFailureAt: 0, openedAt: 0 };
      this.states.set(kind, state);
    }
    return state;
  }

  canExecute(kind: ExecutorKind): boolean {
    const state = this.getOrCreate(kind);

    if (state.state === 'CLOSED') return true;

    if (state.state === 'OPEN') {
      // Check if recovery timeout has passed
      if (Date.now() - state.openedAt >= this.recoveryMs) {
        state.state = 'HALF_OPEN';
        state.successes = 0;
        return true;
      }
      return false;
    }

    // HALF_OPEN: allow limited requests
    return true;
  }

  recordSuccess(kind: ExecutorKind): void {
    const state = this.getOrCreate(kind);

    if (state.state === 'HALF_OPEN') {
      state.successes++;
      if (state.successes >= this.successThreshold) {
        state.state = 'CLOSED';
        state.failures = 0;
        state.successes = 0;
      }
    } else if (state.state === 'CLOSED') {
      // Reset failure count on success
      state.failures = 0;
    }
  }

  recordFailure(kind: ExecutorKind): void {
    const state = this.getOrCreate(kind);

    if (state.state === 'HALF_OPEN') {
      // Failed during recovery → back to OPEN
      state.state = 'OPEN';
      state.openedAt = Date.now();
      state.successes = 0;
      return;
    }

    // CLOSED: track failures in sliding window
    const now = Date.now();
    if (now - state.lastFailureAt > WINDOW_MS) {
      state.failures = 0; // Reset outside window
    }
    state.failures++;
    state.lastFailureAt = now;

    if (state.failures >= this.threshold) {
      state.state = 'OPEN';
      state.openedAt = now;
    }
  }

  getState(kind: ExecutorKind): BreakerState {
    return this.getOrCreate(kind);
  }

  reset(kind: ExecutorKind): void {
    this.states.set(kind, { state: 'CLOSED', failures: 0, successes: 0, lastFailureAt: 0, openedAt: 0 });
  }

  resetAll(): void {
    this.states.clear();
  }
}
