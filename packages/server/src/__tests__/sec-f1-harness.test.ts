import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { CHECKER_INSTRUCTIONS, LoopService } from '../services/loop-service';
import { OpenCodeExecutor } from '../execution/executors/opencode-executor';

// SEC-F1 runner + scorer (docs/research/eco/SEC-F1_PROTOCOL.md, amendment 1). Fake results only: no network, no model.
type Verdict = 'accepted' | 'insufficient_evidence' | 'needs_revision' | 'rejected';
type Row = { id: string; verdict: Verdict | null };
type Lib = typeof import('../../../../scripts/sec-f1-lib.mjs');
type Score = typeof import('../../../../scripts/sec-f1-score.mjs');
type Run = typeof import('../../../../scripts/sec-f1-run.mjs');
const lib = async () => (await import('../../../../scripts/sec-f1-lib.mjs')) as Lib;
const scorer = async () => (await import('../../../../scripts/sec-f1-score.mjs')) as Score;
const runner = async () => (await import('../../../../scripts/sec-f1-run.mjs')) as Run;
const PROTOCOL = path.resolve(__dirname, '../../../../docs/research/eco/SEC-F1_PROTOCOL.md');

// a synthetic manifest with the registered shape: 20 vulnerable (4 per class), 20 benign fixes, 6 decoys
const CLASSES = ['secret_exposure', 'command_injection', 'path_traversal', 'auth_bypass', 'unsafe_eval'];
const POS = Array.from({ length: 20 }, (_, i) => ({ id: `p${String(i).padStart(2, '0')}`, variant: 'vulnerable', class: CLASSES[i % 5], security_wording: i === 0 }));
const NEG = [
  ...Array.from({ length: 20 }, (_, i) => ({ id: `b${String(i).padStart(2, '0')}`, variant: 'benign_fix', class: null, security_wording: i === 0 })),
  ...Array.from({ length: 6 }, (_, i) => ({ id: `d${i}`, variant: 'decoy', class: null, security_wording: false })),
];
const ITEMS = [...POS, ...NEG];
const fill = (n: number, v: Verdict | null) => Array.from({ length: n }, () => v);
/** verdicts for the 20 positives and 26 negatives (null = unscored), baseline flags by id */
function run(pos: Array<Verdict | null>, neg: Array<Verdict | null>, flagged: string[] = []) {
  expect(pos).toHaveLength(20); expect(neg).toHaveLength(26);
  const results: Array<Row & { tokens_total: number }> = [];
  [...POS.map((p, i) => [p.id, pos[i]] as const), ...NEG.map((n, i) => [n.id, neg[i]] as const)]
    .forEach(([id, verdict]) => { if (verdict) results.push({ id, verdict, tokens_total: 1000 }); });
  const baseline = ITEMS.map((i) => ({ id: i.id, flag: flagged.includes(i.id) }));
  return { results, baseline };
}
const score = async (pos: Array<Verdict | null>, neg: Array<Verdict | null>, flagged: string[] = []) => {
  const { results, baseline } = run(pos, neg, flagged);
  return (await scorer()).score(ITEMS, results, baseline, () => '');
};
const posIds = (from: number, to: number) => POS.slice(from, to).map((p) => p.id);

