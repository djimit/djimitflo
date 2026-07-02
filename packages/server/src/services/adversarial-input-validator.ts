import { createHash, createHmac } from 'crypto';

export interface ValidationResult {
  valid: boolean;
  reason?: string;
  sanitized?: string;
}

export interface PoisoningReport {
  suspicious: boolean;
  anomalies: Array<{ index: number; reason: string }>;
}

export class AdversarialInputValidator {
  private secret: string;

  constructor() {
    this.secret = process.env.INPUT_VALIDATION_SECRET || 'djimitflo-input-validation-default';
  }

  validateInput(input: unknown, _source: string): ValidationResult {
    if (input === null || input === undefined) {
      return { valid: false, reason: 'null or undefined input' };
    }

    if (typeof input === 'string') {
      if (input.length > 100_000) {
        return { valid: false, reason: 'input exceeds maximum length' };
      }
      if (this.containsInjectionPatterns(input)) {
        return { valid: false, reason: 'potential injection pattern detected' };
      }
    }

    return { valid: true };
  }

  signAndHash(input: string): { hash: string; signature: string } {
    const hash = createHash('sha256').update(input).digest('hex');
    const signature = createHmac('sha256', this.secret).update(input).digest('hex');
    return { hash, signature };
  }

  verifySignature(input: string, signature: string): boolean {
    const expected = createHmac('sha256', this.secret).update(input).digest('hex');
    return signature === expected;
  }

  detectPoisoning(inputs: unknown[]): PoisoningReport {
    const anomalies: Array<{ index: number; reason: string }> = [];

    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i];
      if (typeof input !== 'string') continue;

      if (input.includes('\u202E') || input.includes('\u200F')) {
        anomalies.push({ index: i, reason: 'unicode bidirectional override detected' });
      }

      const repetitionRatio = this.calculateRepetition(input);
      if (repetitionRatio > 0.8 && input.length > 100) {
        anomalies.push({ index: i, reason: 'suspicious repetition pattern' });
      }
    }

    return { suspicious: anomalies.length > 0, anomalies };
  }

  sanitizeForDisplay(input: string): string {
    return input
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
  }

  private containsInjectionPatterns(input: string): boolean {
    const patterns = [
      /<script\b[^>]*>/i,
      /javascript\s*:/i,
      /on\w+\s*=/i,
      /\b(eval|exec|system|passthru|shell_exec)\s*\(/i,
      /union\s+select\b/i,
      /;\s*drop\s+table\b/i,
    ];
    return patterns.some(p => p.test(input));
  }

  private calculateRepetition(input: string): number {
    if (input.length === 0) return 0;
    const uniqueChars = new Set(input.split(''));
    return 1 - uniqueChars.size / input.length;
  }
}
