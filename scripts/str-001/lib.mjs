// STR-001 Stage A shared helpers (docs/research/eco/STR-001_STAGE_A_PROTOCOL.md): the fresh gym-mutant family (new seed,
// disjoint from every MFR-001 mutant), Stryker mutant identity and content, per-family kill shares, the strengthen-arm
// classes, the paired statistics (bootstrap CI, exact sign test, Holm), the size controls and the decision rule.
// Zero dependencies, pure functions only: packages/server/src/__tests__/str-001-harness.test.ts runs every rule on fake data, and the manifest
// builder, the workstation runner and the scorer import exactly these functions.
import { createHash } from 'node:crypto';

export const PROTOCOL_ID = 'STR-001-A';
export const FAMILY_A_SEED = 'str-001/a/v1';
export const ORDER_SEED = 'str-001/order/v1';
export const STATS_SEED = 20261023;
export const K_A = 12; // fresh gym mutants per target (family a)
export const MIN_A = 3; // fewer distinct fresh gym mutants than this: the item is not in family (a)
export const A_TRIES = 600; // seeds tried per target
export const N_BOOT = 10_000;
export const ALPHA = 0.05;
export const MARGIN = 0.05; // the CI bound that decides (kill-share points)
export const MIN_N = 30; // acceptance: scored items in the primary family
export const FAMILIES = Object.freeze(['stryker', 'gym']); // stryker = family (b), primary; gym = family (a)
export const EXCLUDED_MUTATIONS = Object.freeze(['StringLiteral', 'ObjectLiteral']); // stryker.config.js / stryker.service.config.mjs
export const STRYKER_VALID = Object.freeze(['Killed', 'Timeout', 'Survived', 'NoCoverage']);
export const STRYKER_DETECTED = Object.freeze(['Killed', 'Timeout']);

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** Neutral placeholders for secret-shaped test fixtures (gitleaks / Trivy are strict; see MFR-001_RESULT.md). */
const SECRET_SHAPES = [
  [/AKIA[A-Z0-9]{16}/g, 'AWS_KEY_FIXTURE_REDACTED'],
  [/xox[abposr]-[A-Za-z0-9-]{8,}/g, 'SLACK_TOKEN_FIXTURE_REDACTED'],
  [/gh[pousr]_[A-Za-z0-9]{36,}/g, 'SECRET_FIXTURE_REDACTED'],
  [/sk-[A-Za-z0-9_-]{20,}/g, 'SECRET_FIXTURE_REDACTED'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, 'SECRET_FIXTURE_REDACTED'],
];
export function redact(text) {
  if (typeof text !== 'string') return { text, n: 0 };
  let n = 0; let t = text;
  for (const [re, ph] of SECRET_SHAPES) t = t.replace(re, () => { n++; return ph; });
  return { text: t, n };
}

/** Small deterministic PRNG (mulberry32, the same generator as gym-mutants.ts rng). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export const seedOf = (s) => parseInt(sha256(s).slice(0, 8), 16);
/** Blind, seeded item order (never by score). */
export const itemOrder = (ids) => [...ids].sort((a, b) => (sha256(`${ORDER_SEED}/${a}`) < sha256(`${ORDER_SEED}/${b}`) ? -1 : 1));

/** The one line a single-operator mutant changed: { line (1-based), before, after }, or null. (= MFR-001 lib.mjs) */
export function describeMutant(original, content) {
  const a = String(original).split('\n'); const b = String(content).split('\n');
  if (a.length !== b.length) return null;
  const diff = a.map((l, i) => (l === b[i] ? -1 : i)).filter((i) => i >= 0);
  return diff.length === 1 ? { line: diff[0] + 1, before: a[diff[0]], after: b[diff[0]] } : null;
}
/** The mutant content back from its descriptor; null when the descriptor does not fit the original. (= MFR-001 lib.mjs) */
export function applyDescriptor(original, d) {
  const lines = String(original).split('\n');
  if (!d || d.line < 1 || d.line > lines.length || lines[d.line - 1] !== d.before || d.before === d.after) return null;
  lines[d.line - 1] = d.after;
  return lines.join('\n');
}

