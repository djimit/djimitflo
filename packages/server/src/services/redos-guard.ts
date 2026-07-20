/**
 * ReDoSGuard — rejects obvious dangerous user-supplied regex patterns.
 */
export class ReDoSGuard {
  /**
   * Test a regex only after the heuristic compiler accepts it.
   */
  static safeTest(pattern: string, input: string): boolean {
    const regex = this.compile(pattern);
    return regex ? regex.test(input) : false;
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
    if (/\|.*\(/.test(pattern) && /[+*]/.test(pattern)) {
      warnings.push('Alternation with quantifier');
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
