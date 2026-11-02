import { afterEach, beforeEach, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { experimentDefs } from '../services/experiment-registry';
import { EVOLUTION_FLAGS } from '../services/evolution-evidence';
import { provenanceDag } from '../services/provenance-dag';
import { aceArm } from '../services/ace-001';
import { steArm } from '../services/ste-001';
import { makerDepsArm } from '../services/maker-deps-001';
import { siblingArm } from '../services/effort-controller';
import { checkerFamilyArm } from '../services/checker-family';

/**
 * STR-001-PROD (docs/research/str-001-prod/PROTOCOL.md): the frozen pre-registration of the strengthen retry as a production
 * procedure. Nothing here runs a retry. It pins the protocol body, the frozen instruction text (byte-equal to the MFR-001
 * CONTROL / STR-001 Stage A strengthen arm), the frozen assignment (a reference implementation of §3 that the runner must
 * reproduce), its independence from the real assignment functions of the other experiments, its stability along a real
 * requeue / refinement lineage, and that nothing is activated before the start PR.
 */
const STR_PROD_PREREG_SHA256 = '8d31b31284a088b2d978591cbe2d207ff340cfbb29b366d0654a9fcae2a350c0';
const STR_TEXT_SHA256 = '1a7cc5b85ae01a9f0d92ef434e9917406cd46984e4ed7e5126ed2491e2c8710f';
const STR_RENDERED_SHA256 = '2747d68433ce41602af0b0ab7193f3680c9b227b4aa00bcbaac7c028d5b8a0aa';
const STR_TEXT = 'Retry of a test-writing task: the vitest test file {test} already exists and covers {target}, but it is too weak: a subtly broken {target} can still pass it. Edit {test} so that it still passes against the real {target} and fails when {target} is subtly broken. Keep importing {target} with a relative import, do not mock it, skip nothing, and make it pass with: cd packages/server && npx vitest run {test_rel}. Change only {test}; do not edit {target} or any other file. Strengthen the assertions of this test.';
const render = (test: string, target: string) => STR_TEXT.replaceAll('{test_rel}', test.replace(/^packages\/server\//, ''))
  .replaceAll('{test}', test).replaceAll('{target}', target);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const ROOT = join(__dirname, '../../../..');
const PROTOCOL = join(ROOT, 'docs/research/str-001-prod/PROTOCOL.md');
const body = () => readFileSync(PROTOCOL, 'utf8').split('\n---\nPREREG_SHA256: ')[0];

/** §3, frozen: bucket = uint32_be(first 4 bytes of sha256(salt + root key)) mod 100 */
const bucket = (salt: string, key: string) => createHash('sha256').update(salt + key).digest().readUInt32BE(0) % 100;
const strArm = (key: string) => (bucket('str-prod-001:', key) < 50 ? 'retry' : 'none');
const strHoldout = (key: string) => bucket('str-prod-001/holdout:', key) < 10;

/** §2, frozen: the root key = the earliest-created parentless ancestor (ties: smaller id) over requeue_of / refinement_of edges */
function rootKey(pid: string, edges: Array<{ edge_type: string; source: { id: string }; target: { id: string } }>, createdAt: Map<string, string>): string {
  const parents = new Map<string, string[]>();
  for (const e of edges) if (e.edge_type === 'requeue_of' || e.edge_type === 'refinement_of') parents.set(e.target.id, [...(parents.get(e.target.id) ?? []), e.source.id]);
  const roots: string[] = []; const seen = new Set<string>(); const stack = [pid];
  while (stack.length) {
    const id = stack.pop()!; if (seen.has(id)) continue; seen.add(id);
    const ps = parents.get(id) ?? []; if (!ps.length) roots.push(id); stack.push(...ps);
  }
  return roots.sort((a, b) => (createdAt.get(a) ?? '').localeCompare(createdAt.get(b) ?? '') || a.localeCompare(b))[0];
}

/** Pearson chi-square of a contingency table given as counts[row][col] */
function chiSquare(counts: number[][]): number {
  const n = counts.flat().reduce((a, b) => a + b, 0);
  const rows = counts.map((r) => r.reduce((a, b) => a + b, 0)); const cols = counts[0].map((_, j) => counts.reduce((a, r) => a + r[j], 0));
  let x = 0;
  for (let i = 0; i < counts.length; i++) for (let j = 0; j < cols.length; j++) { const e = rows[i] * cols[j] / n; x += (counts[i][j] - e) ** 2 / e; }
  return x;
}
const table = <T extends string | number>(ids: string[], other: (id: string) => T): number[][] => {
  const levels = [...new Set(ids.map(other))].sort();
  return ['retry', 'none'].map((a) => levels.map((l) => ids.filter((id) => strArm(id) === a && other(id) === l).length));
};
/** chi-square critical values at p = 0.001 */
const CRIT = { 1: 10.828, 3: 16.266 } as const;

it('the STR-001-PROD protocol fingerprint matches its body', () => {
  const doc = readFileSync(PROTOCOL, 'utf8');
  const [b, tail] = doc.split('\n---\nPREREG_SHA256: ');
  expect(sha(b)).toBe(tail.slice(0, 64));
  expect(tail.slice(0, 64)).toBe(STR_PROD_PREREG_SHA256);
  // the registered design numbers, salts, merge-independent primary and the absence of an extension
  expect(b).toContain('**Registered target: n = 86 scored roots per arm (172).**');
  expect(b).toContain("sha256('str-prod-001:' + key)");
  expect(b).toContain("sha256('str-prod-001/holdout:' + key)");
  expect(b).toContain('### Primary: fresh-mutant kill share at verification (merge-independent, all triggered roots)');
  expect(b).toContain('**Worst-case (Manski) bound.**');
  expect(b).toContain('**A single readout and no extension.**');
  // r3: period weights by eligible triggered roots, nothing dropped; lifetime holdout budget with epoch-relative looks
  expect(b).toContain('**Analysis by period. No period and no eligible triggered root is ever dropped.**');
  expect(b).toContain('w_p = eligible triggered roots in p ÷ all eligible triggered roots');
  expect(b).toContain('**At most 2 epochs.**');
  expect(b).toContain('E_k + 28 d, E_k + 56 d, E_k + 84 d and E_k + 112 d');
  expect(b).toContain('α_H / 24 = 0.025 / 24');
});

it('the protocol carries the frozen strengthen text verbatim, and its hash', () => {
  const b = body();
  expect(b).toContain(`\`${STR_TEXT}\``);
  expect(sha(STR_TEXT)).toBe(STR_TEXT_SHA256);
  expect(b).toContain(STR_TEXT_SHA256);
  expect(b).toContain(STR_RENDERED_SHA256);
});

it('the frozen text renders byte-equal to the MFR-001 CONTROL prompt (STR-001 Stage A strengthen arm)', async () => {
  const lib = await import(resolve(ROOT, 'scripts/mfr-001/lib.mjs'));
  expect(sha(readFileSync(resolve(ROOT, 'scripts/mfr-001/lib.mjs'), 'utf8'))).toBe('16334c1b1521fc210f971cf8624e863578a2cd4adf98f919dab698d63be70fcd');
  const test = 'packages/server/src/__tests__/usage-telemetry.exports.test.ts'; const target = 'packages/server/src/services/usage-telemetry.ts';
  const ref = lib.buildPrompt({ test, target, arm: 'control' });
  expect(render(test, target)).toBe(ref);
  expect(sha(ref)).toBe(STR_RENDERED_SHA256);
  const other = { test: 'packages/server/src/__tests__/a/b.test.ts', target: 'packages/server/src/services/a/b.ts' };
  expect(render(other.test, other.target)).toBe(lib.buildPrompt({ ...other, arm: 'control' }));
  // the feedback arm (falsified, MFR-001) is never the treatment
  expect(lib.buildPrompt({ test, target, arm: 'feedback', survivors: [{ key: 'k', line: 1, before: 'a', after: 'b' }] })).not.toBe(ref);
});

it('the frozen assignment reproduces the golden buckets in the protocol, and its shares', () => {
  const golden: Array<[string, number, number]> = [['root-0', 49, 18], ['root-1', 55, 4], ['root-2', 73, 88], ['root-3', 58, 37], ['root-4', 25, 68], ['root-5', 52, 12]];
  const b = body();
  for (const [key, bk, hb] of golden) {
    expect([bucket('str-prod-001:', key), bucket('str-prod-001/holdout:', key)]).toEqual([bk, hb]);
    expect(b).toContain(`| \`${key}\` | ${bk} | ${hb} |`);
  }
  const ids = Array.from({ length: 4000 }, (_, i) => `goal-${i}`);
  const retry = ids.filter((id) => strArm(id) === 'retry').length / ids.length;
  const hold = ids.filter(strHoldout).length / ids.length;
  expect(Math.abs(retry - 0.5)).toBeLessThan(0.03);
  expect(Math.abs(hold - 0.1)).toBeLessThan(0.015);
  // the holdout draw is independent of the experiment draw
  expect(chiSquare(table(ids, (id) => (strHoldout(id) ? 'h' : 'd')))).toBeLessThan(CRIT[1]);
});

it('the STR arm is independent of the real assignment functions of ACE-001, STE-001, MAKER-DEPS-001, X1 and F2 v2', () => {
  const ids = Array.from({ length: 4000 }, (_, i) => `goal-${i}`);
  const others: Array<[string, (id: string) => string | number, 1 | 3]> = [
    ['ACE-001', (id) => aceArm(id).code, 3], ['STE-001', steArm, 1], ['MAKER-DEPS-001', makerDepsArm, 1],
    ['X1', siblingArm, 1], ['F2 v2', (id) => checkerFamilyArm(id, 'v2'), 1],
  ];
  for (const [name, fn, df] of others) {
    const t = table(ids, fn);
    expect(t[0].length - 1, name).toBe(df);
    expect(chiSquare(t), name).toBeLessThan(CRIT[df]);
    // every cell is populated near its expected share (no salt collision makes a cell empty or doubled)
    const n = ids.length / (2 * (df + 1));
    for (const c of t.flat()) expect(Math.abs(c - n) / n, name).toBeLessThan(0.15);
  }
  // a salt collision would show up as a perfect association: the same function with the STR salt is fully dependent
  expect(chiSquare(table(ids, strArm))).toBeGreaterThan(1000);
});

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF'); });
afterEach(() => db.close());
const proposal = (id: string, at: string, opts: { refs?: string[]; refinedFrom?: string } = {}) =>
  db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, evidence_refs_json, approved_by, refined_from_id, created_at, updated_at)
    VALUES (?, 'feature', 't', 'd', 'r', 'gap_analysis', 'proposed', ?, NULL, ?, ?, ?)`).run(id, JSON.stringify(opts.refs ?? []), opts.refinedFrom ?? null, at, at);

it('the STR arm is stable along a real requeue / refinement lineage (root key), where a goal-id key is not', () => {
  // 30 lineages, each: root → requeue → refinement (refined_from_id) → requeue → refinement (ref); plus one unrelated proposal
  const lineages: string[][] = [];
  for (let l = 0; l < 30; l++) {
    const p = (k: number) => `L${l}-p${k}`;
    const at = (k: number) => new Date(Date.parse('2026-10-01T00:00:00.000Z') + (l * 10 + k) * 3_600_000).toISOString();
    proposal(p(0), at(0));
    proposal(p(1), at(1), { refs: [`requeue-of:${p(0)}`] });
    proposal(p(2), at(2), { refinedFrom: p(1) });
    proposal(p(3), at(3), { refs: [`requeue-of:${p(2)}`, 'requeue-by:autonomy:requeue'] });
    proposal(p(4), at(4), { refs: [`refinement-of:${p(3)}`] });
    lineages.push([0, 1, 2, 3, 4].map(p));
  }
  proposal('lonely', '2026-10-20T00:00:00.000Z');
  const dag = provenanceDag(db, Date.parse('2026-10-29T00:00:00.000Z'), { edgeLimit: 10_000 });
  expect(dag.edges_truncated).toBe(false);
  const createdAt = new Map((db.prepare('SELECT id, created_at FROM self_improvements').all() as Array<{ id: string; created_at: string }>).map((r) => [r.id, r.created_at]));
  let goalKeyedSplits = 0;
  for (const members of lineages) {
    const keys = members.map((m) => rootKey(m, dag.edges, createdAt));
    expect(new Set(keys)).toEqual(new Set([members[0]]));
    expect(new Set(keys.map(strArm)).size).toBe(1);
    expect(new Set(keys.map(strHoldout)).size).toBe(1);
    // each requeue / refinement creates a new goal: keyed on the goal id, the lineage would be re-randomised
    if (new Set(members.map((m) => strArm(`g-${m}`))).size > 1) goalKeyedSplits++;
  }
  expect(goalKeyedSplits).toBeGreaterThan(10);
  expect(rootKey('lonely', dag.edges, createdAt)).toBe('lonely');
});

it('pre-registration only: no registry entry and no flag exist before the start PR', () => {
  expect(experimentDefs().map((d) => d.id)).not.toContain('STR-001-PROD');
  expect(EVOLUTION_FLAGS.map((f) => f.name)).not.toContain('STR_PROD_001_MODE');
});
