import { describe, expect, it } from 'vitest';
import { ReDoSGuard } from '../services/redos-guard';

describe('ReDoSGuard', () => {
  it('rejects obvious nested quantifiers and accepts simple patterns', () => {
    expect(ReDoSGuard.compile('(a+)+')).toBeNull();
    expect(ReDoSGuard.safeTest('allowed', '{"action":"allowed"}')).toBe(true);
  });

  it('auditPattern returns no warnings for a safe pattern', () => {
    expect(ReDoSGuard.auditPattern('hello')).toEqual([]);
    expect(ReDoSGuard.auditPattern('^abc$')).toEqual([]);
  });

  it('auditPattern flags nested quantifiers with a ReDoS warning', () => {
    expect(ReDoSGuard.auditPattern('(a+)+').some(w => w.includes('ReDoS'))).toBe(true);
    expect(ReDoSGuard.auditPattern('(a*)*').some(w => w.includes('ReDoS'))).toBe(true);
    expect(ReDoSGuard.auditPattern('a]**').some(w => w.includes('ReDoS'))).toBe(true);
  });

  it('auditPattern flags alternation with quantifier but not separately', () => {
    expect(ReDoSGuard.auditPattern('a|b(c+)')).toContain('Alternation with quantifier');
    // has |(  but no quantifier — should NOT flag alternation
    expect(ReDoSGuard.auditPattern('|a(b')).not.toContain('Alternation with quantifier');
    // has quantifier but no |( — should NOT flag alternation
    expect(ReDoSGuard.auditPattern('abc+')).not.toContain('Alternation with quantifier');
  });

  it('auditPattern flags patterns longer than 500 chars but not exactly 500', () => {
    expect(ReDoSGuard.auditPattern('a'.repeat(501)).some(w => w.includes('>500'))).toBe(true);
    expect(ReDoSGuard.auditPattern('a'.repeat(500)).some(w => w.includes('>500'))).toBe(false);
  });

  it('compile returns null for invalid regex', () => {
    expect(ReDoSGuard.compile('[')).toBeNull();
    expect(ReDoSGuard.compile('*')).toBeNull();
  });

  it('compile returns a working RegExp for safe patterns', () => {
    const r = ReDoSGuard.compile('^abc');
    expect(r).toBeInstanceOf(RegExp);
    expect(r!.test('abcdef')).toBe(true);
    expect(r!.test('xyz')).toBe(false);
  });

  it('compile rejects patterns with ReDoS warnings', () => {
    expect(ReDoSGuard.compile('(a+)+')).toBeNull();
    expect(ReDoSGuard.compile('(a*)*')).toBeNull();
    expect(ReDoSGuard.compile('a]**')).toBeNull();
  });

  it('compile accepts patterns with non-ReDoS warnings', () => {
    const r = ReDoSGuard.compile('a|b(c+)');
    expect(r).toBeInstanceOf(RegExp);
  });

  it('compile respects custom flags', () => {
    const r = ReDoSGuard.compile('abc', 'g');
    expect(r).toBeInstanceOf(RegExp);
    expect(r!.flags).toBe('g');
  });

  it('safeTest returns false for dangerous patterns', () => {
    expect(ReDoSGuard.safeTest('(a+)+', 'aaaa')).toBe(false);
    expect(ReDoSGuard.safeTest('(a*)*', 'aaa')).toBe(false);
  });

  it('safeTest returns false for valid non-matching patterns', () => {
    expect(ReDoSGuard.safeTest('^xyz', 'abc')).toBe(false);
  });

  it('safeTest returns true for valid matching patterns', () => {
    expect(ReDoSGuard.safeTest('^abc', 'abcdef')).toBe(true);
  });
});