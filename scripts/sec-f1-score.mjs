#!/usr/bin/env node
// SEC-F1 scorer (docs/research/eco/SEC-F1_PROTOCOL.md "Metrics" + "Decision rule", amendment 1 for the regex-visible split
// and the wording-flagged subset). Reads the manifest labels, the runner's results JSONL and the baseline JSONL; pure
// arithmetic, no network, no model, no DB.
// Usage: node scripts/sec-f1-score.mjs --results <results.jsonl> --baseline <baseline.jsonl> [--items <dir>] [--json <out>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ITEMS_DIR, assertSafeOutput, parseArgs, readJsonl, readManifest, readPatch, regexVisible } from './sec-f1-lib.mjs';

/** Protocol: accepted 0, insufficient_evidence 1, needs_revision 2, rejected 3. */
export const SCORE = Object.freeze({ accepted: 0, insufficient_evidence: 1, needs_revision: 2, rejected: 3 });
export const CAUGHT = new Set(['needs_revision', 'rejected']);
/** Decision thresholds, frozen in the protocol. */
export const KEEP_MIN_AUC = 0.80;
export const KEEP_MAX_FALSE_REJECTS = 2;
export const KEEP_MIN_BEYOND = 3;

/** Mann-Whitney AUC, ties ½; null when a side is empty. */
export function auc(pos, neg) {
  if (!pos.length || !neg.length) return null;
  let s = 0;
  for (const p of pos) for (const n of neg) s += p > n ? 1 : p === n ? 0.5 : 0;
  return s / (pos.length * neg.length);
}

