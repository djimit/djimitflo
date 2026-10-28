import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  loadTsParser,
  reportSummary,
  type ShippedCodeReport,
} from '../services/shipped-code-scan';

const serverFile = join(__dirname, '../services/shipped-code-scan.ts');

describe('loadTsParser', () => {
  it('resolves the runtime `typescript-parser` alias and exposes the TS compiler JS API shape', () => {
    const ts = loadTsParser([[serverFile, 'typescript-parser']]);
    expect(ts).not.toBeNull();
    expect(typeof ts!.version).toBe('string');
    expect(ts!.version.length).toBeGreaterThan(0);
    expect(typeof ts!.createSourceFile).toBe('function');
    expect(typeof ts!.forEachChild).toBe('function');
    expect(typeof ts!.SyntaxKind).toBe('object');
    expect(typeof ts!.ScriptTarget).toBe('object');
    expect(typeof ts!.ScriptKind).toBe('object');
  });

  it('returns null when no candidate resolves', () => {
    expect(loadTsParser([])).toBeNull();
    expect(loadTsParser([[serverFile, 'no-such-parser-pkg']])).toBeNull();
    expect(loadTsParser([['/nonexistent/path/x.js', 'typescript']])).toBeNull();
  });

  it('caches the result for the default candidate list (same reference across calls)', () => {
    const a = loadTsParser();
    const b = loadTsParser();
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it('does not cache for an explicit non-default candidate list', () => {
    const fromDefault = loadTsParser();
    const fromAlias = loadTsParser([[serverFile, 'typescript-parser']]);
    // different call sites, both resolve the alias but the explicit-list call must not read/write the cache
    expect(fromAlias).not.toBeNull();
    expect(fromAlias!.version).toBe(fromDefault!.version);
    // a subsequent default call still returns the cached default reference (unaffected by the explicit call)
    expect(loadTsParser()).toBe(fromDefault);
  });
});

describe('reportSummary', () => {
  const base = (over: Partial<ShippedCodeReport> = {}): ShippedCodeReport => ({
    schema: 'shipped-code-scan/v1',
    package: { name: 'pkg', version: '1.0.0' },
    parser: { name: 'typescript', version: '6.0.3' },
    limits: { max_parse_bytes: 1, max_files: 2, max_hash_bytes: 3 },
    lifecycle: [],
    nested_lifecycle: [],
    bin: [],
    files: [],
    symlinks: [],
    binaries: [],
    js: { parsed: 0, skipped: [] },
    findings: [],
    hosts: [],
    truncated: [],
    report_hash: '0'.repeat(64),
    ...over,
  });

  it('summarises an empty report with zeroed counts and an empty findings_by_kind map', () => {
    const s = reportSummary(base());
    expect(s).toEqual({
      files: 0,
      js_parsed: 0,
      js_skipped: 0,
      lifecycle_scripts: 0,
      nested_lifecycle_scripts: 0,
      bins: 0,
      binaries: 0,
      symlinks: 0,
      hosts: 0,
      findings_by_kind: {},
      parser: '6.0.3',
      truncated: [],
    });
  });

  it('counts files, js parsed/skipped, lifecycle, bins, binaries, symlinks and hosts', () => {
    const r = base({
      files: [{ path: 'a.js', size: 1, sha256: 'x' }, { path: 'b.js', size: 2, sha256: 'y' }],
      js: { parsed: 3, skipped: [{ path: 'big.js', reason: 'too_large' }] },
      lifecycle: [{ script: 'postinstall', command: 'node x.js' }],
      nested_lifecycle: [{ package: 'dep@1', path: 'node_modules/dep', script: 'install', command: 'sh' }],
      bin: [{ name: 'cli', path: 'cli.js' }],
      binaries: [{ path: 'native.node', format: 'elf', size: 10, sha256: 'z' }],
      symlinks: [{ path: 'link', target: 'elsewhere' }],
      hosts: ['example.com', 'api.example.com'],
    });
    const s = reportSummary(r);
    expect(s.files).toBe(2);
    expect(s.js_parsed).toBe(3);
    expect(s.js_skipped).toBe(1);
    expect(s.lifecycle_scripts).toBe(1);
    expect(s.nested_lifecycle_scripts).toBe(1);
    expect(s.bins).toBe(1);
    expect(s.binaries).toBe(1);
    expect(s.symlinks).toBe(1);
    expect(s.hosts).toBe(2);
  });

  it('aggregates findings_by_kind counts across all finding kinds', () => {
    const r = base({
      findings: [
        { kind: 'eval', file: 'a.js', line: 1, detail: 'eval(...)' },
        { kind: 'eval', file: 'a.js', line: 5, detail: 'eval(...)' },
        { kind: 'module_import', file: 'b.js', line: 2, detail: 'network:http' },
        { kind: 'env_token_read', file: 'c.js', line: 3, detail: 'API_KEY' },
      ],
    });
    expect(reportSummary(r).findings_by_kind).toEqual({
      eval: 2,
      module_import: 1,
      env_token_read: 1,
    });
  });

  it('reports null parser when the report has no parser', () => {
    expect(reportSummary(base({ parser: null })).parser).toBeNull();
  });

  it('passes truncated through unchanged', () => {
    const truncated = ['js_parser_unavailable', 'max_files'];
    expect(reportSummary(base({ truncated })).truncated).toEqual(truncated);
  });
});