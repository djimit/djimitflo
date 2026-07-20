/**
 * OllamaCircuitBreaker — wraps Ollama HTTP calls with circuit breaker protection.
 * Prevents cascade failures when Ollama is unavailable during eval runs.
 */
import { CircuitBreakerService } from './circuit-breaker-service';

const OLLAMA_EXECUTOR_KIND = 'ollama' as any;

export class OllamaCircuitBreaker {
  private breaker: CircuitBreakerService;

  constructor(threshold = 5, recoveryMs = 30000, successThreshold = 2) {
    this.breaker = new CircuitBreakerService(threshold, recoveryMs, successThreshold);
  }

  canCall(): boolean {
    return this.breaker.canExecute(OLLAMA_EXECUTOR_KIND);
  }

  recordSuccess(): void {
    this.breaker.recordSuccess(OLLAMA_EXECUTOR_KIND);
  }

  recordFailure(): void {
    this.breaker.recordFailure(OLLAMA_EXECUTOR_KIND);
  }

  getState(): { state: string; failures: number; successes: number; lastFailureAt: number; openedAt: number } {
    return this.breaker.getState(OLLAMA_EXECUTOR_KIND);
  }
}
