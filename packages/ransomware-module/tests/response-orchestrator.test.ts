import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { ResponseOrchestrator } from '../src/services/response-orchestrator';
import { RansomwareModuleConfig, DetectionResult } from '../src/types';

describe('ResponseOrchestrator', () => {
  let orchestrator: ResponseOrchestrator;
  let emitter: EventEmitter;
  let config: RansomwareModuleConfig;

  beforeEach(() => {
    emitter = new EventEmitter();
    config = {
      enabled: true,
      mode: 'enforce',
      criticalPatterns: [],
      highPatterns: [],
      behavioralThresholds: {
        massFileRename: { threshold: 50, windowMs: 60000 },
        entropySpike: { threshold: 7.5, windowMs: 30000 },
        outboundBeacon: { threshold: 1, windowMs: 300000 },
        bulkDbDrop: { threshold: 1, windowMs: 5000 },
        extensionChange: { threshold: 20, windowMs: 60000 }
      },
      circuitBreaker: {
        blockThreshold: 3,
        quarantineThreshold: 5,
        windowMs: 300000,
        blockDurationMs: 900000
      },
      backupTrigger: { enabled: true, eventBusTopic: 'backup:restore_requested' }
    };
    orchestrator = new ResponseOrchestrator(config, emitter);
  });

  function makeResult(overrides: Partial<DetectionResult> = {}): DetectionResult {
    return {
      command: 'DROP DATABASE test',
      agentId: 'agent-1',
      timestamp: new Date(),
      confidence: 0.95,
      riskLevel: 'CRITICAL',
      patternMatches: [{ pattern: 'DROP DATABASE', riskLevel: 'CRITICAL', category: 'destruction', description: 'test' }],
      behavioralSignals: [],
      selfNarrationMatches: [],
      recommendedAction: 'kill',
      ...overrides
    };
  }

  it('emits agent:killed for CRITICAL detection', () => {
    let killed = false;
    emitter.on('agent:killed', () => { killed = true; });
    orchestrator.executeResponse(makeResult({ recommendedAction: 'kill' }));
    expect(killed).toBe(true);
  });

  it('emits agent:quarantined for quarantine action', () => {
    let quarantined = false;
    emitter.on('agent:quarantined', () => { quarantined = true; });
    orchestrator.executeResponse(makeResult({ recommendedAction: 'quarantine' }));
    expect(quarantined).toBe(true);
  });

  it('does not emit kill in shadow mode', () => {
    const shadowConfig = { ...config, mode: 'shadow' as const };
    const shadowOrch = new ResponseOrchestrator(shadowConfig, emitter);
    let killed = false;
    emitter.on('agent:killed', () => { killed = true; });
    shadowOrch.executeResponse(makeResult({ recommendedAction: 'kill' }));
    expect(killed).toBe(false);
  });

  describe('Circuit Breaker', () => {
    it('allows first violation', () => {
      const { allowed } = orchestrator.checkCircuitBreaker('agent-1');
      expect(allowed).toBe(true);
    });

    it('trips after 3 violations', () => {
      orchestrator.recordViolation('agent-1');
      orchestrator.recordViolation('agent-1');
      orchestrator.recordViolation('agent-1');
      const { allowed, state } = orchestrator.checkCircuitBreaker('agent-1');
      expect(allowed).toBe(false);
      expect(state.tripped).toBe(true);
    });

    it('quarantines after 5 violations', () => {
      for (let i = 0; i < 5; i++) orchestrator.recordViolation('agent-1');
      const { state } = orchestrator.checkCircuitBreaker('agent-1');
      expect(state.quarantined).toBe(true);
    });

    it('releases from quarantine with reason', () => {
      for (let i = 0; i < 5; i++) orchestrator.recordViolation('agent-1');
      const released = orchestrator.releaseFromQuarantine('agent-1', 'false positive confirmed');
      expect(released).toBe(true);
      const { allowed } = orchestrator.checkCircuitBreaker('agent-1');
      expect(allowed).toBe(true);
    });
  });
});
