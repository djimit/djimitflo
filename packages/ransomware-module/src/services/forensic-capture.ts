import { createHash } from 'crypto';
import { DetectionResult, ForensicEvidence } from '../types';

export interface ForensicCaptureOptions {
  maxCommandHistory: number;
  redactSecrets: boolean;
  includeEnvironment: boolean;
}

export const DEFAULT_FORENSIC_OPTIONS: ForensicCaptureOptions = {
  maxCommandHistory: 50,
  redactSecrets: true,
  includeEnvironment: true
};

export class ForensicCapture {
  private options: ForensicCaptureOptions;
  private commandHistory: Map<string, string[]> = new Map();

  constructor(options: Partial<ForensicCaptureOptions> = {}) {
    this.options = { ...DEFAULT_FORENSIC_OPTIONS, ...options };
  }

  recordCommand(agentId: string, command: string): void {
    let history = this.commandHistory.get(agentId);
    if (!history) {
      history = [];
      this.commandHistory.set(agentId, history);
    }
    history.push(command);
    if (history.length > this.options.maxCommandHistory) {
      history.shift();
    }
  }

  capture(
    result: DetectionResult,
    fileChanges: string[] = [],
    networkConnections: string[] = []
  ): ForensicEvidence {
    const commandHistory = this.getCommandHistory(result.agentId);
    const envSnapshot = this.options.includeEnvironment
      ? this.captureEnvironment()
      : {};

    const evidence: ForensicEvidence = {
      agentId: result.agentId,
      timestamp: result.timestamp,
      detectionResult: result,
      commandHistory,
      fileChanges,
      networkConnections,
      environmentSnapshot: envSnapshot,
      integrityHash: ''
    };

    evidence.integrityHash = this.computeHash(evidence);
    return evidence;
  }

  getCommandHistory(agentId: string): string[] {
    return [...(this.commandHistory.get(agentId) || [])];
  }

  clearHistory(agentId: string): void {
    this.commandHistory.delete(agentId);
  }

  private captureEnvironment(): Record<string, string> {
    const snapshot: Record<string, string> = {};
    const sensitiveKeys = ['PASSWORD', 'SECRET', 'TOKEN', 'KEY', 'CREDENTIAL', 'AUTH'];

    for (const [key, value] of Object.entries(process.env)) {
      if (!value) continue;
      if (this.options.redactSecrets && sensitiveKeys.some(sk => key.toUpperCase().includes(sk))) {
        snapshot[key] = '[REDACTED]';
      } else {
        snapshot[key] = value;
      }
    }

    return snapshot;
  }

  private computeHash(evidence: ForensicEvidence): string {
    const data = JSON.stringify({
      agentId: evidence.agentId,
      timestamp: evidence.timestamp.toISOString(),
      commandHistory: evidence.commandHistory,
      patterns: evidence.detectionResult.patternMatches.map(m => m.pattern),
      fileChanges: evidence.fileChanges
    });
    return createHash('sha256').update(data).digest('hex');
  }

  verifyIntegrity(evidence: ForensicEvidence): boolean {
    const expectedHash = this.computeHash(evidence);
    return expectedHash === evidence.integrityHash;
  }
}