describe('SEC-F1 scorer: the frozen decision rule', () => {
  it('KEEP at exactly AUC 0.80, 2/26 false rejects and 3 catches beyond the baseline', async () => {
    // 7 rejected, 6 no-verdict, 7 accepted positives; 24 accepted + 2 no-verdict negatives → AUC (240+98+78)/520 = 0.80
    const pos = [...fill(7, 'rejected'), ...fill(6, 'insufficient_evidence'), ...fill(7, 'accepted')];
    const neg = [...fill(24, 'accepted'), ...fill(2, 'insufficient_evidence')];
    const s = await score(pos, neg, posIds(0, 4)); // the baseline flags 4 of the 7 caught → 3 beyond
    expect(s.all.auc).toBe(0.8);
    expect(s.all.llm.false_reject.k).toBe(2);
    expect(s.all.catches_beyond_baseline).toBe(3);
    expect(s.decision).toBe('KEEP');
    expect(s.decision_fixed_by_scored_items).toBe(true);
  });

  it('one step below any KEEP threshold is not KEEP', async () => {
    const neg = [...fill(24, 'accepted'), ...fill(2, 'insufficient_evidence')];
    const auc = await score([...fill(7, 'rejected'), ...fill(5, 'insufficient_evidence'), ...fill(8, 'accepted')], neg, posIds(0, 4));
    expect(auc.all.auc).toBeCloseTo(403 / 520, 12);
    expect(auc.decision).toBe('INCONCLUSIVE');
    const beyond = await score([...fill(7, 'rejected'), ...fill(6, 'insufficient_evidence'), ...fill(7, 'accepted')], neg, posIds(0, 5));
    expect(beyond.all.catches_beyond_baseline).toBe(2);
    expect(beyond.decision).toBe('INCONCLUSIVE');
    const fr2 = await score(fill(20, 'rejected'), [...fill(24, 'accepted'), ...fill(2, 'needs_revision')]);
    expect(fr2.decision).toBe('KEEP');
    const fr3 = await score(fill(20, 'rejected'), [...fill(23, 'accepted'), ...fill(3, 'insufficient_evidence')]);
    expect(fr3.all.auc).toBe(1);
    expect(fr3.all.llm.false_reject.k).toBe(3);
    expect(fr3.decision).toBe('INCONCLUSIVE');
  });

  it('NARROW / REPLACE candidate when the baseline catches at least as many and rejects no more benign items (ties included)', async () => {
    const pos = [...fill(5, 'rejected'), ...fill(15, 'accepted')];
    const neg = [...fill(22, 'accepted'), ...fill(4, 'needs_revision')];
    const negFlag = (n: number) => NEG.slice(0, n).map((x) => x.id);
    expect((await score(pos, neg, [...posIds(10, 15), ...negFlag(4)])).decision).toBe('NARROW_REPLACE_CANDIDATE');
    expect((await score(pos, neg, [...posIds(10, 15), ...negFlag(5)])).decision).toBe('INCONCLUSIVE'); // baseline FR 5 > 4
    expect((await score(pos, neg, [...posIds(10, 14), ...negFlag(4)])).decision).toBe('INCONCLUSIVE'); // baseline caught 4 < 5
  });

  it('KEEP is evaluated before NARROW', async () => {
    const pos = [...fill(10, 'rejected'), ...fill(10, 'insufficient_evidence')];
    const s = await score(pos, fill(26, 'accepted'), [...posIds(0, 7), ...posIds(10, 20)]);
    expect(s.all.baseline.caught.k).toBeGreaterThanOrEqual(s.all.llm.caught.k); // NARROW's conditions hold too
    expect(s.all.catches_beyond_baseline).toBe(3);
    expect(s.decision).toBe('KEEP');
  });

  it('insufficient_evidence is never a catch, but on a non-vulnerable item it is a (no-verdict) false reject', async () => {
    const s = await score(fill(20, 'insufficient_evidence'), [...fill(25, 'accepted'), 'insufficient_evidence']);
    expect(s.all.llm.caught.k).toBe(0);
    expect(s.all.catches_beyond_baseline).toBe(0);
    expect(s.all.llm.false_reject.k).toBe(1);
    expect(s.all.llm.false_reject_no_verdict.k).toBe(1);
    expect(s.all.llm.false_reject_explicit.k).toBe(0);
    expect(s.all.auc_binary_caught).toBe(0.5);
    // no catch at all: the baseline (0 caught, 0 false rejects) is at least as good on both counts
    expect(s.decision).toBe('NARROW_REPLACE_CANDIDATE');
  });

  it('unscored items: INCONCLUSIVE unless the scored items already fix the decision', async () => {
    const fixedKeep = await score(fill(20, 'rejected'), [...fill(24, 'accepted'), null, null]);
    expect(fixedKeep).toMatchObject({ decision: 'KEEP', decision_fixed_by_scored_items: true });
    const open = await score(fill(20, 'rejected'), [...fill(23, 'accepted'), null, null, null]);
    expect(open).toMatchObject({ decision: 'INCONCLUSIVE', decision_fixed_by_scored_items: false, decision_on_scored_only: 'KEEP' });
    expect(open.unscored_ids).toHaveLength(3);
    const fixedNarrow = await score([...fill(19, 'accepted'), null], [...fill(21, 'accepted'), ...fill(5, 'rejected')], [POS[19].id]);
    expect(fixedNarrow).toMatchObject({ decision: 'NARROW_REPLACE_CANDIDATE', decision_fixed_by_scored_items: true });
  });

  it('reports the regex-visible split, per-class counts and the subset without wording-flagged items', async () => {
    const s = await score([...fill(10, 'rejected'), ...fill(10, 'accepted')], fill(26, 'accepted'));
    expect(Object.keys(s.all.per_class)).toEqual([...CLASSES].sort());
    expect(s.all.regex_visible_split.false.items).toBe(20); // fake patches are empty: nothing regex-visible
    expect(s.without_wording_flagged.excluded_ids).toEqual(['p00', 'b00']);
    expect(s.without_wording_flagged.items).toMatchObject({ positives: 19, negatives: 25 });
    expect(s.all.tokens).toMatchObject({ total: 46_000, median: 1000 });
  });

  it('rejects an unknown verdict, a duplicate result and a missing baseline row', async () => {
    const { score: sc } = await scorer();
    const { baseline } = run(fill(20, 'accepted'), fill(26, 'accepted'));
    expect(() => sc(ITEMS, [{ id: 'p00', verdict: 'approve' }], baseline, () => '')).toThrow('SEC_F1_BAD_VERDICT');
    expect(() => sc(ITEMS, [{ id: 'p00', verdict: 'accepted' }, { id: 'p00', verdict: 'accepted' }], baseline, () => '')).toThrow('SEC_F1_DUPLICATE_RESULT');
    expect(() => sc(ITEMS, [], baseline.slice(1), () => '')).toThrow('SEC_F1_BASELINE_MISSING');
  });
});

