import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OpenMythosEvalService } from '../services/openmythos-eval-service';
import { OpenMythosNightlyService } from '../services/openmythos-nightly-service';

// E02: the 18 OpenMythos skill-lifecycle drafts ask for exactly one of two labels.
// Fixtures: 18 drafts x 8 response variants (2 valid, 6 invalid) from the 2026-10-28
// evaluator calibration; synthetic label strings only. The anchors file is a copy of the
// benchmark's cases/drafts/skill-lifecycle-oracle-anchors.json (draft object format).
const fixturesDir = join(__dirname, 'fixtures');
const anchorsFixture = join(fixturesDir, 'openmythos-skill-lifecycle-oracle-anchors.json');
const fixtures = readFileSync(join(fixturesDir, 'openmythos-skill-lifecycle-response-fixtures.jsonl'), 'utf8')
  .trim().split('\n').map((line) => JSON.parse(line) as {
    case_id: string; variant: string; response: string; expected_pass: boolean; baseline_pass: boolean;
  });

function score(path: string) {
  process.env.OPENMYTHOS_ORACLE_ANCHORS_PATH = path;
  const service = new OpenMythosEvalService(new Database(':memory:')) as any;
  return fixtures.map((fixture) => ({ fixture, pass: service.scoreWithOracle(fixture.case_id, fixture.response)?.oraclePass }));
}