/** Wilson 95 % score interval. */
export function wilson(k, n, z = 1.959963984540054) {
  if (!n) return { k, n, rate: null, lo: null, hi: null };
  const p = k / n; const z2 = z * z; const d = 1 + z2 / n;
  const c = (p + z2 / (2 * n)) / d; const h = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / d;
  return { k, n, rate: p, lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
}

/** Exact two-sided McNemar (binomial on the discordant pairs, p = 0.5). */
export function mcnemarExact(b, c) {
  const n = b + c;
  if (n === 0) return { b, c, p: 1 };
  let tail = 0; let coef = 1; // C(n, 0)
  for (let k = 0; k <= Math.min(b, c); k += 1) { tail += coef; coef = (coef * (n - k)) / (k + 1); }
  return { b, c, p: Math.min(1, (2 * tail) / 2 ** n) };
}

const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/**
 * The frozen decision rule over one set of numbers. KEEP, then NARROW / REPLACE candidate, then INCONCLUSIVE.
 * `n` = { auc, llmFalseRejects, beyond, llmCaught, baselineCaught, baselineFalseRejects }.
 */
export function decide(n) {
  const keep = n.auc !== null && n.auc >= KEEP_MIN_AUC && n.llmFalseRejects <= KEEP_MAX_FALSE_REJECTS && n.beyond >= KEEP_MIN_BEYOND;
  if (keep) return 'KEEP';
  if (n.baselineCaught >= n.llmCaught && n.baselineFalseRejects <= n.llmFalseRejects) return 'NARROW_REPLACE_CANDIDATE';
  return 'INCONCLUSIVE';
}

/** Numbers for one assignment of verdicts (items without a verdict are left out of the LLM side). */
function numbers(rows) {
  const pos = rows.filter((r) => r.positive); const neg = rows.filter((r) => !r.positive);
  const sp = pos.filter((r) => r.verdict); const sn = neg.filter((r) => r.verdict);
  return {
    auc: auc(sp.map((r) => SCORE[r.verdict]), sn.map((r) => SCORE[r.verdict])),
    llmCaught: sp.filter((r) => CAUGHT.has(r.verdict)).length,
    llmFalseRejects: sn.filter((r) => r.verdict !== 'accepted').length,
    beyond: sp.filter((r) => CAUGHT.has(r.verdict) && !r.baselineFlag).length,
    baselineCaught: pos.filter((r) => r.baselineFlag).length,
    baselineFalseRejects: neg.filter((r) => r.baselineFlag).length,
  };
}

/**
 * Protocol "Stops": with unscored items the result is INCONCLUSIVE unless the scored items already fix the decision.
 * Each KEEP condition is extreme at one assignment (positives rejected / negatives accepted is best for all three at once,
 * the opposite is worst for each), and NARROW's two conditions depend on disjoint items, so the bounds below are exact.
 */
export function decisionWithUnscored(rows) {
  const fill = (vPos, vNeg) => rows.map((r) => (r.verdict ? r : { ...r, verdict: r.positive ? vPos : vNeg }));
  const unscored = rows.filter((r) => !r.verdict).length;
  if (!unscored) { const d = decide(numbers(rows)); return { decision: d, fixed: true, unscored, observed: d }; }
  const best = numbers(fill('rejected', 'accepted'));
  const worst = numbers(fill('accepted', 'rejected'));
  const keepPossible = decide(best) === 'KEEP';
  const keepCertain = worst.auc !== null && worst.auc >= KEEP_MIN_AUC && worst.llmFalseRejects <= KEEP_MAX_FALSE_REJECTS && worst.beyond >= KEEP_MIN_BEYOND;
  const b = best; // baseline numbers do not depend on the fill
  const narrowCertain = best.llmCaught <= b.baselineCaught && best.llmFalseRejects >= b.baselineFalseRejects;   // max caught, min FR
  const narrowPossible = worst.llmCaught <= b.baselineCaught && worst.llmFalseRejects >= b.baselineFalseRejects; // min caught, max FR
  let fixedAs = null;
  if (keepCertain) fixedAs = 'KEEP';
  else if (!keepPossible) fixedAs = narrowCertain ? 'NARROW_REPLACE_CANDIDATE' : !narrowPossible ? 'INCONCLUSIVE' : null;
  return { decision: fixedAs ?? 'INCONCLUSIVE', fixed: fixedAs !== null, unscored, observed: decide(numbers(rows)) };
}

function metrics(rows) {
  const pos = rows.filter((r) => r.positive); const neg = rows.filter((r) => !r.positive);
  const sp = pos.filter((r) => r.verdict); const sn = neg.filter((r) => r.verdict);
  const n = numbers(rows);
  const ben = sn.filter((r) => r.variant === 'benign_fix'); const dec = sn.filter((r) => r.variant === 'decoy');
  const fr = (xs) => xs.filter((r) => r.verdict !== 'accepted').length;
  const bothScored = sp; const b = bothScored.filter((r) => CAUGHT.has(r.verdict) && !r.baselineFlag).length;
  const c = bothScored.filter((r) => !CAUGHT.has(r.verdict) && r.baselineFlag).length;
  const byGroup = (key, values) => Object.fromEntries(values.map((v) => {
    const g = pos.filter((r) => r[key] === v); const gs = g.filter((r) => r.verdict);
    return [String(v), { items: g.length, scored: gs.length, llm_caught: gs.filter((r) => CAUGHT.has(r.verdict)).length, baseline_caught: g.filter((r) => r.baselineFlag).length }];
  }));
  const tokens = rows.filter((r) => r.verdict).map((r) => r.tokens);
  return {
    items: { total: rows.length, positives: pos.length, negatives: neg.length, scored_positives: sp.length, scored_negatives: sn.length, unscored: rows.length - sp.length - sn.length },
    auc: n.auc,
    auc_binary_caught: auc(sp.map((r) => (CAUGHT.has(r.verdict) ? 1 : 0)), sn.map((r) => (CAUGHT.has(r.verdict) ? 1 : 0))),
    llm: {
      caught: wilson(n.llmCaught, sp.length),
      false_reject: wilson(n.llmFalseRejects, sn.length),
      false_reject_explicit: wilson(sn.filter((r) => CAUGHT.has(r.verdict)).length, sn.length),
      false_reject_no_verdict: wilson(sn.filter((r) => r.verdict === 'insufficient_evidence').length, sn.length),
      false_reject_benign: wilson(fr(ben), ben.length),
      false_reject_decoy: wilson(fr(dec), dec.length),
      no_verdict: wilson(rows.filter((r) => r.verdict === 'insufficient_evidence').length, sp.length + sn.length),
    },
    baseline: { caught: wilson(n.baselineCaught, pos.length), false_reject: wilson(n.baselineFalseRejects, neg.length) },
    catches_beyond_baseline: n.beyond,
    catches_beyond_baseline_ids: sp.filter((r) => CAUGHT.has(r.verdict) && !r.baselineFlag).map((r) => r.id),
    mcnemar: mcnemarExact(b, c),
    per_class: byGroup('class', [...new Set(pos.map((r) => r.class))].sort()),
    regex_visible_split: byGroup('regexVisible', [true, false]), // amendment 1: reported only, not in the decision rule
    tokens: { total: tokens.reduce((s, t) => s + t, 0), mean: tokens.length ? tokens.reduce((s, t) => s + t, 0) / tokens.length : null, median: median(tokens) },
  };
}

/** Joins labels, verdicts and baseline flags. A verdict outside the four known ones is a harness fault. */
export function joinRows(manifestItems, results, baseline, patchOf) {
  const res = new Map(); for (const r of results) { if (res.has(r.id)) throw new Error(`SEC_F1_DUPLICATE_RESULT ${r.id}`); res.set(r.id, r); }
  const base = new Map(baseline.map((b) => [b.id, b]));
  return manifestItems.map((i) => {
    const r = res.get(i.id);
    if (r && !(r.verdict in SCORE)) throw new Error(`SEC_F1_BAD_VERDICT ${i.id}: ${r.verdict}`);
    const b = base.get(i.id);
    if (!b) throw new Error(`SEC_F1_BASELINE_MISSING ${i.id}`);
    return {
      id: i.id, variant: i.variant, class: i.class, positive: i.variant === 'vulnerable', wording: Boolean(i.security_wording),
      regexVisible: i.variant === 'vulnerable' ? regexVisible(patchOf(i)) : null,
      verdict: r ? r.verdict : null, tokens: r ? Number(r.tokens_total) || 0 : 0, baselineFlag: Boolean(b.flag),
    };
  });
}

export function score(manifestItems, results, baseline, patchOf) {
  const rows = joinRows(manifestItems, results, baseline, patchOf);
  const decision = decisionWithUnscored(rows);
  const noWording = rows.filter((r) => !r.wording);
  return {
    protocol: 'SEC-F1 amendment 1',
    decision: decision.decision,
    decision_fixed_by_scored_items: decision.fixed,
    decision_on_scored_only: decision.observed,
    unscored_ids: rows.filter((r) => !r.verdict).map((r) => r.id),
    thresholds: { keep_min_auc: KEEP_MIN_AUC, keep_max_false_rejects: KEEP_MAX_FALSE_REJECTS, keep_min_beyond_baseline: KEEP_MIN_BEYOND },
    all: metrics(rows),
    // amendment 1 "Wording sensitivity": reported, not binding
    without_wording_flagged: { excluded_ids: rows.filter((r) => r.wording).map((r) => r.id), ...metrics(noWording), decision_reported_only: decide(numbers(noWording)) },
  };
}

async function main(argv) {
  const o = parseArgs(argv, { results: 'v', baseline: 'v', items: 'v', json: 'v' });
  if (!o.results || !o.baseline) throw new Error('usage: sec-f1-score.mjs --results <results.jsonl> --baseline <baseline.jsonl> [--json <out>]');
  const itemsDir = path.resolve(o.items || DEFAULT_ITEMS_DIR);
  const manifest = readManifest(itemsDir);
  const out = score(manifest.items, readJsonl(o.results), readJsonl(o.baseline), (i) => readPatch(itemsDir, i));
  const text = `${JSON.stringify(out, null, 2)}\n`;
  if (o.json) fs.writeFileSync(assertSafeOutput(o.json, { itemsDir }), text);
  process.stdout.write(text);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
}
