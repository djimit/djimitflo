import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { CHECKER_INSTRUCTIONS, LoopService } from '../services/loop-service';

// F1-R (the checker benchmark, rebuilt): committed items, deterministic weakening, the scorer, and the periodic-benchmark
// options of the shared SEC-F1 runner (--role checker, --benchmark). No network, no model.
type Build = typeof import('../../../../scripts/f1-build-items.mjs');
type F1Score = typeof import('../../../../scripts/f1-score.mjs');
type Run = typeof import('../../../../scripts/sec-f1-run.mjs');
const build = async () => (await import('../../../../scripts/f1-build-items.mjs')) as Build;
const f1score = async () => (await import('../../../../scripts/f1-score.mjs')) as F1Score;
const runner = async () => (await import('../../../../scripts/sec-f1-run.mjs')) as Run;
const DIR = path.resolve(__dirname, '../../../../docs/research/eco/f1');
const manifest = () => JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8')) as { items: Array<Record<string, any>> };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('F1-R items (docs/research/eco/f1)', () => {
  it('40 items: 20 good + 20 defective of the 20 registered PRs, kinds A 7 / B 7 / C 6, patch hashes match', () => {
    const { items } = manifest();
    expect(items).toHaveLength(40);
    expect(items.filter((i) => i.side === 'good')).toHaveLength(20);
    const def = items.filter((i) => i.side === 'defective');
    expect(def.map((i) => i.pr).sort()).toEqual([474, 475, 537, 552, 571, 574, 582, 587, 588, 590, 591, 592, 593, 594, 605, 606, 610, 611, 612, 616]);
    const kinds = (k: string) => def.filter((i) => i.kind === k).map((i) => i.pr).sort();
    expect(kinds('A')).toEqual([475, 571, 587, 591, 594, 610, 616]);
    expect(kinds('B')).toEqual([474, 552, 582, 590, 593, 606, 612]);
    expect(kinds('C')).toEqual([537, 574, 588, 592, 605, 611]);
    for (const i of items) {
      const patch = fs.readFileSync(path.join(DIR, 'items', `${i.id}.patch`), 'utf8');
      expect(sha(patch), i.id).toBe(i.patch_sha256);
      expect(sha(JSON.stringify(i.finding))).toBe(i.finding_sha256);
      expect(i.files).toHaveLength(1);
      expect(i.files[0]).toMatch(/^packages\/server\/src\/__tests__\/.+\.test\.ts$/); // test files only
      expect(i.repo).toBe('djimit/djimitflo');
      if (i.side === 'defective') expect(i.defect_lines.length).toBeGreaterThan(0);
    }
  });

  it('blind: the reviewer-visible fields of a PR\'s good and defective item are the same except the patch', async () => {
    const { BLIND_FIELDS } = await import('../../../../scripts/sec-f1-lib.mjs');
    const { items } = manifest();
    for (const pr of new Set(items.map((i) => i.pr))) {
      const [a, b] = items.filter((i) => i.pr === pr);
      for (const f of BLIND_FIELDS.filter((x: string) => !['id', 'patch_sha256'].includes(x))) expect(a[f], `${pr} ${f}`).toEqual(b[f]);
      expect(JSON.stringify(a.finding)).not.toMatch(/defect|weaken|good|mutant|toBeDefined/i);
    }
  });

  it('defective A removes every added expect statement (multi-line and chained), B weakens matchers, C drops the target import', async () => {
    const { removeExpects, weakenMatchers, dropTargetImport, targetModule, addedLineNumbers } = await build();
    const all = (n: number) => new Set(Array.from({ length: n }, (_, i) => i + 1));
    const a = ['it(\'x\', () => {', '  const r = f();', '  expect(r).toEqual({', '    a: 1,', '  });', '  expect(() => g())', '    .toThrow(\'no\');', '  done();', '});'];
    expect(removeExpects(a, all(a.length))).toEqual({ lines: ['it(\'x\', () => {', '  const r = f();', '  done();', '});'], changed: [3, 4, 5, 6, 7] });
    expect(removeExpects(a, new Set([1, 2])).changed).toEqual([]); // only added lines are weakened
    const b = ['  expect(x).toBe(1);', '  expect(y).not.toEqual([1, 2]);', '  await expect(p).rejects.toThrow(/boom/);', '  expect(z).toBeDefined();'];
    expect(weakenMatchers(b, all(4))).toEqual({ lines: ['  expect(x).toBeDefined();', '  expect(y).toBeDefined();', '  await expect(p).toBeDefined();', '  expect(z).toBeDefined();'], changed: [1, 2, 3] });
    const c = ['import { a } from \'vitest\';', 'import {', '  isX,', '  isY,', '} from \'../services/llm-fallback\';', 'import { other } from \'../services/llm-fallback-extra\';'];
    expect(targetModule('loop: Test untested exports of services/llm-fallback.ts (#588)')).toBe('services/llm-fallback');
    expect(dropTargetImport(c, all(6), 'services/llm-fallback')).toEqual({ lines: [c[0], c[5]], changed: [2, 3, 4, 5] });
    expect([...addedLineNumbers('@@ -0,0 +1,3 @@\n+a\n+b\n+c\n@@ -10 +12 @@\n-x\n+y')]).toEqual([1, 2, 3, 12]);
  });

  const haveHistory = (() => { try { execFileSync('git', ['cat-file', '-e', 'c7bec59e3ecb62a2aa61844b5fdb6e24416feb0c^{commit}'], { cwd: DIR, stdio: 'ignore' }); return true; } catch { return false; } })();
  it.skipIf(!haveHistory)('the committed items are exactly what the builder produces from the 20 merge commits (reproducible)', async () => {
    const { buildItems } = await build();
    const { manifest: m, patches } = buildItems();
    expect(`${JSON.stringify(m, null, 2)}\n`).toBe(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
    for (const [id, p] of patches) expect(p).toBe(fs.readFileSync(path.join(DIR, 'items', `${id}.patch`), 'utf8'));
  }, 60_000);
});

