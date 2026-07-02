import { describe, expect, it } from 'vitest';
import { AdversarialInputValidator } from '../services/adversarial-input-validator';

describe('G114: AdversarialInputValidator', () => {
  const validator = new AdversarialInputValidator();

  it('validates clean input', () => {
    const result = validator.validateInput('Hello world', 'test');
    expect(result.valid).toBe(true);
  });

  it('rejects null input', () => {
    const result = validator.validateInput(null, 'test');
    expect(result.valid).toBe(false);
  });

  it('rejects oversized input', () => {
    const big = 'x'.repeat(100_001);
    const result = validator.validateInput(big, 'test');
    expect(result.valid).toBe(false);
  });

  it('detects script injection', () => {
    const result = validator.validateInput('<script>alert("xss")</script>', 'test');
    expect(result.valid).toBe(false);
  });

  it('signs and hashes input', () => {
    const { hash, signature } = validator.signAndHash('test input');
    expect(hash).toBeDefined();
    expect(signature).toBeDefined();
    expect(hash).not.toBe(signature);
  });

  it('verifies signature', () => {
    const { signature } = validator.signAndHash('test input');
    expect(validator.verifySignature('test input', signature)).toBe(true);
    expect(validator.verifySignature('tampered', signature)).toBe(false);
  });

  it('detects poisoning', () => {
    const inputs = ['normal', 'normal', 'normal', '\u202Eevil\u202E'];
    const report = validator.detectPoisoning(inputs);
    expect(report.suspicious).toBe(true);
    expect(report.anomalies.length).toBeGreaterThan(0);
  });

  it('sanitizes for display', () => {
    const sanitized = validator.sanitizeForDisplay('<b>"test"</b>');
    expect(sanitized).not.toContain('<b>');
    expect(sanitized).toContain('&lt;');
  });
});
