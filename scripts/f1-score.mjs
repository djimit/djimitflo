#!/usr/bin/env node
// F1-R scorer: the checker's discrimination on the F1 set (docs/research/eco/f1, built by scripts/f1-build-items.mjs).
// Positive = a defective (weakened) test diff, negative = the merged good diff. Same verdict order and AUC as SEC-F1
// (accepted 0 < insufficient_evidence 1 < needs_revision 2 < rejected 3, Mann-Whitney, ties ½); items without a verdict
// stay unscored and are reported, never counted as accepted. Pure arithmetic: no network, no model, no DB.
// Usage: node scripts/f1-score.mjs --results <results.jsonl> [--items docs/research/eco/f1] [--json <out>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeOutput, parseArgs, readJsonl, readManifest, sha256 } from './sec-f1-lib.mjs';
import { CAUGHT, SCORE, auc, wilson } from './sec-f1-score.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const F1_ITEMS_DIR = path.join(ROOT, 'docs/research/eco/f1');

export function scoreF1(manifestItems, results) {
  const res = new Map();
  for (const r of results) { if (res.has(r.id)) throw new Error(`F1_DUPLICATE_RESULT ${r.id}`); res.set(r.id, r); }
  const rows = manifestItems.map((i) => {
    const r = res.get(i.id);
    if (r && !(r.verdict in SCORE)) throw new Error(`F1_BAD_VERDICT ${i.id}: ${r.verdict}`);
    return { id: i.id, pr: i.pr, kind: i.kind, positive: i.side === 'defective', verdict: r ? r.verdict : null, tokens: r ? Number(r.tokens_total) || 0 : 0 };
  });
  const pos = rows.filter((r) => r.positive); const neg = rows.filter((r) => !r.positive);
  const sp = pos.filter((r) => r.verdict); const sn = neg.filter((r) => r.verdict);
  const tokens = rows.filter((r) => r.verdict).map((r) => r.tokens);
  const kinds = [...new Set(pos.map((r) => r.kind))].sort();
  return {
    protocol: 'F1-R',
    unscored_ids: rows.filter((r) => !r.verdict).map((r) => r.id),
    all: {
      items: { total: rows.length, positives: pos.length, negatives: neg.length, scored_positives: sp.length, scored_negatives: sn.length, unscored: rows.length - sp.length - sn.length },
      auc: auc(sp.map((r) => SCORE[r.verdict]), sn.map((r) => SCORE[r.verdict])),
      llm: {
        caught: wilson(sp.filter((r) => CAUGHT.has(r.verdict)).length, sp.length),
        false_reject: wilson(sn.filter((r) => r.verdict !== 'accepted').length, sn.length),
        defective_accepted: wilson(sp.filter((r) => r.verdict === 'accepted').length, sp.length),
        good_accepted: wilson(sn.filter((r) => r.verdict === 'accepted').length, sn.length),
        no_verdict: wilson(rows.filter((r) => r.verdict === 'insufficient_evidence').length, sp.length + sn.length),
      },
      per_kind: Object.fromEntries(kinds.map((k) => {
        const g = pos.filter((r) => r.kind === k); const gs = g.filter((r) => r.verdict);
        return [k, { items: g.length, scored: gs.length, caught: gs.filter((r) => CAUGHT.has(r.verdict)).length, accepted: gs.filter((r) => r.verdict === 'accepted').length }];
      })),
      tokens: { total: tokens.reduce((s, t) => s + t, 0), mean: tokens.length ? tokens.reduce((s, t) => s + t, 0) / tokens.length : null },
    },
  };
}

function main(argv) {
  const o = parseArgs(argv, { results: 'v', items: 'v', json: 'v' });
  if (!o.results) throw new Error('usage: f1-score.mjs --results <results.jsonl> [--items <dir>] [--json <out>]');
  const itemsDir = path.resolve(o.items || F1_ITEMS_DIR);
  const manifestText = fs.readFileSync(path.join(itemsDir, 'manifest.json'), 'utf8');
  const out = { ...scoreF1(readManifest(itemsDir).items, readJsonl(o.results)), manifest_sha256: sha256(manifestText) };
  const text = `${JSON.stringify(out, null, 2)}\n`;
  if (o.json) fs.writeFileSync(assertSafeOutput(o.json, { itemsDir }), text);
  process.stdout.write(text);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (err) { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); }
}
