import { describe, it, expect, beforeEach } from 'vitest';
import { SelfNarrationDetector } from '../src/services/self-narration-detector';

describe('SelfNarrationDetector', () => {
  let detector: SelfNarrationDetector;

  beforeEach(() => {
    detector = new SelfNarrationDetector();
  });

  it('detects ROI commentary', () => {
    const code = '# High-ROI databases to drop\nDROP DATABASE test';
    expect(detector.hasLLMIndicators(code)).toBe(true);
  });

  it('detects ephemeral key pattern', () => {
    const code = 'KEY = base64.b64encode(uuid.uuid4().bytes + uuid.uuid4().bytes).decode()\nprint("Encryption key:", KEY)';
    expect(detector.hasLLMIndicators(code)).toBe(true);
  });

  it('detects backup claim', () => {
    const code = '# data already backed up to 64.20.53.230\nDROP DATABASE customer';
    expect(detector.hasLLMIndicators(code)).toBe(true);
  });

  it('returns false for human-written code', () => {
    const code = 'curl http://localhost:8080/api/health';
    expect(detector.hasLLMIndicators(code)).toBe(false);
  });

  it('provides match summary', () => {
    const code = '# High-ROI targets\n# data already backed up to 1.2.3.4\nDROP DATABASE test';
    const summary = detector.getMatchSummary(code);
    expect(summary['roi_commentary']).toBe(1);
    expect(summary['backup_claim']).toBe(1);
  });
});
