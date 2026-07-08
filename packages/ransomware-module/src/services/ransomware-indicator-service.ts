import { EventEmitter } from 'events';
import { CRITICAL_PATTERNS, HIGH_PATTERNS, PatternDefinition } from '../patterns';
import {
  DetectionResult,
  PatternMatch,
  RiskLevel,
  ResponseAction,
  RansomwareModuleConfig,
  RansomwareEvent
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

  constructor(config: Partial<RansomwareModuleConfig> = {}, eventEmitter?: EventEmitter) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.eventEmitter = eventEmitter || new EventEmitter();
  }

  analyzeCommand(command: string, agentId: string): DetectionResult {
    const patternMatches = this.matchPatterns(command);
    const criticalCount = patternMatches.filter(m => m.riskLevel === 'CRITICAL').length;
    const highCount = patternMatches.filter(m => m.riskLevel === 'HIGH').length;

    const confidence = this.computeConfidence(patternMatches, [], []);
    const riskLevel = this.determineRiskLevel(criticalCount, highCount);
    const recommendedAction = this.determineAction(riskLevel, confidence);

    const result: DetectionResult = {
      command,
      agentId,
      timestamp: new Date(),
      confidence,
      riskLevel,
      patternMatches,
      behavioralSignals: [],
      selfNarrationMatches: [],
      recommendedAction
    };

    if (confidence > 0 && this.config.mode !== 'shadow') {
      this.emitDetection(result);
    }

    return result;
  }

  private matchPatterns(command: string): PatternMatch[] {
    const matches: PatternMatch[] = [];
    const allPatterns: PatternDefinition[] = [...CRITICAL_PATTERNS, ...HIGH_PATTERNS];

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

  private computeConfidence(
    patternMatches: PatternMatch[],
    behavioralSignals: unknown[],
    selfNarrationMatches: unknown[]
  ): number {
    if (patternMatches.length === 0 && behavioralSignals.length === 0 && selfNarrationMatches.length === 0) {
      return 0;
    }

    let score = 0;
    const criticalCount = patternMatches.filter(m => m.riskLevel === 'CRITICAL').length;
    const highCount = patternMatches.filter(m => m.riskLevel === 'HIGH').length;

    if (criticalCount >= 2) score = 0.95;
    else if (criticalCount === 1) score = 0.85;
    else if (highCount >= 2) score = 0.75;
    else if (highCount === 1) score = 0.65;

    if (behavioralSignals.length > 0) score = Math.min(score + 0.1, 0.99);
    if (selfNarrationMatches.length > 0) score = Math.min(score + 0.15, 0.99);

    return Math.round(score * 100) / 100;
  }

  private determineRiskLevel(criticalCount: number, highCount: number): RiskLevel {
    if (criticalCount > 0) return 'CRITICAL';
    if (highCount > 0) return 'HIGH';
    return 'LOW';
  }

  private determineAction(riskLevel: RiskLevel, confidence: number): ResponseAction {
    if (!this.config.enabled) return 'log_only';
    if (this.config.mode === 'shadow') return 'log_only';

    if (riskLevel === 'CRITICAL' && confidence >= 0.9) return 'kill';
    if (riskLevel === 'CRITICAL' || (riskLevel === 'HIGH' && confidence >= 0.7)) return 'require_approval';
    if (riskLevel === 'HIGH') return 'log_only';
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
