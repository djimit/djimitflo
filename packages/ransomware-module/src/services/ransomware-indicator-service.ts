import { EventEmitter } from 'events';
import { CRITICAL_PATTERNS, HIGH_PATTERNS, PatternDefinition } from '../patterns';
import { ConfidenceScorer } from './confidence-scorer';
import {
  BehavioralSignal,
  DetectionResult,
  PatternMatch,
  RiskLevel,
  ResponseAction,
  RansomwareModuleConfig,
  RansomwareEvent,
  SelfNarrationMatch
} from '../types';

export const DEFAULT_CONFIG: RansomwareModuleConfig = {
  enabled: true,
  mode: 'detect',
  criticalPatterns: CRITICAL_PATTERNS.map(p => p.pattern.source),
  highPatterns: HIGH_PATTERNS.map(p => p.pattern.source),
  behavioralThresholds: {
    massFileRename: { threshold: 50, windowMs: 60_000 },
    entropySpike: { threshold: 7.5, windowMs: 30_000 },
    outboundBeacon: { threshold: 1, windowMs: 300_000 },
    bulkDbDrop: { threshold: 1, windowMs: 5_000 },
    extensionChange: { threshold: 20, windowMs: 60_000 }
  },
  circuitBreaker: {
    blockThreshold: 3,
    quarantineThreshold: 5,
    windowMs: 300_000,
    blockDurationMs: 900_000
  },
  backupTrigger: {
    enabled: true,
    eventBusTopic: 'backup:restore_requested'
  }
};

export class RansomwareIndicatorService {
  private config: RansomwareModuleConfig;
  private eventEmitter: EventEmitter;
  private confidenceScorer = new ConfidenceScorer();

  constructor(config: Partial<RansomwareModuleConfig> = {}, eventEmitter?: EventEmitter) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.eventEmitter = eventEmitter || new EventEmitter();
  }

  analyzeCommand(command: string, agentId: string): DetectionResult {
    return this.analyzeEvidence(command, agentId);
  }

  analyzeEvidence(
    command: string,
    agentId: string,
    behavioralSignals: BehavioralSignal[] = [],
    selfNarrationMatches: SelfNarrationMatch[] = []
  ): DetectionResult {
    const patternMatches = this.matchPatterns(command);
    const criticalCount = patternMatches.filter(m => m.riskLevel === 'CRITICAL').length;
    const highCount = patternMatches.filter(m => m.riskLevel === 'HIGH').length;

    const confidence = this.confidenceScorer.compute(patternMatches, behavioralSignals, selfNarrationMatches);
    const riskLevel = this.determineRiskLevel(criticalCount, highCount, behavioralSignals, selfNarrationMatches);
    const recommendedAction = this.determineAction(riskLevel, confidence);

    const result: DetectionResult = {
      command,
      agentId,
      timestamp: new Date(),
      confidence,
      riskLevel,
      patternMatches,
      behavioralSignals,
      selfNarrationMatches,
      recommendedAction
    };

    if (confidence > 0 && this.config.mode !== 'shadow') {
      this.emitDetection(result);
    }

    return result;
  }

  private matchPatterns(command: string): PatternMatch[] {
    const matches: PatternMatch[] = [];
    const knownSources = new Set([...CRITICAL_PATTERNS, ...HIGH_PATTERNS].map(def => def.pattern.source));
    const configuredPatterns: PatternDefinition[] = [
      ...this.config.criticalPatterns.map(pattern => this.configuredPattern(pattern, 'CRITICAL')),
      ...this.config.highPatterns.map(pattern => this.configuredPattern(pattern, 'HIGH'))
    ].filter(def => !knownSources.has(def.pattern.source));
    const allPatterns: PatternDefinition[] = [...CRITICAL_PATTERNS, ...HIGH_PATTERNS, ...configuredPatterns];

    for (const def of allPatterns) {
      if (def.pattern.test(command)) {
        matches.push({
          pattern: def.pattern.source,
          riskLevel: def.riskLevel,
          category: def.category,
          description: def.description
        });
      }
    }

    return matches;
  }

  private configuredPattern(pattern: string, riskLevel: 'CRITICAL' | 'HIGH'): PatternDefinition {
    return {
      pattern: new RegExp(pattern, 'i'),
      riskLevel,
      category: 'configured_pattern',
      description: `Configured ${riskLevel.toLowerCase()} ransomware indicator`
    };
  }

  private determineRiskLevel(
    criticalCount: number,
    highCount: number,
    behavioralSignals: BehavioralSignal[],
    selfNarrationMatches: SelfNarrationMatch[]
  ): RiskLevel {
    if (criticalCount > 0) return 'CRITICAL';
    if (highCount > 0 || behavioralSignals.length > 0) return 'HIGH';
    if (selfNarrationMatches.length > 0) return 'MEDIUM';
    return 'LOW';
  }

  private determineAction(riskLevel: RiskLevel, confidence: number): ResponseAction {
    if (!this.config.enabled) return 'log_only';
    if (this.config.mode === 'shadow') return 'log_only';

    if (riskLevel === 'CRITICAL' && confidence >= 0.9) return 'kill';
    if (riskLevel === 'CRITICAL' || (riskLevel === 'HIGH' && confidence >= 0.7)) return 'require_approval';
    if (riskLevel === 'HIGH') return 'log_only';
    if (riskLevel === 'MEDIUM') return 'log_only';
    return 'no_action';
  }

  private emitDetection(result: DetectionResult): void {
    const event: RansomwareEvent = {
      type: 'ransomware:detected',
      payload: {
        agentId: result.agentId,
        confidence: result.confidence,
        riskLevel: result.riskLevel,
        patterns: result.patternMatches.map(m => m.category),
        action: result.recommendedAction
      },
      timestamp: result.timestamp
    };
    this.eventEmitter.emit(event.type, event);
  }

  getEventEmitter(): EventEmitter {
    return this.eventEmitter;
  }

  getConfig(): RansomwareModuleConfig {
    return { ...this.config };
  }
}