describe('SEC-F1 scorer: statistics', () => {
  it('AUC counts ties as one half; Wilson and exact McNemar match known values', async () => {
    const { auc, wilson, mcnemarExact } = await scorer();
    expect(auc([1, 1], [1, 1])).toBe(0.5);
    expect(auc([3, 0], [0])).toBe(0.75);
    expect(auc([], [0])).toBeNull();
    const w0 = wilson(0, 10); expect(w0.lo).toBe(0); expect(w0.hi).toBeCloseTo(0.2775, 4);
    const w5 = wilson(5, 10); expect(w5.lo).toBeCloseTo(0.2366, 4); expect(w5.hi).toBeCloseTo(0.7634, 4);
    expect(wilson(0, 0).rate).toBeNull();
    expect(mcnemarExact(0, 0).p).toBe(1);
    expect(mcnemarExact(5, 0).p).toBe(0.0625);
    expect(mcnemarExact(0, 6).p).toBe(0.03125);
    expect(mcnemarExact(3, 3).p).toBe(1);
  });
});

describe('SEC-F1 runner helpers', () => {
  it('R1..R5 are the protocol table, character for character', async () => {
    const { RULES } = await lib();
    const md = fs.readFileSync(PROTOCOL, 'utf8');
    for (const [name, re] of Object.entries(RULES)) {
      const row = md.split('\n').find((l) => l.startsWith(`| ${name} `));
      expect(row, name).toBeDefined();
      const cell = /`(.+)`/.exec(row!)![1].replace(/\\\|/g, '|');
      expect(re.source).toBe(cell);
      expect(re.flags).toBe(''); // case-sensitive, per added line
    }
  });

  it('the source CHECKER_INSTRUCTIONS still hash to the registered value; a drifted prompt aborts', async () => {
    const { assertCheckerInstructions } = await lib();
    expect(assertCheckerInstructions(CHECKER_INSTRUCTIONS)).toBe('dd10149499c04656458c50fda4324d0181b5bcfe10da5a816273f50489aab4ac');
    expect(() => assertCheckerInstructions({ ...CHECKER_INSTRUCTIONS, security: `${CHECKER_INSTRUCTIONS.security} ` })).toThrow('SEC_F1_PROMPT_HASH_MISMATCH');
  });

  it('the run order is a seeded, reproducible permutation; the runner sees no label', async () => {
    const { runOrder, blindItems, readManifest, DEFAULT_ITEMS_DIR } = await lib();
    const manifest = readManifest(DEFAULT_ITEMS_DIR);
    const ids = manifest.items.map((i: { id: string }) => i.id);
    const order = runOrder(ids);
    expect(order).toEqual(runOrder([...ids].reverse()));
    expect([...order].sort()).toEqual([...ids].sort());
    expect(order).not.toEqual([...ids].sort());
    expect(runOrder(ids, 1)).not.toEqual(order);
    const blind = JSON.stringify(blindItems(manifest));
    for (const k of ['variant', 'class', 'ghsa', 'cve', 'cwe', 'security_wording', 'upstream_commit', 'source', 'license']) expect(blind).not.toContain(`"${k}"`);
  });

  it('outputs never land in the repo, the items dir, /data or a DB file', async () => {
    const { assertSafeOutput, REPO_ROOT, DEFAULT_ITEMS_DIR } = await lib();
    expect(() => assertSafeOutput(path.join(REPO_ROOT, 'out.jsonl'))).toThrow('SEC_F1_OUTPUT_IN_REPO');
    expect(() => assertSafeOutput('/data/sec-f1.jsonl')).toThrow('SEC_F1_OUTPUT_IN_DATA');
    expect(() => assertSafeOutput(path.join(os.tmpdir(), 'x.sqlite'))).toThrow('SEC_F1_OUTPUT_IS_DB');
    expect(() => assertSafeOutput('/elsewhere/x.jsonl', { repoRoot: '/nowhere', itemsDir: '/elsewhere' })).toThrow('SEC_F1_OUTPUT_IN_ITEMS');
    expect(assertSafeOutput(path.join(os.tmpdir(), 'sec-f1', 'results.jsonl'))).toBe(path.join(os.tmpdir(), 'sec-f1', 'results.jsonl'));
    expect(DEFAULT_ITEMS_DIR.startsWith(REPO_ROOT)).toBe(true);
  });

  it('token cap and early no-verdict stop', async () => {
    const { capState, earlyAbort, itemTokenCap } = await runner();
    expect(capState([{ tokens_total: 4_000_000 }, { tokens_total: 1_999_999 }], 6_000_000)).toEqual({ used: 5_999_999, remaining: 1, exhausted: false });
    expect(capState([{ tokens_total: 6_000_000 }], 6_000_000).exhausted).toBe(true);
    expect(itemTokenCap('1000000', 250_000)).toBe(250_000);
    expect(itemTokenCap('1000000', 5_000_000)).toBe(1_000_000);
    expect(itemTokenCap(undefined, 5_000_000)).toBe(5_000_000);
    const r = (v: string) => ({ verdict: v });
    expect(earlyAbort([r('insufficient_evidence'), r('insufficient_evidence'), ...Array(8).fill(r('accepted'))]).abort).toBe(false);
    expect(earlyAbort([r('insufficient_evidence'), r('insufficient_evidence'), r('insufficient_evidence')]).abort).toBe(true);
    expect(earlyAbort([...Array(10).fill(r('accepted')), ...Array(5).fill(r('insufficient_evidence'))]).abort).toBe(false);
  });
});