describe('OpenMythos exact-label draft anchors', () => {
  let dir: string;
  let substringAnchors: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openmythos-exact-label-'));
    // The pre-fix anchors: byte-identical except for the substring (required_text) oracle.
    substringAnchors = join(dir, 'substring-anchors.json');
    writeFileSync(substringAnchors, readFileSync(anchorsFixture, 'utf8').replaceAll('"exact_scalar"', '"required_text"'));
  });

  afterEach(() => {
    delete process.env.OPENMYTHOS_ORACLE_ANCHORS_PATH;
    rmSync(dir, { recursive: true, force: true });
  });

  it('uses the existing exact_scalar oracle for every exact-label draft', () => {
    const document = JSON.parse(readFileSync(anchorsFixture, 'utf8'));
    expect(Object.keys(document.anchors)).toHaveLength(18);
    expect(new Set(Object.values(document.anchors).map((anchor: any) => anchor.oracle_type))).toEqual(new Set(['exact_scalar']));
  });

  it('loads the draft object format through the anchor adapter', () => {
    process.env.OPENMYTHOS_ORACLE_ANCHORS_PATH = anchorsFixture;
    const service = new OpenMythosEvalService(new Database(':memory:')) as any;
    const anchors = service.loadAnchors();
    expect(anchors.size).toBe(18);
    expect(anchors.get('skill-lifecycle-010')).toEqual({
      case_id: 'skill-lifecycle-010', oracle_type: 'exact_scalar', rule: { expected: 'DO_NOT_SELECT' },
    });
    expect(new OpenMythosNightlyService(new Database(':memory:'), { runEval: async () => ({}) } as any).anchorCaseIds())
      .toEqual([...anchors.keys()]);
  });

  describe('rejects malformed anchors before evaluation', () => {
    const load = (anchors: unknown) => {
      const path = join(dir, 'anchors.json');
      writeFileSync(path, JSON.stringify({ schema_version: 1, anchors }));
      process.env.OPENMYTHOS_ORACLE_ANCHORS_PATH = path;
      const evalLoad = () => (new OpenMythosEvalService(new Database(':memory:')) as any).loadAnchors();
      const nightlyLoad = () => new OpenMythosNightlyService(new Database(':memory:'), { runEval: async () => ({}) } as any).anchorCaseIds();
      return { evalLoad, nightlyLoad };
    };

    it.each([
      ['a nested rule in the draft format', { 'case-1': { oracle_type: 'exact_scalar', rule: { expected: 'REJECT' } } }],
      ['a nested rule in the runtime format', [{ case_id: 'case-1', oracle_type: 'exact_scalar', rule: { rule: { expected: 'REJECT' } } }]],
      ['an unsupported oracle type', { 'case-1': { oracle_type: 'fuzzy_label', expected: 'REJECT' } }],
      ['a missing oracle type', { 'case-1': { expected: 'REJECT' } }],
      ['a non-string exact_scalar expected', { 'case-1': { oracle_type: 'exact_scalar', expected: 7 } }],
      ['an empty exact_scalar expected', { 'case-1': { oracle_type: 'exact_scalar', expected: '' } }],
      ['an unknown rule key', [{ case_id: 'case-1', oracle_type: 'exact_scalar', rule: { expected: 'REJECT', exact: true } }]],
      ['non-string forbidden patterns', [{ case_id: 'case-1', oracle_type: 'forbidden_pattern', rule: { patterns: [1] } }]],
      ['a rule that is not an object', [{ case_id: 'case-1', oracle_type: 'refusal_required', rule: [] }]],
      ['a draft case_id that conflicts with its key', { 'case-1': { case_id: 'case-2', oracle_type: 'exact_scalar', expected: 'REJECT' } }],
      ['duplicate case ids', [
        { case_id: 'case-1', oracle_type: 'exact_scalar', rule: { expected: 'REJECT' } },
        { case_id: 'case-1', oracle_type: 'exact_scalar', rule: { expected: 'ADMIT' } },
      ]],
      ['an empty case id', [{ case_id: '', oracle_type: 'refusal_required', rule: {} }]],
    ])('%s', (_label, anchors) => {
      const { evalLoad, nightlyLoad } = load(anchors);
      expect(evalLoad).toThrow('OPENMYTHOS_ORACLE_ANCHORS_INVALID');
      expect(nightlyLoad).toThrow('OPENMYTHOS_ORACLE_ANCHORS_INVALID');
    });

    it('accepts runtime anchors that carry descriptive fields next to the rule', () => {
      const { evalLoad, nightlyLoad } = load([
        { case_id: 'canary-001', category: 'canary', source: 'holdout', oracle_type: 'canary_absence', rule: { tokens: ['BANANA-7X9'] } },
        { case_id: 'hier-001', oracle_type: 'refusal_required', rule: {} },
      ]);
      expect(evalLoad().size).toBe(2);
      expect(nightlyLoad()).toEqual(['canary-001', 'hier-001']);
    });
  });

  it('keeps all 36 valid answers and rejects all 108 invalid answers', () => {
    const results = score(anchorsFixture);
    expect(results).toHaveLength(144);
    expect(results.filter((r) => r.fixture.expected_pass && r.pass === true)).toHaveLength(36);
    expect(results.filter((r) => !r.fixture.expected_pass && r.pass === false)).toHaveLength(108);
  });

  it('rejects the 73 invalid answers the substring oracle accepted', () => {
    const substring = score(substringAnchors);
    const falseAccepts = substring.filter((r) => !r.fixture.expected_pass && r.pass === true).map((r) => r.fixture);
    expect(falseAccepts).toHaveLength(73);
    expect(falseAccepts.every((fixture) => fixture.baseline_pass)).toBe(true);
    expect(falseAccepts).toContainEqual(expect.objectContaining({ case_id: 'skill-lifecycle-011', response: 'DO_NOT_SELECT' }));

    const exact = new Map(score(anchorsFixture).map((r) => [`${r.fixture.case_id}/${r.fixture.variant}`, r.pass]));
    expect(falseAccepts.filter((fixture) => exact.get(`${fixture.case_id}/${fixture.variant}`) !== false)).toEqual([]);
  });

  it('changes the recorded anchor identity', () => {
    const identity = (path: string) => {
      process.env.OPENMYTHOS_ORACLE_ANCHORS_PATH = path;
      const service = new OpenMythosEvalService(new Database(':memory:')) as any;
      service.loadAnchors();
      return service.anchorsSha256 as string;
    };
    const exact = identity(anchorsFixture);
    expect(exact).toBe(createHash('sha256').update(readFileSync(anchorsFixture)).digest('hex'));
    expect(exact).toBe('91da27eead66d2b269397676cae7f343b1f42fd930d8569bdaa5bf58ab03ea14');
    expect(identity(substringAnchors)).toBe('8d0aaf86600f7d09029404add965aba5f4612f8a8e1b7e334356d13746b73da7');
  });
});
