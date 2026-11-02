import { describe, expect, it } from 'vitest';
import {
  OCR_MANIFEST_SCHEMA, assessOcrIndependence, buildOcrProvenance, computeCoverage, evaluateOcrRun, globMatch, isTestPath,
  ocrShadowMode, parseNameStatusZ, type OcrJsonDocument, type OcrManifest, type OcrProcessResult, type TrustedReviewPolicy,
} from '../services/ocr-review-adapter';

// Fake OCR outputs only: the shape mirrors open-code-review@375f64cd cmd/opencodereview/output.go jsonOutput and
// internal/session/manifest.go RunManifest. No OCR binary is run and no model is called.

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const RULE_SHA = 'c'.repeat(64);
const z = (...records: string[][]) => records.flat().join('\0') + '\0';

const policy = (over: Partial<TrustedReviewPolicy> = {}): TrustedReviewPolicy => ({
  policy_ref: 'docs/research/ocr/trusted-rule.json@test', trusted_rule_sha256: RULE_SHA, protected_paths: [],
  out_of_scope: [], trusted_waivers: [], trusted_parent_runs: [], ...over,
});

type Cov = OcrManifest['coverage'];
const manifest = (coverage: Partial<Cov>, over: Partial<OcrManifest> = {}): OcrManifest => {
  const c: Cov = { selected: [], completed: [], reused: [], failed: [], waived: [], ...coverage };
  if (!coverage.selected) c.selected = [...c.completed, ...c.reused, ...c.failed, ...c.waived];
  const failed = c.failed.length;
  const terminal = c.selected.length === 0 ? 'skipped' : failed === 0 ? 'complete' : failed === c.selected.length ? 'failed' : 'partial';
  return {
    schema_version: OCR_MANIFEST_SCHEMA, run_id: 'run-1', terminal_state: terminal,
    input: { mode: 'range', resolved_base: BASE, resolved_head: HEAD },
    execution: { ocr_version: '1.13.2', provider: 'anthropic', model: 'claude-x', rule_config_sha256: RULE_SHA, runtime_config_sha256: 'd'.repeat(64) },
    coverage: c, elapsed_ms: 1000, ...over,
  };
};
const run = (doc: Partial<OcrJsonDocument> | null, over: Partial<OcrProcessResult> = {}): OcrProcessResult => ({
  exit_code: 0, signal: null, terminated_by: null, duration_ms: 1234,
  stdout: doc ? JSON.stringify({ status: doc.manifest?.terminal_state ?? 'success', comments: [], ...doc }) : '', ...over,
});

describe('ocr-review-adapter: flag and parsing', () => {
  it('is off unless OCR_SHADOW_REVIEW_MODE=shadow; there is no acting mode', () => {
    expect(ocrShadowMode({})).toBe('off');
    expect(ocrShadowMode({ OCR_SHADOW_REVIEW_MODE: 'enforce' })).toBe('off');
    expect(ocrShadowMode({ OCR_SHADOW_REVIEW_MODE: 'Shadow' })).toBe('shadow');
  });

  it('parses adds, modifications, renames, copies and deletions with explicit test classification', () => {
    const { items, errors } = parseNameStatusZ(z(['A', 'src/new.ts'], ['M', 'src/a.ts'], ['R087', 'src/old.ts', 'src/moved.ts'],
      ['D', 'src/gone.ts'], ['C100', 'src/a.ts', 'src/copy.ts'], ['M', 'packages/x/src/__tests__/a.test.ts']));
    expect(errors).toEqual([]);
    expect(items.map((i) => [i.change, i.path, i.old_path, i.similarity, i.is_test])).toEqual([
      ['added', 'src/new.ts', null, null, false], ['modified', 'src/a.ts', null, null, false], ['renamed', 'src/moved.ts', 'src/old.ts', 87, false],
      ['deleted', 'src/gone.ts', null, null, false], ['copied', 'src/copy.ts', 'src/a.ts', 100, false], ['modified', 'packages/x/src/__tests__/a.test.ts', null, null, true],
    ]);
    expect(parseNameStatusZ(z(['U', 'conflict.ts'])).errors).toEqual(['unsupported_diff_status:U']);
  });

  it('classifies test files itself and matches globs', () => {
    expect(['a_test.go', 'tests/x.py', 'test_x.py', 'src/a.spec.tsx', 'pkg/testdata/f.json'].every(isTestPath)).toBe(true);
    expect(isTestPath('src/contest.ts')).toBe(false);
    expect(globMatch('.opencodereview/**', '.opencodereview/rule.json')).toBe(true);
    expect(globMatch('**/*.md', 'README.md')).toBe(true);
    expect(globMatch('docs/*.md', 'docs/a/b.md')).toBe(false);
  });
});

