import { describe, it, expect, beforeEach } from 'vitest';
import { ForensicCapture } from '../src/services/forensic-capture';
import { DetectionResult } from '../src/types';

describe('ForensicCapture', () => {
  let capture: ForensicCapture;

  beforeEach(() => {
    capture = new ForensicCapture({ redactSecrets: true });
  });

  function makeResult(): DetectionResult {
    return {
      command: 'DROP DATABASE production',
      agentId: 'agent-1',
      timestamp: new Date(),
      confidence: 0.95,
      riskLevel: 'CRITICAL',
      patternMatches: [{ pattern: 'DROP DATABASE', riskLevel: 'CRITICAL', category: 'destruction', description: 'test' }],
      behavioralSignals: [],
      selfNarrationMatches: [],
      recommendedAction: 'kill'
    };
  }

  it('records command history', () => {
    capture.recordCommand('agent-1', 'SELECT 1');
    capture.recordCommand('agent-1', 'DROP DATABASE test');
    const history = capture.getCommandHistory('agent-1');
    expect(history).toHaveLength(2);
    expect(history[1]).toBe('DROP DATABASE test');
  });

  it('captures forensic evidence with hash', () => {
    const result = makeResult();
    const evidence = capture.capture(result, ['file1.txt'], ['10.0.0.1:4444']);
    expect(evidence.agentId).toBe('agent-1');
    expect(evidence.integrityHash).toBeTruthy();
    expect(evidence.integrityHash.length).toBe(64);
  });

  it('verifies integrity of unmodified evidence', () => {
    const result = makeResult();
    const evidence = capture.capture(result);
    expect(capture.verifyIntegrity(evidence)).toBe(true);
  });

  it('detects tampered evidence', () => {
    const result = makeResult();
    const evidence = capture.capture(result);
    evidence.agentId = 'tampered';
    expect(capture.verifyIntegrity(evidence)).toBe(false);
  });

  it('redacts secrets from environment', () => {
    process.env['TEST_SECRET_KEY'] = 'super-secret-value';
    const result = makeResult();
    const evidence = capture.capture(result);
    expect(evidence.environmentSnapshot['TEST_SECRET_KEY']).toBe('[REDACTED]');
    delete process.env['TEST_SECRET_KEY'];
  });
});