/**
 * Family (a): fresh single-mutation mutants from the gym generator (gym-mutants.ts `mutate(source, 1, rng(seed))`) under
 * a NEW seed family, sha256(`str-001/a/v1/<item id>/<j>`), j = 0 .. A_TRIES-1. Duplicates, no-ops and every content in
 * `exclude` (all MFR-001 mutants of the item: production, shown, held out) are skipped; the first K_A are kept.
 */
export function familyA({ original, itemId, mutate, rngFn = rng, exclude = [], k = K_A, tries = A_TRIES }) {
  const banned = new Set(exclude); const seen = new Set(); const out = [];
  for (let j = 0; j < tries && out.length < k; j++) {
    const content = mutate(original, 1, rngFn(seedOf(`${FAMILY_A_SEED}/${itemId}/${j}`)));
    if (!content || content === original || seen.has(content)) continue;
    seen.add(content);
    if (banned.has(content)) continue;
    const d = describeMutant(original, content);
    if (!d) continue;
    out.push({ key: `str-a:${String(itemId).slice(0, 8)}:${j}`, ...d, sha256: sha256(content), content });
  }
  return out;
}

/** Every mutant of `family` differs in content (and key) from every mutant in `mfr`; throws otherwise. */
export function assertDisjoint(family, mfr) {
  const keys = new Set(mfr.map((m) => m.key)); const contents = new Set(mfr.map((m) => m.content));
  for (const m of family) {
    if (keys.has(m.key)) throw new Error(`STR-001 disjointness: ${m.key} is an MFR-001 mutant key`);
    if (contents.has(m.content)) throw new Error(`STR-001 disjointness: ${m.key} has the content of an MFR-001 mutant`);
  }
  const own = new Set(family.map((m) => m.content));
  if (own.size !== family.length) throw new Error('STR-001 disjointness: duplicate content inside the family');
  return true;
}

/** Offset of a Stryker report position ({line, column}, both 1-based) in `src`. */
function offsetOf(src, pos) {
  const lines = String(src).split('\n');
  if (pos.line < 1 || pos.line > lines.length) return -1;
  let off = 0; for (let i = 0; i < pos.line - 1; i++) off += lines[i].length + 1;
  return off + pos.column - 1;
}
/** The original text a Stryker mutant replaces, and the mutated file content (no instrumentation). */
export function strykerSlice(original, m) {
  const s = offsetOf(original, m.location.start); const e = offsetOf(original, m.location.end);
  if (s < 0 || e < s || e > String(original).length) return null;
  return String(original).slice(s, e);
}
export function strykerContent(original, m) {
  const s = offsetOf(original, m.location.start); const e = offsetOf(original, m.location.end);
  if (s < 0 || e < s || e > String(original).length || typeof m.replacement !== 'string') return null;
  return String(original).slice(0, s) + m.replacement + String(original).slice(e);
}
/** Stable identity of a Stryker mutant across runs on the same target (ids are run-local). */
export const strykerKey = (m) => `${m.mutatorName}@${m.location.start.line}:${m.location.start.column}-${m.location.end.line}:${m.location.end.column}=>${sha256(String(m.replacement ?? '')).slice(0, 12)}`;

/** {key: {status, mutator}} for the one mutated file of a Stryker JSON report. */
export function strykerTable(report) {
  const files = Object.values(report?.files ?? {});
  if (files.length !== 1) throw new Error(`stryker report: expected one mutated file, got ${files.length}`);
  const t = {};
  for (const m of files[0].mutants) {
    const k = strykerKey(m);
    if (t[k]) throw new Error(`stryker report: duplicate mutant identity ${k}`);
    t[k] = { status: m.status, mutator: m.mutatorName, m };
  }
  return t;
}

