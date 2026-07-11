/**
 * FallbackChainService — provider-agonistic fallback chain per execution mode.
 *
 * When a provider fails or circuit is open, automatically tries the next
 * available provider in the chain.
 */

import { ExecutorKind } from '../execution/types';
import { CircuitBreakerService } from './circuit-breaker-service';

export type ExecutionMode = 'fast' | 'standard' | 'controlled' | 'restricted';

const DEFAULT_CHAINS: Record<ExecutionMode, ExecutorKind[]> = {
  fast: ['opencode', 'gemini', 'claude'],
  standard: ['claude', 'codex', 'gemini'],
  controlled: ['claude', 'codex'],
  restricted: ['claude'],
};

export class FallbackChainService {
  private chains: Record<ExecutionMode, ExecutorKind[]>;

  constructor(customChains?: Partial<Record<ExecutionMode, ExecutorKind[]>>) {
    this.chains = { ...DEFAULT_CHAINS, ...customChains };
  }

  getChain(mode: ExecutionMode): ExecutorKind[] {
    return this.chains[mode] || this.chains.standard;
  }

  getFirstAvailable(
    mode: ExecutionMode,
    breaker: CircuitBreakerService,
    exclude: ExecutorKind[] = [],
  ): ExecutorKind | null {
    const chain = this.getChain(mode);
    for (const kind of chain) {
      if (exclude.includes(kind)) continue;
      if (breaker.canExecute(kind)) return kind;
    }
    return null;
  }

  getNextAvailable(
    current: ExecutorKind,
    mode: ExecutionMode,
    breaker: CircuitBreakerService,
  ): ExecutorKind | null {
    const chain = this.getChain(mode);
    const currentIdx = chain.indexOf(current);

    // Try everything after current in the chain
    for (let i = currentIdx + 1; i < chain.length; i++) {
      if (breaker.canExecute(chain[i])) return chain[i];
    }

    // If current not in chain, try all
    if (currentIdx === -1) {
      return this.getFirstAvailable(mode, breaker, [current]);
    }

    return null;
  }

  setChain(mode: ExecutionMode, chain: ExecutorKind[]): void {
    this.chains[mode] = chain;
  }
}
