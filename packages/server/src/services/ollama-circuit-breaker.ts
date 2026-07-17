/**
 * OllamaCircuitBreaker — wraps Ollama HTTP calls with circuit breaker protection.
 */
import { CircuitBreakerService } from './circuit-breaker-service';

const OLLAMA_KIND = 'ollama' as any;

export class OllamaCircuitBreaker {
  private breaker: CircuitBreakerService;
  constructor(threshold = 5, recoveryMs = 30000, successThreshold = 2) {
    this.breaker = new CircuitBreakerService(threshold, recoveryMs, successThreshold);
  }
  canCall(): boolean { return this.breaker.canExecute(OLLAMA_KIND); }
  recordSuccess(): void { this.breaker.recordSuccess(OLLAMA_KIND); }
  recordFailure(): void { this.breaker.recordFailure(OLLAMA_KIND); }
  getState(): { state: string; failures: number; successes: number; lastFailureAt: number; openedAt: number } { return this.breaker.getState(OLLAMA_KIND); }
}