/**
 * Family (b) mutant set of one item: the mutants of the ORIGINAL test's run with a valid status, minus every mutant
 * whose mutated content equals an MFR-001 mutant (or that cannot be rebuilt). The retried run must report the same
 * identities (same target, same config); a missing identity is a harness error.
 */
export function strykerSet(original, origTable, mfrContents) {
  const banned = new Set(mfrContents); const keep = []; const dropped = { invalid: 0, mfr_overlap: 0, unbuildable: 0 };
  for (const [k, v] of Object.entries(origTable)) {
    if (!STRYKER_VALID.includes(v.status)) { dropped.invalid++; continue; }
    const c = strykerContent(original, v.m);
    if (c === null || c === original) { dropped.unbuildable++; continue; }
    if (banned.has(c)) { dropped.mfr_overlap++; continue; }
    keep.push(k);
  }
  return { keys: keep.sort(), dropped };
}
export function strykerKill(table, keys) {
  if (!keys.length) return null;
  let det = 0;
  for (const k of keys) {
    if (!table[k]) throw new Error(`stryker: mutant ${k} missing from the run`);
    if (STRYKER_DETECTED.includes(table[k].status)) det++;
  }
  return det / keys.length;
}
/** Family (a) kill share from vitest outcomes ('pass' = survived; red or hung = killed, as graded-fitness / MFR-001). */
export const gymKill = (runs) => (runs.length ? runs.filter((r) => r !== 'pass').length / runs.length : null);

/**
 * Strengthen-arm class of one item (protocol "Units and classes"), in precedence order:
 *   no_retry   the MFR-001 control retry left no changed test (timeout / no_change / out_of_scope)  -> value 0 (ITT)
 *   baseline_red the retried test is red or hung on the real target in Stage A                     -> value 0 (ITT)
 *   ok         scored by its kill share
 */
export function strengthenClass({ hasRetried, baseline }) {
  if (!hasRetried) return 'no_retry';
  if (baseline !== 'pass') return 'baseline_red';
  return 'ok';
}

