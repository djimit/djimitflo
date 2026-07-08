export type RiskLevel = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export type DetectionType = 'command_pattern' | 'behavioral' | 'self_narration';

export interface PatternMatch {
  pattern: string;
  riskLevel: RiskLevel;
  category: string;
  description: string;
}

export interface BehavioralSignal {
  type: 'mass_file_rename' | 'entropy_spike' | 'outbound_beacon' | 'bulk_db_drop' | 'extension_change';
  threshold: number;
  actual: number;
  windowMs: number;
  context: Record<string, unknown>;
}

export interface SelfNarrationMatch {
  pattern: string;
  line: string;
  category: 'roi_commentary' | 'ephemeral_key' | 'backup_claim' | 'ransom_contact' | 'cleanup_marker';
}

export interface DetectionResult {
  command: string;
  agentId: string;
  timestamp: Date;
  confidence: number;
  riskLevel: RiskLevel;
  patternMatches: PatternMatch[];
  behavioralSignals: BehavioralSignal[];
  selfNarrationMatches: SelfNarrationMatch[];
  recommendedAction: ResponseAction;
}

export type ResponseAction = 'kill' | 'quarantine' | 'require_approval' | 'log_only' | 'no_action';

export interface ForensicEvidence {
  agentId: string;
  timestamp: Date;
  detectionResult: DetectionResult;
  commandHistory: string[];
  fileChanges: string[];
  networkConnections: string[];
  environmentSnapshot: Record<string, string>;
  integrityHash: string;
}

export interface CircuitBreakerState {
  agentId: string;
  violationCount: number;
  firstViolationAt: Date;
  lastViolationAt: Date;
  tripped: boolean;
  quarantined: boolean;
  windowMs: number;
}

export interface RansomwareModuleConfig {
  enabled: boolean;
  mode: 'shadow' | 'detect' | 'enforce';
  criticalPatterns: string[];
  highPatterns: string[];
  behavioralThresholds: BehavioralThresholds;
  circuitBreaker: CircuitBreakerConfig;
  backupTrigger: BackupTriggerConfig;
}

export interface BehavioralThresholds {
  massFileRename: { threshold: number; windowMs: number };
  entropySpike: { threshold: number; windowMs: number };
  outboundBeacon: { threshold: number; windowMs: number };
  bulkDbDrop: { threshold: number; windowMs: number };
  extensionChange: { threshold: number; windowMs: number };
}

export interface CircuitBreakerConfig {
  blockThreshold: number;
  quarantineThreshold: number;
  windowMs: number;
  blockDurationMs: number;
}

export interface BackupTriggerConfig {
  enabled: boolean;
  webhookUrl?: string;
  eventBusTopic: string;
}

export interface RansomwareEvent {
  type: 'ransomware:detected' | 'ransomware:behavioral' | 'ransomware:self_narration' | 'agent:killed' | 'agent:quarantined' | 'forensic:captured' | 'backup:restore_requested';
  payload: Record<string, unknown>;
  timestamp: Date;
}