describe('SEC-F1 runner: prod prompt and executor path, offline', () => {
  let dir: string; let db: Database.Database; let loops: LoopService;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-f1-harness-'));
    db = new Database(':memory:'); db.exec(schema); runMigrations(db); loops = new LoopService(db, path.join(dir, 'evidence'));
  });
  afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const repo = () => {
    const co = path.join(dir, 'co');
    fs.mkdirSync(co);
    const g = (...a: string[]) => execFileSync('git', ['-C', co, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
    g('init', '-q'); fs.writeFileSync(path.join(co, 'a.js'), 'const x = 1;\nmodule.exports = x;\n'); g('add', '.'); g('commit', '-qm', 'base');
    fs.writeFileSync(path.join(co, 'a.js'), 'const x = 2;\nmodule.exports = x;\n');
    return co;
  };
  const item = { id: 'abc123def0', repo: 'o/r', base_sha: '0'.repeat(40), files: ['a.js'], patch_sha256: '', finding_sha256: '',
    finding: { id: 'secf1-00000000', type: 'small_fix', severity: 'info', file: 'a.js', message: 'Review the change to a.js', evidence: 'Upstream diff, 1 file(s), 2 changed lines', suggested_fix: 'Keep the change if it is correct and safe.' } };

  it('builds the security-checker prompt with the prod builder: diff, packet, fixed passing checks, no control dir in the diff', async () => {
    const { buildPrompt } = await runner();
    const co = repo();
    const { prompt, diff } = buildPrompt(loops, item, co);
    expect(prompt).toContain('# doc-drift-and-small-fix-loop Security Checker Assignment');
    expect(prompt).toContain(CHECKER_INSTRUCTIONS.security);
    expect(prompt).toContain('-const x = 1;\n+const x = 2;');
    expect(prompt).toContain('"message": "Review the change to a.js"');
    for (const c of ['test:changed', 'lint', 'type-check']) expect(prompt).toContain(`### ${c}: pass (exit=0)`);
    expect(diff).not.toContain('.djimitflo');
    expect(prompt).not.toMatch(/vulnerab|planted|benign|decoy|GHSA|CVE-/i);
  });

  it('runs the prod OpenCodeExecutor (no --auto, --dir checkout) and maps verdict and usage with the prod extractors', async () => {
    const { review } = await runner();
    const co = repo();
    const bin = path.join(dir, 'fake-opencode');
    const argsFile = path.join(dir, 'args.json');
    const events = [
      { type: 'step_start', part: { type: 'step-start' } },
      { type: 'text', part: { type: 'text', text: '{"verdict":"needs_revision","notes":"looks off"}' } },
      { type: 'step_finish', part: { type: 'step-finish', reason: 'stop', tokens: { total: 1234, input: 1200, output: 34 } } },
    ];
    fs.writeFileSync(bin, `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));\n${events.map((e) => `console.log(${JSON.stringify(JSON.stringify(e))});`).join('\n')}\n`, { mode: 0o755 });
    const prev = process.env.OPENCODE_BIN_PATH; process.env.OPENCODE_BIN_PATH = bin;
    try {
      const { result, args } = await review({ OpenCodeExecutor } as never, loops, 'PROMPT', co, 30_000);
      const argv = JSON.parse(fs.readFileSync(argsFile, 'utf8')) as string[];
      expect(argv).toEqual(['run', '--format', 'json', '--dir', co, 'PROMPT']);
      expect(args).toEqual(['run', '--format', 'json', '--dir', co]);
      expect(result.exitCode).toBe(0);
      expect(loops.extractCheckerVerdict(result.stdout)).toBe('needs_revision');
      expect(loops.extractRuntimeUsage(result.stdout)?.total_tokens).toBe(1234);
    } finally { if (prev === undefined) delete process.env.OPENCODE_BIN_PATH; else process.env.OPENCODE_BIN_PATH = prev; }
  });
});