/** Lines a unified diff adds / removes (headers excluded) and the expect( calls it adds. */
export function diffSize(diff) {
  let added = 0; let removed = 0; let expects = 0;
  for (const l of String(diff ?? '').split('\n')) {
    if (l.startsWith('+++') || l.startsWith('---')) continue;
    if (l.startsWith('+')) { added++; expects += (l.match(/\bexpect\s*\(/g) ?? []).length; } else if (l.startsWith('-')) removed++;
  }
  return { added, removed, added_expects: expects };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
export const round = (x, d = 4) => (Number.isFinite(x) ? +x.toFixed(d) : null);
const roundP = (p) => (Number.isFinite(p) ? Number(p.toPrecision(6)) : null);
const quantile = (sorted, q) => { const i = (sorted.length - 1) * q; const lo = Math.floor(i); const hi = Math.ceil(i); return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo); };
export const median = (xs) => (xs.length ? quantile([...xs].sort((a, b) => a - b), 0.5) : null);

/** Percentile bootstrap 95 % CI of the mean of d (seeded). */
export function bootCI(d, { nBoot = N_BOOT, seed = STATS_SEED } = {}) {
  const n = d.length; if (!n) return [null, null];
  const r = rng(seed); const boots = [];
  for (let k = 0; k < nBoot; k++) { let s = 0; for (let i = 0; i < n; i++) s += d[Math.floor(r() * n)]; boots.push(s / n); }
  boots.sort((a, b) => a - b);
  return [round(quantile(boots, 0.025)), round(quantile(boots, 0.975))];
}
/** Exact one-sided sign test (H1: P(d > 0) > 1/2); ties are dropped. */
export function signTest(d) {
  const up = d.filter((x) => x > 0).length; const down = d.filter((x) => x < 0).length; const n = up + down;
  if (!n) return { up, down, same: d.length, p: 1 };
  let p = 0; let c = 1; // C(n, 0)
  const lp = [];
  for (let k = 0; k <= n; k++) { lp.push(c); c = (c * (n - k)) / (k + 1); }
  for (let k = up; k <= n; k++) p += lp[k];
  return { up, down, same: d.length - n, p: roundP(Math.min(1, p / 2 ** n)) };
}
/** Holm step-down adjustment; returns adjusted p in the input order. */
export function holm(ps) {
  const idx = ps.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]); const m = ps.length; const out = new Array(m); let run = 0;
  idx.forEach(([p, i], r) => { run = Math.max(run, Math.min(1, (m - r) * p)); out[i] = roundP(run); });
  return out;
}
/** Paired summary of one family: d_i = strengthen_i - original_i. */
export function pairedSummary(rows, opts = {}) {
  const d = rows.map((r) => r.strengthen - r.original);
  return {
    n: d.length, original: round(mean(rows.map((r) => r.original))), strengthen: round(mean(rows.map((r) => r.strengthen))),
    delta: round(mean(d)), ci: bootCI(d, opts), sign: signTest(d),
  };
}
/** OLS y = a + b x and a seeded pairs-bootstrap 95 % CI of a and b. */
export function ols(x, y, { nBoot = N_BOOT, seed = STATS_SEED + 7 } = {}) {
  const fit = (xs, ys) => {
    const mx = mean(xs); const my = mean(ys); let sxx = 0; let sxy = 0;
    for (let i = 0; i < xs.length; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
    const b = sxx > 0 ? sxy / sxx : NaN; return { a: my - b * mx, b };
  };
  const n = x.length; if (n < 3) return { n, a: null, b: null, ci_a: [null, null], ci_b: [null, null] };
  const f = fit(x, y); const r = rng(seed); const as = []; const bs = [];
  for (let k = 0; k < nBoot; k++) {
    const xs = []; const ys = []; for (let i = 0; i < n; i++) { const j = Math.floor(r() * n); xs.push(x[j]); ys.push(y[j]); }
    const g = fit(xs, ys); if (Number.isFinite(g.b)) { as.push(g.a); bs.push(g.b); }
  }
  as.sort((p, q) => p - q); bs.sort((p, q) => p - q);
  return { n, a: round(f.a), b: round(f.b), ci_a: [round(quantile(as, 0.025)), round(quantile(as, 0.975))], ci_b: [round(quantile(bs, 0.025)), round(quantile(bs, 0.975))] };
}

/** Pre-registered decision rule on the primary family (b, Stryker). */
export function decide({ n, pHolm, ci }) {
  const acceptance = n >= MIN_N;
  if (!n || !ci || ci[0] === null) return { verdict: 'INCONCLUSIVE', acceptance, reason: 'no scored items' };
  if (pHolm < ALPHA && ci[0] > MARGIN) {
    return acceptance ? { verdict: 'SUPPORTED', acceptance, reason: `Holm p ${pHolm} < ${ALPHA} and CI lower ${ci[0]} > ${MARGIN}` }
      : { verdict: 'INCONCLUSIVE', acceptance, reason: `would be SUPPORTED, but n ${n} < ${MIN_N} (acceptance failure)` };
  }
  if (ci[1] < MARGIN) return { verdict: 'FALSIFIED', acceptance, reason: `CI upper ${ci[1]} < ${MARGIN}` };
  return { verdict: 'INCONCLUSIVE', acceptance, reason: `neither rule holds (Holm p ${pHolm}, CI [${ci[0]}, ${ci[1]}])` };
}

/**
 * Per-item, per-family values (ITT): the original test's kill share and the strengthen arm's (0 for no_retry and
 * baseline_red). Items excluded pre-treatment (original red at base) or by family infra carry null and are left out.
 */
export function familyRows(results, family) {
  const rows = [];
  for (const r of results) {
    const f = r.families?.[family];
    if (!r.eligible || !f || f.original === null || f.original === undefined || f.excluded) continue;
    let s;
    if (r.strengthen.class !== 'ok') s = 0;
    else if (f.strengthen === null || f.strengthen === undefined) continue; // family infra on the retried run: pair dropped
    else s = f.strengthen;
    rows.push({ id: r.id, original: f.original, strengthen: s, cls: r.strengthen.class, added: r.size.added, added_expects: r.size.added_expects, n_mutants: f.n_mutants });
  }
  return rows;
}

/** Aggregate per-item results into the registered endpoints, the size controls and the verdict. */
export function summarize(results, opts = {}) {
  const fam = {};
  for (const [i, family] of FAMILIES.entries()) {
    const rows = familyRows(results, family);
    const s = pairedSummary(rows, { ...opts, seed: (opts.seed ?? STATS_SEED) + i });
    // sensitivity S1: an item whose retry left no test keeps the original test (d = 0); S2: per-protocol (ok only)
    const s1 = pairedSummary(rows.map((r) => (r.cls === 'no_retry' ? { ...r, strengthen: r.original } : r)), { ...opts, seed: (opts.seed ?? STATS_SEED) + 10 + i });
    const s2 = pairedSummary(rows.filter((r) => r.cls === 'ok'), { ...opts, seed: (opts.seed ?? STATS_SEED) + 20 + i });
    // size control: items with a retried test; subset at or below the median added lines; regression of d on added lines
    const withTest = rows.filter((r) => r.cls !== 'no_retry');
    const med = median(withTest.map((r) => r.added));
    const small = pairedSummary(withTest.filter((r) => r.added <= med), { ...opts, seed: (opts.seed ?? STATS_SEED) + 30 + i });
    const reg = ols(rows.map((r) => r.added / 100), rows.map((r) => r.strengthen - r.original), { ...opts, seed: (opts.seed ?? STATS_SEED) + 40 + i });
    const regExp = ols(rows.map((r) => r.added_expects), rows.map((r) => r.strengthen - r.original), { ...opts, seed: (opts.seed ?? STATS_SEED) + 50 + i });
    const perLine = withTest.filter((r) => r.added > 0).map((r) => (100 * (r.strengthen - r.original)) / r.added);
    const extraKills = withTest.reduce((a, r) => a + (r.strengthen - r.original) * (r.n_mutants ?? 0), 0);
    const lines = withTest.reduce((a, r) => a + r.added, 0);
    fam[family] = {
      ...s, sensitivity_no_retry_keeps_original: s1, per_protocol_ok_only: s2,
      size: {
        median_added_lines: med, small_subset: small, regression_on_added_lines_per_100: reg, regression_on_added_expects: regExp,
        median_delta_per_100_added_lines: round(median(perLine)), extra_kills_per_100_added_lines: lines ? round((100 * extraKills) / lines) : null,
      },
    };
  }
  const [pb, pa] = holm([fam.stryker.sign.p, fam.gym.sign.p]);
  fam.stryker.p_holm = pb; fam.gym.p_holm = pa;
  const classes = results.filter((r) => r.eligible).reduce((o, r) => ({ ...o, [r.strengthen.class]: (o[r.strengthen.class] ?? 0) + 1 }), {});
  return {
    n_units: results.length, n_eligible: results.filter((r) => r.eligible).length,
    excluded: results.filter((r) => !r.eligible).reduce((o, r) => ({ ...o, [r.exclusion ?? 'unknown']: (o[r.exclusion ?? 'unknown'] ?? 0) + 1 }), {}),
    strengthen_classes: classes, families: fam,
    decision: decide({ n: fam.stryker.n, pHolm: pb, ci: fam.stryker.ci }),
    fresh_attempt_comparison: { available: false, reason: 'Stage A re-scores existing outputs only; a same-budget fresh attempt (no existing test) is Stage B' },
  };
}
