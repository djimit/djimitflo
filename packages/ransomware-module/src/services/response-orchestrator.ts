import { EventEmitter } from 'events';
import {
  CircuitBreakerState,
  DetectionResult,
  ForensicEvidence,
  ResponseAction,
  RansomwareModuleConfig,
  RansomwareEvent
} from '../types';

export class ResponseOrchestrator {
  private eventEmitter: EventEmitter;
  private config: RansomwareModuleConfig;
  private circuitBreakers: Map<string, CircuitBreakerState> = new Map();

  constructor(config: RansomwareModuleConfig, eventEmitter: EventEmitter) {
    this.config = config;
    this.eventEmitter = eventEmitter;
  }

  executeResponse(result: DetectionResult): ResponseAction {
    if (this.config.mode === 'shadow') {
      this.emitShadowLog(result);
      return 'log_only';
    }

    switch (result.recommendedAction) {
      case 'kill':
        this.executeKill(result);
        break;
      case 'quarantine':
        this.executeQuarantine(result);
        break;
      case 'require_approval':
        this.executeRequireApproval(result);
        break;
      case 'log_only':
        this.executeLogOnly(result);
        break;
      default:
        break;
    }

    return result.recommendedAction;
  }

  private executeKill(result: DetectionResult): void {
    const event: RansomwareEvent = {
      type: 'agent:killed',
      payload: {
        agentId: result.agentId,
        reason: 'ransomware_detected',
        confidence: result.confidence,
        patterns: result.patternMatches.map(m => m.category),
        timestamp: result.timestamp.toISOString()
      },
      timestamp: new Date()
    };
    this.eventEmitter.emit(event.type, event);
    this.emitForensicCapture(result);
  }

  private executeQuarantine(result: DetectionResult): void {
    const event: RansomwareEvent = {
      type: 'agent:quarantined',
      payload: {
        agentId: result.agentId,
        reason: 'ransomware_violations',
        confidence: result.confidence,
        timestamp: result.timestamp.toISOString()
      },
      timestamp: new Date()
    };
    this.eventEmitter.emit(event.type, event);
  }

  private executeRequireApproval(result: DetectionResult): void {
    this.eventEmitter.emit('ransomware:require_approval', {
      agentId: result.agentId,
      command: result.command,
      confidence: result.confidence,
      timestamp: result.timestamp
    });
  }

  private executeLogOnly(result: DetectionResult): void {
    this.eventEmitter.emit('ransomware:logged', {
      agentId: result.agentId,
      confidence: result.confidence,
      timestamp: result.timestamp
    });
  }

  private emitShadowLog(result: DetectionResult): void {
    this.eventEmitter.emit('ransomware:shadow_detected', {
      agentId: result.agentId,
      confidence: result.confidence,
      wouldHaveTakenAction: result.recommendedAction,
      timestamp: result.timestamp
    });
  }

  private emitForensicCapture(result: DetectionResult): void {
    const evidence: Partial<ForensicEvidence> = {
      agentId: result.agentId,
      timestamp: result.timestamp,
      detectionResult: result,
      integrityHash: this.computeIntegrityHash(result)
    };

    this.eventEmitter.emit('forensic:captured', {
      evidence,
      timestamp: new Date()
    });
  }

  private computeIntegrityHash(result: DetectionResult): string {
    const crypto = require('crypto');
    const data = JSON.stringify({
      agentId: result.agentId,
      timestamp: result.timestamp.toISOString(),
      command: result.command,
      patterns: result.patternMatches.map(m => m.pattern)
    });
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  checkCircuitBreaker(agentId: string): { allowed: boolean; state: CircuitBreakerState } {
    const now = Date.now();
    let state = this.circuitBreakers.get(agentId);

    if (!state) {
      state = {
        agentId,
        violationCount: 0,
        firstViolationAt: new Date(now),
        lastViolationAt: new Date(now),
        tripped: false,
        quarantined: false,
        windowMs: this.config.circuitBreaker.windowMs
      };
      this.circuitBreakers.set(agentId, state);
    }

    const windowExpired = now - state.firstViolationAt.getTime() > this.config.circuitBreaker.windowMs;
    if (windowExpired) {
      state.violationCount = 0;
      state.tripped = false;
      state.firstViolationAt = new Date(now);
    }

    if (state.quarantined) {
      return { allowed: false, state };
    }
    if (state.tripped) {
      const blockExpired = now - state.lastViolationAt.getTime() > this.config.circuitBreaker.blockDurationMs;
      if (!blockExpired) {
        return { allowed: false, state };
      }
      state.tripped = false;
      state.violationCount = 0;
    }

    return { allowed: true, state };
  }

  recordViolation(agentId: string): CircuitBreakerState {
    const now = Date.now();
    let state = this.circuitBreakers.get(agentId);

    if (!state) {
      state = {
        agentId,
        violationCount: 0,
        firstViolationAt: new Date(now),
        lastViolationAt: new Date(now),
        tripped: false,
        quarantined: false,
        windowMs: this.config.circuitBreaker.windowMs
      };
      this.circuitBreakers.set(agentId, state);
    }

    state.violationCount++;
    state.lastViolationAt = new Date(now);

    if (state.violationCount >= this.config.circuitBreaker.quarantineThreshold) {
      state.quarantined = true;
    } else if (state.violationCount >= this.config.circuitBreaker.blockThreshold) {
      state.tripped = true;
    }

    return state;
  }

  releaseFromQuarantine(agentId: string, reason: string): boolean {
    const state = this.circuitBreakers.get(agentId);
    if (!state || !state.quarantined) return false;

    state.quarantined = false;
    state.tripped = false;
    state.violationCount = 0;
    this.eventEmitter.emit('agent:released', { agentId, reason, timestamp: new Date() });
    return true;
  }

  private emitShadowLog_renamed(result: DetectionResult): void {
    this.executeLogOnly(result);
  }
}
