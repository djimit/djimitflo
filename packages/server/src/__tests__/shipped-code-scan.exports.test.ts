import { describe, expect, it } from 'vitest';
import { loadTsParser, reportSummary, type ShippedCodeReport } from '../services/shipped-code-scan';

describe('loadTsParser', () => {
  it('returns null or a parser exposing createSourceFile and forEachChild', () => {
    const ts = loadTsParser();
    if (ts === null) {
      expect(ts).toBeNull();
    } else {
      expect(typeof ts.createSourceFile).toBe('function');
      expect(typeof ts.forEachChild).toBe('function');
      expect(typeof ts.version).toBe('string');
      expect(ts.version.length).toBeGreaterThan(0);
    }
  });

  it('caches the resolved parser (same reference on second call)', () => {
    const first = loadTsParser();
    const second = loadTsParser();
    expect(second).toBe(first);
  });
});

describe('reportSummary', () => {
  function makeReport(over: Partial<ShippedCodeReport> = {}): ShippedCodeReport {
    return {
      schema: 'shipped-code-scan/v1',
      package: { name: 'demo', version: '1.0.0' },
      parser: { name: 'typescript', version: '5.0.0' },
      limits: { max_parse_bytes: 1, max_files: 2, max_hash_bytes: 3 },
      lifecycle: [{ script: 'postinstall', command: 'echo hi' }],
      nested_lifecycle: [{ package: 'dep@2.0.0', path: 'node_modules/dep', script: 'install', command: 'node setup.js' }],
      bin: [{ name: 'demo', path: 'bin/demo.js' }],
      files: [
        { path: 'index.js', size: 10, sha256: 'a'.repeat(64) },
        { path: 'lib.js', size: 20, sha256: 'b'.repeat(64) },
      ],
      symlinks: [{ path: 'link', target: 'target' }],
      binaries: [{ path: 'native.so', format: 'elf', size: 99, sha256: 'c'.repeat(64) }],
      js: { parsed: 1, skipped: [{ path: 'big.js', reason: 'too_large' }] },
      findings: [
        { kind: 'eval', file: 'index.js', line: 3, detail: 'eval(...)' },
        { kind: 'eval', file: 'index.js', line: 7, detail: 'eval(...)' },
        { kind: 'endpoint', file: 'lib.js', line: 1, detail: 'fetch https://x.example.com' },
      ],
      hosts: ['x.example.com'],
      truncated: ['max_files'],
      report_hash: 'd'.repeat(64),
      ...over,
    };
  }

  it('counts files, parsed, skipped, lifecycle, bins, binaries, symlinks, hosts', () => {
    const s = reportSummary(makeReport());
    expect(s.files).toBe(2);
    expect(s.js_parsed).toBe(1);
    expect(s.js_skipped).toBe(1);
    expect(s.lifecycle_scripts).toBe(1);
    expect(s.nested_lifecycle_scripts).toBe(1);
    expect(s.bins).toBe(1);
    expect(s.binaries).toBe(1);
    expect(s.symlinks).toBe(1);
    expect(s.hosts).toBe(1);
  });

  it('groups findings by kind', () => {
    const s = reportSummary(makeReport());
    expect(s.findings_by_kind).toEqual({ eval: 2, endpoint: 1 });
  });

  it('reports the parser version or null when parser is absent', () => {
    expect(reportSummary(makeReport()).parser).toBe('5.0.0');
    expect(reportSummary(makeReport({ parser: null })).parser).toBeNull();
  });

  it('echoes the truncated array verbatim', () => {
    const s = reportSummary(makeReport({ truncated: ['max_files', 'deadline'] }));
    expect(s.truncated).toEqual(['max_files', 'deadline']);
  });

  it('returns empty findings_by_kind when there are no findings', () => {
    const s = reportSummary(makeReport({ findings: [] }));
    expect(s.findings_by_kind).toEqual({});
  });
});