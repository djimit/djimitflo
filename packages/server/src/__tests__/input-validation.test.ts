import { describe, it, expect } from 'vitest';
import { validateEcli, sanitizeFilePath, sanitizeString } from '../middleware/input-validation';

describe('Input Validation', () => {
  describe('validateEcli', () => {
    it('accepts valid ECLI', () => {
      expect(validateEcli('ECLI:NL:RBAMS:2026:1234').valid).toBe(true);
    });

    it('rejects empty ECLI', () => {
      expect(validateEcli('').valid).toBe(false);
    });

    it('rejects SQL injection in ECLI', () => {
      const result = validateEcli('ECLI:NL:RBAMS:2026:1234; DROP TABLE--');
      expect(result.valid).toBe(false);
    });

    it('rejects malformed ECLI', () => {
      expect(validateEcli('not-an-ecli').valid).toBe(false);
    });

    it('accepts ECLI with dots and dashes', () => {
      expect(validateEcli('ECLI:NL:HR:2026:ABC.123-DEF').valid).toBe(true);
    });
  });

  describe('sanitizeFilePath', () => {
    it('accepts safe absolute path', () => {
      const result = sanitizeFilePath('/safe/path/to/file.txt');
      expect(result.safe).toBe(true);
      expect(result.sanitized).toBe('/safe/path/to/file.txt');
    });

    it('rejects path traversal', () => {
      expect(sanitizeFilePath('../../../etc/passwd').safe).toBe(false);
    });

    it('rejects tilde expansion', () => {
      expect(sanitizeFilePath('~/.ssh/id_rsa').safe).toBe(false);
    });

    it('rejects empty path', () => {
      expect(sanitizeFilePath('').safe).toBe(false);
    });

    it('normalizes double slashes', () => {
      const result = sanitizeFilePath('/path//to///file');
      expect(result.sanitized).toBe('/path/to/file');
    });
  });

  describe('sanitizeString', () => {
    it('removes HTML tags', () => {
      expect(sanitizeString('<script>alert("xss")</script>')).not.toContain('<');
    });

    it('truncates long strings', () => {
      const long = 'x'.repeat(20000);
      expect(sanitizeString(long).length).toBeLessThanOrEqual(10000);
    });

    it('handles empty string', () => {
      expect(sanitizeString('')).toBe('');
    });

    it('trims whitespace', () => {
      expect(sanitizeString('  hello  ')).toBe('hello');
    });

    it('preserves safe text', () => {
      expect(sanitizeString('Hello World 123')).toBe('Hello World 123');
    });
  });
});
