import { describe, expect, it } from 'vitest';
import { SECRET_PATTERNS, redactSecrets } from '../services/secret-patterns';

// Fixture secrets are assembled at runtime so secret scanners (gitleaks) do not flag the test source.
const AWS_KEY = 'AKIA' + '1234567890ABCDEF';

describe('SECRET_PATTERNS', () => {
  it('exports an array of named RegExp patterns', () => {
    expect(Array.isArray(SECRET_PATTERNS)).toBe(true);
    expect(SECRET_PATTERNS.length).toBeGreaterThan(0);
    for (const entry of SECRET_PATTERNS) {
      expect(typeof entry.name).toBe('string');
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.pattern).toBeInstanceOf(RegExp);
    }
  });

  it('includes expected well-known secret detectors', () => {
    const names = SECRET_PATTERNS.map((p) => p.name);
    expect(names).toContain('AWS Access Key');
    expect(names).toContain('GitHub PAT');
    expect(names).toContain('OpenAI Key');
    expect(names).toContain('Private Key PEM');
    expect(names).toContain('Generic Secret');
  });
});

describe('redactSecrets', () => {
  it('returns zero count and unchanged text when no secrets are present', () => {
    const text = 'just a normal log line with no secrets here';
    const { redacted, count } = redactSecrets(text);
    expect(count).toBe(0);
    expect(redacted).toBe(text);
  });

  it('redacts an AWS access key id', () => {
    const text = `using key ${AWS_KEY} to connect`;
    const { redacted, count } = redactSecrets(text);
    expect(count).toBeGreaterThanOrEqual(1);
    expect(redacted).toContain('[REDACTED:AWS Access Key]');
    expect(redacted).not.toContain(AWS_KEY);
  });

  it('redacts a GitHub PAT', () => {
    const pat = 'ghp_' + 'a'.repeat(36);
    const text = `token=${pat}`;
    const { redacted, count } = redactSecrets(text);
    expect(count).toBeGreaterThanOrEqual(1);
    expect(redacted).not.toContain(pat);
  });

  it('redacts an OpenAI key', () => {
    const key = 'sk-' + 'b'.repeat(48);
    const { redacted, count } = redactSecrets(`Authorization: Bearer ${key}`);
    expect(count).toBeGreaterThanOrEqual(1);
    expect(redacted).not.toContain(key);
  });

  it('redacts a private key PEM header', () => {
    const text = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----';
    const { redacted, count } = redactSecrets(text);
    expect(count).toBeGreaterThanOrEqual(1);
    expect(redacted).toContain('[REDACTED:Private Key PEM]');
  });

  it('redacts a generic secret assignment', () => {
    const text = `api_key="${'abcdefghijklmnopqrstuvwxyz' + '0123456789'}"`;
    const { redacted, count } = redactSecrets(text);
    expect(count).toBeGreaterThanOrEqual(1);
    expect(redacted).toContain('[REDACTED:');
  });

  it('counts multiple redactions across patterns', () => {
    const text = [
      AWS_KEY,
      'ghp_' + 'c'.repeat(36),
      'sk-' + 'd'.repeat(48),
    ].join(' and ');
    const { count } = redactSecrets(text);
    expect(count).toBeGreaterThanOrEqual(3);
  });

  it('handles empty string input', () => {
    const { redacted, count } = redactSecrets('');
    expect(count).toBe(0);
    expect(redacted).toBe('');
  });
});