describe('F1-R scorer', () => {
  const items = [...Array.from({ length: 4 }, (_, i) => ({ id: `d${i}`, pr: i, side: 'defective', kind: i < 2 ? 'A' : 'B' })), ...Array.from({ length: 4 }, (_, i) => ({ id: `g${i}`, pr: i, side: 'good', kind: null }))];
  it('AUC over the verdict order, caught / false rejects / defective accepted, unscored kept out and listed', async () => {
    const { scoreF1 } = await f1score();
    const r = (id: string, verdict: string) => ({ id, verdict, tokens_total: 100 });
    const s = scoreF1(items, [r('d0', 'rejected'), r('d1', 'needs_revision'), r('d2', 'accepted'), r('g0', 'accepted'), r('g1', 'accepted'), r('g2', 'accepted'), r('g3', 'insufficient_evidence')]);
    // pos scores [3,2,0] vs neg [0,0,0,1]: (4+4+0.5*3+0)/12 … pairs: 3>all 4, 2>all 4, 0 vs (0,0,0 ties, 1 loses) = 1.5 → 9.5/12
    expect(s.all.auc).toBeCloseTo(9.5 / 12, 10);
    expect(s.all.items).toEqual({ total: 8, positives: 4, negatives: 4, scored_positives: 3, scored_negatives: 4, unscored: 1 });
    expect(s.all.llm.caught.k).toBe(2);
    expect(s.all.llm.false_reject.k).toBe(1);
    expect(s.all.llm.defective_accepted.k).toBe(1);
    expect(s.all.per_kind).toEqual({ A: { items: 2, scored: 2, caught: 2, accepted: 0 }, B: { items: 2, scored: 1, caught: 0, accepted: 1 } });
    expect(s.unscored_ids).toEqual(['d3']);
    expect(() => scoreF1(items, [r('d0', 'maybe')])).toThrow('F1_BAD_VERDICT');
  });
});

describe('the shared runner\'s benchmark options (sec-f1-run.mjs)', () => {
  let dir: string; let db: Database.Database; let loops: LoopService;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f1-harness-')); db = new Database(':memory:'); db.exec(schema); runMigrations(db); loops = new LoopService(db, path.join(dir, 'evidence')); });
  afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('--benchmark records a changed prompt hash instead of aborting; the protocol run still aborts', async () => {
    const { checkerInstructionsHash } = await runner();
    expect(checkerInstructionsHash(CHECKER_INSTRUCTIONS)).toEqual({ sha256: 'dd10149499c04656458c50fda4324d0181b5bcfe10da5a816273f50489aab4ac', registered: true });
    const changed = { ...CHECKER_INSTRUCTIONS, checker: `${CHECKER_INSTRUCTIONS.checker} ` };
    expect(() => checkerInstructionsHash(changed)).toThrow('SEC_F1_PROMPT_HASH_MISMATCH');
    expect(checkerInstructionsHash(changed, { benchmark: true })).toEqual({ sha256: sha(JSON.stringify(changed)), registered: false });
  });

  it('the token cap: a protocol run only lowers 6 M, a benchmark run takes the configured cap', async () => {
    const { runCap } = await runner();
    expect(runCap(undefined)).toBe(6_000_000);
    expect(runCap('2000000')).toBe(2_000_000);
    expect(() => runCap('7000000')).toThrow('--cap must be in');
    expect(runCap('7000000', { benchmark: true })).toBe(7_000_000);
    expect(() => runCap('0', { benchmark: true })).toThrow('positive integer');
    expect(() => runCap('1.5', { benchmark: true })).toThrow('positive integer');
  });

  it('--role checker builds the prod Checker prompt (checker instructions, no security block) for the same blind item', async () => {
    const { buildPrompt } = await runner();
    const co = path.join(dir, 'co'); fs.mkdirSync(co);
    const g = (...a: string[]) => execFileSync('git', ['-C', co, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
    g('init', '-q'); fs.writeFileSync(path.join(co, 'a.test.ts'), 'it(1)\n'); g('add', '.'); g('commit', '-qm', 'base');
    fs.writeFileSync(path.join(co, 'a.test.ts'), 'it(2)\n');
    const item = { id: 'f1aaaaaaaa', repo: 'djimit/djimitflo', base_sha: '0'.repeat(40), files: ['a.test.ts'], patch_sha256: '', finding_sha256: '',
      finding: { id: 'f1r-00000000', type: 'test_gap', severity: 'info', file: 'a.test.ts', message: 'Add unit tests for services/a.ts', evidence: 'Loop PR diff, 1 file', suggested_fix: 'Keep it.' } };
    const { prompt } = buildPrompt(loops, item, co, 'checker');
    expect(prompt).toContain('# doc-drift-and-small-fix-loop Checker Assignment');
    expect(prompt).toContain(CHECKER_INSTRUCTIONS.checker);
    expect(prompt).not.toContain(CHECKER_INSTRUCTIONS.security);
    expect(prompt).toContain('-it(1)\n+it(2)');
    expect(() => buildPrompt(loops, item, co, 'maker')).toThrow('SEC_F1_BAD_ROLE');
  });
});
