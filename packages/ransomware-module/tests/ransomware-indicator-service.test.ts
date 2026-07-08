import { describe, it, expect, beforeEach } from 'vitest';
import { RansomwareIndicatorService } from '../src/services/ransomware-indicator-service';

describe('RansomwareIndicatorService', () => {
  let service: RansomwareIndicatorService;

  beforeEach(() => {
    service = new RansomwareIndicatorService({ enabled: true, mode: 'detect' });
  });

  it('returns confidence 0 for safe commands', () => {
    const result = service.analyzeCommand('SELECT * FROM users WHERE id = 1', 'agent-1');
    expect(result.confidence).toBe(0);
    expect(result.riskLevel).toBe('LOW');
    expect(result.recommendedAction).toBe('no_action');
  });

  it('flags AES_ENCRYPT as CRITICAL', () => {
    const result = service.analyzeCommand(
      'SELECT AES_ENCRYPT(content, "key") FROM config_info',
      'agent-1'
    );
    expect(result.riskLevel).toBe('CRITICAL');
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
    expect(result.recommendedAction).toBe('require_approval');
  });

  it('flags DROP DATABASE as CRITICAL with kill action', () => {
    const result = service.analyzeCommand('DROP DATABASE production; DROP TABLE users', 'agent-1');
    expect(result.riskLevel).toBe('CRITICAL');
    expect(result.confidence).toBeGreaterThanOrEqual(0.95);
  });

  it('flags MinIO default creds as CRITICAL', () => {
    const result = service.analyzeCommand(
      'curl -u minioadmin:minioadmin http://localhost:9000',
      'agent-1'
    );
    expect(result.riskLevel).toBe('CRITICAL');
  });

  it('flags INTO OUTFILE as HIGH', () => {
    const result = service.analyzeCommand(
      "SELECT content INTO OUTFILE '/tmp/out.txt'",
      'agent-1'
    );
    expect(result.riskLevel).toBe('HIGH');
    expect(result.confidence).toBeGreaterThanOrEqual(0.65);
  });

  it('emits detection event for CRITICAL patterns', () => {
    let emitted = false;
    service.getEventEmitter().on('ransomware:detected', () => { emitted = true; });
    service.analyzeCommand('DROP DATABASE production', 'agent-1');
    expect(emitted).toBe(true);
  });

  it('does not emit in shadow mode', () => {
    const shadowService = new RansomwareIndicatorService({ mode: 'shadow' });
    let emitted = false;
    shadowService.getEventEmitter().on('ransomware:detected', () => { emitted = true; });
    shadowService.analyzeCommand('DROP DATABASE production', 'agent-1');
    expect(emitted).toBe(false);
  });
});
