import { EventEmitter } from 'events';
import { RansomwareIndicatorService } from '../services/ransomware-indicator-service';
import { SelfNarrationDetector } from '../services/self-narration-detector';
import { BehavioralDetector } from '../services/behavioral-detector';
import { ResponseOrchestrator } from '../services/response-orchestrator';
import { ForensicCapture } from '../services/forensic-capture';
import { ConfidenceScorer } from '../services/confidence-scorer';
import { DetectionResult, RansomwareModuleConfig, RansomwareEvent } from '../types';

interface SwarmEventBus {
  subscribe(handler: (event: { type: string; payload: unknown }) => void): () => void;
  emit(eventType: string, payload: unknown): void;
}

export interface DjimitfloAdapterConfig {
  swarmEventBus: SwarmEventBus;
  ransomwareConfig: Partial<RansomwareModuleConfig>;
  onKill?: (agentId: string, reason: string) => void | Promise<void>;
  onQuarantine?: (agentId: string, reason: string) => void | Promise<void>;
  onForensicCapture?: (evidence: unknown) => void | Promise<void>;
  onBackupRestore?: (targetDb: string, restorePoint: Date) => void | Promise<void>;
}

export class DjimitfloRansomwareAdapter {
  private indicatorService: RansomwareIndicatorService;
  private selfNarrationDetector: SelfNarrationDetector;
  private behavioralDetector: BehavioralDetector;
  private responseOrchestrator: ResponseOrchestrator;
  private forensicCapture: ForensicCapture;
  private confidenceScorer: ConfidenceScorer;
  private config: DjimitfloAdapterConfig;
  private unsubscribe: (() => void) | null = null;
  private localEmitter: EventEmitter;

  constructor(config: DjimitfloAdapterConfig) {
    this.config = config;
    this.localEmitter = new EventEmitter();

    const fullConfig: RansomwareModuleConfig = {
      ...this.getDefaultConfig(),
      ...config.ransomwareConfig
    };

    this.indicatorService = new RansomwareIndicatorService(fullConfig, this.localEmitter);
    this.selfNarrationDetector = new SelfNarrationDetector();
    this.behavioralDetector = new BehavioralDetector(fullConfig.behavioralThresholds, this.localEmitter);
    this.responseOrchestrator = new ResponseOrchestrator(fullConfig, this.localEmitter);
    this.forensicCapture = new ForensicCapture();
    this.confidenceScorer = new ConfidenceScorer();

    this.setupLocalListeners();
  }

  start(): void {
    this.unsubscribe = this.config.swarmEventBus.subscribe((event) => {
      this.handleSwarmEvent(event);
    });
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  private handleSwarmEvent(event: { type: string; payload: unknown }): void {
    const payload = event.payload as Record<string, unknown>;

    switch (event.type) {
      case 'agent_action':
        this.handleAgentAction(payload);
        break;
      case 'worker_executed':
        this.handleWorkerExecuted(payload);
        break;
      case 'loop_completed':
        this.handleLoopCompleted(payload);
        break;
    }
  }

  private handleAgentAction(payload: Record<string, unknown>): void {
    const agentId = payload.agentId as string;
    const command = payload.command as string;

    if (!agentId || !command) return;

    this.forensicCapture.recordCommand(agentId, command);
    const result = this.indicatorService.analyzeCommand(command, agentId);

    if (result.confidence > 0) {
      this.emitToSwarm('ransomware:detected', {
        agentId: result.agentId,
        confidence: result.confidence,
        riskLevel: result.riskLevel,
        patterns: result.patternMatches.map(m => m.category),
        action: result.recommendedAction,
        timestamp: result.timestamp.toISOString()
      });

      this.responseOrchestrator.executeResponse(result);
    }
  }

  private handleWorkerExecuted(payload: Record<string, unknown>): void {
    const agentId = payload.agentId as string;
    const output = payload.output as string;

    if (!agentId || !output) return;

    const narrationMatches = this.selfNarrationDetector.detect(output);
    if (narrationMatches.length > 0) {
      this.emitToSwarm('ransomware:self_narration', {
        agentId,
        matches: narrationMatches,
        summary: this.selfNarrationDetector.getMatchSummary(output),
        timestamp: new Date().toISOString()
      });
    }
  }

  private handleLoopCompleted(payload: Record<string, unknown>): void {
    const agentId = payload.agentId as string;
    const fileChanges = payload.fileChanges as string[];

    if (fileChanges && fileChanges.length > 0) {
      this.behavioralDetector.recordFileRename(agentId, { count: fileChanges.length });
    }
  }

  private setupLocalListeners(): void {
    this.localEmitter.on('agent:killed', async (event: RansomwareEvent) => {
      const payload = event.payload;
      if (this.config.onKill) {
        await this.config.onKill(payload.agentId as string, payload.reason as string);
      }
      this.emitToSwarm('agent:killed', payload);
    });

    this.localEmitter.on('agent:quarantined', async (event: RansomwareEvent) => {
      const payload = event.payload;
      if (this.config.onQuarantine) {
        await this.config.onQuarantine(payload.agentId as string, payload.reason as string);
      }
      this.emitToSwarm('agent:quarantined', payload);
    });

    this.localEmitter.on('forensic:captured', async (event: RansomwareEvent) => {
      if (this.config.onForensicCapture) {
        await this.config.onForensicCapture(event.payload.evidence);
      }
    });
  }

  private emitToSwarm(eventType: string, payload: unknown): void {
    this.config.swarmEventBus.emit(eventType, payload);
  }

  private getDefaultConfig(): RansomwareModuleConfig {
    return {
      enabled: true,
      mode: 'detect',
      criticalPatterns: [],
      highPatterns: [],
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
  }

  getIndicatorService(): RansomwareIndicatorService {
    return this.indicatorService;
  }

  getBehavioralDetector(): BehavioralDetector {
    return this.behavioralDetector;
  }

  getResponseOrchestrator(): ResponseOrchestrator {
    return this.responseOrchestrator;
  }

  getForensicCapture(): ForensicCapture {
    return this.forensicCapture;
  }
}
