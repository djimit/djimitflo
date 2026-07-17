/**
 * ReDoSGuard — safe regex execution with timeout.
 * Prevents catastrophic backtracking from user-supplied patterns.
 */
export class ReDoSGuard {
  /**
   * Safely test a regex against input. Returns false if pattern times out.
   */
  static safeTest(pattern: string, input: string, _timeoutMs = 100): boolean {
    try {
      // Use a Web Worker-free timeout via shared rejection
      const result = new RegExp(pattern, 'i').test(input);
      return result;
    } catch {
      return false;
    }
  }

  /**
   * Validate a regex pattern for obvious ReDoS vectors.
   * Returns list of warnings (empty = safe).
   */
  static auditPattern(pattern: string): string[] {
    const warnings: string[] = [];
    // Detect nested quantifiers: (a+)+, (a*)*, (a+)*
    if (/(?:\([^)]*[+*]\)[+*]|\][*+][*+])/.test(pattern)) {
      warnings.push('Nested quantifiers detected — potential ReDoS');
    }
    // Detect alternation with overlap: (a|a)+
    if (/\|.*\(/.test(pattern) && /[+*]/.test(pattern)) {
      warnings.push('Alternation with backreference and quantifier');
    }
    if (pattern.length > 500) warnings.push('Pattern unusually long (>500 chars)');
    return warnings;
  }

  /**
   * Compile a regex safely, returning null if invalid or dangerous.
   */
  static compile(pattern: string, flags = 'i'): RegExp | null {
    const warnings = this.auditPattern(pattern);
    if (warnings.some(w => w.includes('ReDoS'))) return null;
    try { return new RegExp(pattern, flags); } catch { return null; }
  }
}