describe('ocr-review-adapter: the six failure cases (fake OCR outputs)', () => {
  it('1. test-only PR: OCR default-excludes the test file and reports skipped with exit 0 → SKIPPED, gate unknown, never accepted', () => {
    const input = { base_sha: BASE, head_sha: HEAD, name_status_z: z(['M', 'packages/server/src/__tests__/loop.test.ts']) };
    const v = evaluateOcrRun(input, run({ status: 'skipped', manifest: manifest({}) }), policy(), [], { 'packages/server/src/__tests__/loop.test.ts': 'default_path' });
    expect(v.outcome).toBe('SKIPPED');
    expect(v.gate).toBe('unknown');
    expect(v.accepted).toBe(false);
    expect(v.coverage[0]).toMatchObject({ status: 'unreviewed', reason: 'ocr_excluded:default_path', is_test: true });
  });

  it('2. partial review with exit 0 and zero findings → PARTIAL, gate unknown (exit 0 and empty findings are not evidence)', () => {
    const input = { base_sha: BASE, head_sha: HEAD, name_status_z: z(['M', 'src/a.ts'], ['M', 'src/b.ts']) };
    const m = manifest({ completed: [{ path: 'src/a.ts' }], failed: [{ path: 'src/b.ts', classification: 'provider', reason: 'HTTP 529' }] });
    expect(m.terminal_state).toBe('partial');
    const v = evaluateOcrRun(input, run({ manifest: m }), policy());
    expect(v.outcome).toBe('PARTIAL');
    expect(v.gate).toBe('unknown');
    expect(v.findings).toEqual([]);
    expect(v.coverage.find((e) => e.path === 'src/b.ts')).toMatchObject({ status: 'unreviewed', reason: 'ocr_failed:provider' });
  });

  it('3. skipped review with no findings on a non-empty diff → SKIPPED, not COMPLETE; a control does not turn it into an OCR review', () => {
    const input = { base_sha: BASE, head_sha: HEAD, name_status_z: z(['A', 'assets/logo.bin']) };
    const v = evaluateOcrRun(input, run({ status: 'skipped', manifest: manifest({}) }), policy(),
      [{ path: 'assets/logo.bin', control: 'existing checker', evidence_ref: 'lease:chk-1' }], { 'assets/logo.bin': 'binary' });
    expect(v.outcome).toBe('SKIPPED');
    expect(v.gate).toBe('unknown');
    expect(v.counts).toMatchObject({ covered_by_control: 1, reviewed: 0 });
  });

  it('4. PR that changes review rules: rules from the change leaked into the run → INSUFFICIENT_EVIDENCE; trusted rules → normal verdict, flagged', () => {
    const input = { base_sha: BASE, head_sha: HEAD, name_status_z: z(['M', '.opencodereview/rule.json'], ['M', 'src/a.ts']) };
    const cov = { completed: [{ path: '.opencodereview/rule.json' }, { path: 'src/a.ts' }] };
    const leaked = evaluateOcrRun(input, run({ manifest: manifest(cov, { execution: { rule_config_sha256: 'e'.repeat(64) } }) }), policy());
    expect(leaked.outcome).toBe('INSUFFICIENT_EVIDENCE');
    expect(leaked.reasons).toEqual(expect.arrayContaining(['ocr_rules_not_trusted_copy', 'review_config_in_change:.opencodereview/rule.json']));
    const trusted = evaluateOcrRun(input, run({ manifest: manifest(cov) }), policy());
    expect(trusted.outcome).toBe('COMPLETE');
    expect(trusted.reasons).toContain('review_config_in_change:.opencodereview/rule.json');
    // no trusted hash recorded yet → nothing can be COMPLETE
    expect(evaluateOcrRun(input, run({ manifest: manifest(cov) }), policy({ trusted_rule_sha256: null })).outcome).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('5. deleted and renamed files: a deletion OCR never reviews keeps the run PARTIAL; a rename matches on old+new path', () => {
    const input = { base_sha: BASE, head_sha: HEAD, name_status_z: z(['D', 'src/auth-check.ts'], ['R095', 'src/old.ts', 'src/new.ts']) };
    const v = evaluateOcrRun(input, run({ manifest: manifest({ completed: [{ path: 'src/new.ts', old_path: 'src/old.ts' }] }) }), policy());
    expect(v.outcome).toBe('PARTIAL');
    expect(v.coverage).toEqual([
      expect.objectContaining({ path: 'src/auth-check.ts', change: 'deleted', status: 'unreviewed', reason: 'ocr_does_not_review_deletions' }),
      expect.objectContaining({ path: 'src/new.ts', old_path: 'src/old.ts', change: 'renamed', status: 'reviewed' }),
    ]);
    // only a named control with evidence may cover the deletion
    const covered = evaluateOcrRun(input, run({ manifest: manifest({ completed: [{ path: 'src/new.ts', old_path: 'src/old.ts' }] }) }), policy(),
      [{ path: 'src/auth-check.ts', control: 'existing checker', evidence_ref: 'lease:chk-1' }]);
    expect(covered.outcome).toBe('COMPLETE');
    expect(covered.counts).toMatchObject({ reviewed: 1, covered_by_control: 1, unreviewed: 0 });
  });

  it('6a. time/budget termination by the adapter (no output, signal) → INSUFFICIENT_EVIDENCE with the cause', () => {
    const input = { base_sha: BASE, head_sha: HEAD, name_status_z: z(['M', 'src/a.ts']) };
    const v = evaluateOcrRun(input, run(null, { exit_code: null, signal: 'SIGKILL', terminated_by: 'wall_timeout' }), policy());
    expect(v.outcome).toBe('INSUFFICIENT_EVIDENCE');
    expect(v.reasons).toEqual(expect.arrayContaining(['ocr_no_output', 'terminated_by_adapter:wall_timeout', 'ocr_killed_by_signal:SIGKILL']));
    const prov = buildOcrProvenance({ repo: 'r', ocr_version: '1.13.2', ocr_source_revision: 's', binary_sha256: 'f'.repeat(64), tools_config: 'embedded', mcp_servers: [],
      max_concurrency: 1, timeout_minutes: 15, max_tokens_budget: 400000 }, input, run(null, { terminated_by: 'wall_timeout' }), policy(), v);
    expect(prov.tokens).toEqual({ input: null, output: null, total: null }); // UNKNOWN, never 0
    expect(prov.terminated_by).toBe('wall_timeout');
  });

  it('6b. OCR\'s own token budget stop (failed(budget) items, exit 0, findings present) → PARTIAL; findings kept as shadow observations', () => {
    const input = { base_sha: BASE, head_sha: HEAD, name_status_z: z(['M', 'src/a.ts'], ['M', 'src/b.ts']) };
    const m = manifest({ completed: [{ path: 'src/a.ts' }], failed: [{ path: 'src/b.ts', classification: 'budget' }] });
    const v = evaluateOcrRun(input, run({ manifest: m, summary: { input_tokens: 390000, output_tokens: 9000, total_tokens: 399000, budget_exceeded: true },
      comments: [{ path: 'src/a.ts', content: 'unchecked null', start_line: 3, end_line: 4, severity: 'high', category: 'bug' }] }), policy());
    expect(v.outcome).toBe('PARTIAL');
    expect(v.gate).toBe('unknown');
    expect(v.findings).toHaveLength(1);
    expect(v.findings[0]).toMatchObject({ path: 'src/a.ts', in_diff: true, severity: 'high' });
  });
});

describe('ocr-review-adapter: evidence preconditions', () => {
  const input = { base_sha: BASE, head_sha: HEAD, name_status_z: z(['M', 'src/a.ts']) };
  const full = manifest({ completed: [{ path: 'src/a.ts' }] });

  it('COMPLETE observes: no findings → pass, findings → fail; accepted stays false', () => {
    const clean = evaluateOcrRun(input, run({ manifest: full }), policy());
    expect([clean.outcome, clean.gate, clean.accepted]).toEqual(['COMPLETE', 'pass', false]);
    const dirty = evaluateOcrRun(input, run({ manifest: full, comments: [{ path: 'src/a.ts', content: 'x' }] }), policy());
    expect([dirty.outcome, dirty.gate, dirty.accepted]).toEqual(['COMPLETE', 'fail', false]);
  });

  it('missing manifest, unknown schema, SHA drift, items outside the diff, exit≠0 contradiction → INSUFFICIENT_EVIDENCE', () => {
    expect(evaluateOcrRun(input, run({ status: 'success' }), policy()).reasons).toContain('ocr_manifest_missing');
    expect(evaluateOcrRun(input, run({ manifest: { ...full, schema_version: 'ocr.run-manifest/v2' } }), policy()).outcome).toBe('INSUFFICIENT_EVIDENCE');
    expect(evaluateOcrRun(input, run({ manifest: { ...full, input: { mode: 'range', resolved_base: BASE, resolved_head: 'f'.repeat(40) } } }), policy()).reasons).toContain('ocr_input_sha_mismatch');
    const extra = manifest({ completed: [{ path: 'src/a.ts' }, { path: 'src/not-in-diff.ts' }] });
    expect(evaluateOcrRun(input, run({ manifest: extra }), policy()).reasons).toContain('ocr_items_outside_frozen_diff:src/not-in-diff.ts');
    expect(evaluateOcrRun(input, run({ manifest: full }, { exit_code: 1 }), policy()).reasons).toContain('ocr_exit_1_contradicts_complete');
    expect(evaluateOcrRun(input, run(null, { stdout: 'not json' }), policy()).reasons).toContain('ocr_output_not_json');
  });

  it('reuse and waivers count only when the trusted policy vouches for them', () => {
    const reused = manifest({ reused: [{ path: 'src/a.ts' }] }, { parent_run_id: 'run-0' });
    expect(evaluateOcrRun(input, run({ manifest: reused }), policy()).coverage[0].reason).toBe('ocr_reuse_unverified');
    expect(evaluateOcrRun(input, run({ manifest: reused }), policy({ trusted_parent_runs: ['run-0'] })).outcome).toBe('COMPLETE');
    const waived = manifest({ waived: [{ path: 'src/a.ts', reason: 'user said so' }] });
    expect(computeCoverage(parseNameStatusZ(input.name_status_z).items, waived, policy()).entries[0].reason).toBe('ocr_waiver_not_trusted');
  });

  it('failed run maps to FAILED (gate unknown), not to a negative review', () => {
    const failed = manifest({ failed: [{ path: 'src/a.ts', classification: 'provider' }] }, { run_failure: { classification: 'configuration' } });
    const v = evaluateOcrRun(input, run({ manifest: { ...failed, terminal_state: 'failed' } }, { exit_code: 1 }), policy());
    expect([v.outcome, v.gate]).toEqual(['FAILED', 'unknown']);
  });

  it('independence: same family as the checker is correlated; a different family and provider is not', () => {
    const checker = { id: 'chk', runtime: 'opencode', model: 'ollama/glm-5.2:cloud', prompt: 'p' };
    const same = assessOcrIndependence(checker, { provider: 'ollama', model: 'glm-5.2:cloud', prompt_identity: 'ocr-1.13.2' });
    expect(same.state).toBe('FAIL');
    expect(same.correlated_fields).toEqual(expect.arrayContaining(['model_family_independence', 'provider_independence']));
    const other = assessOcrIndependence(checker, { provider: 'anthropic', model: 'claude-x', prompt_identity: 'ocr-1.13.2' });
    expect(other.correlated_fields).toEqual([]);
    expect(other.state).toBe('UNDETERMINED'); // context/memory/retrieval/oracle hashes unknown → never a PASS by default
    expect(assessOcrIndependence(checker, { provider: null, model: null, prompt_identity: 'x' }).state).toBe('UNDETERMINED');
  });
});

describe('ocr-review-adapter: shadow isolation', () => {
  it('imports nothing that can comment, set a status, merge, or record a checker verdict', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const src = readFileSync(join(__dirname, '../services/ocr-review-adapter.ts'), 'utf8');
    const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort();
    expect(imports).toEqual(['./loop-types', './reviewer-independence-service', 'better-sqlite3', 'crypto']);
    expect(src).not.toMatch(/submitCheckerVerdict|statuses\/|gh pr comment|child_process|insertJudgmentRow/);
  });
});
