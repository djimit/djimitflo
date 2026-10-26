#!/usr/bin/env node
// MFR-001 scorer (protocol "Analysis"): deterministic, no model. Reads the per-item result files, applies the registered
// endpoint, statistics and decision rule (lib.mjs summarize), and writes the raw per-item results plus the summary.
//   node scripts/mfr-001/score.mjs --results <dir> --items docs/research/eco/mfr-001/items.json --out docs/research/eco/mfr-001/results.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARMS, summarize } from './lib.mjs';

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };

export function report(manifest, results) {
  const byId = new Map(results.map((r) => [r.id, r]));
  const ordered = manifest.items.map((i) => byId.get(i.id)).filter(Boolean);
  const s = summarize(ordered);
  const runs = ordered.flatMap((r) => ARMS.map((a) => r.runs?.[a]).filter(Boolean));
  const sum = (xs) => xs.reduce((a, b) => a + (Number(b) || 0), 0);
  const eligible = ordered.filter((r) => r.eligible);
  return {
    ...s,
    items_in_manifest: manifest.items.length, items_run: ordered.length,
    wall_time_h: +(sum(ordered.map((r) => r.timings?.total_ms)) / 3600_000).toFixed(2),
    gpu_time_h: { maker_wall_proxy: +(sum(runs.map((r) => r.maker_ms)) / 3600_000).toFixed(2), note: 'llama-router busy time is bounded by the atomic-agent maker wall time; scoring runs are CPU only' },
    cloud_tokens: 0,
    fidelity: { checked: ordered.filter((r) => r.original).length, prod_kill_match: ordered.filter((r) => r.original?.fidelity_match).length },
    original_test_held_kill_mean: eligible.length ? +(sum(eligible.map((r) => r.original.held_kill)) / eligible.length).toFixed(4) : null,
    shown_kill_mean: Object.fromEntries(ARMS.map((a) => [a, eligible.length ? +(sum(eligible.map((r) => r.runs?.[a]?.shown_kill)) / eligible.length).toFixed(4) : null])),
    maker_terminations: runs.reduce((o, r) => ({ ...o, [r.termination ?? 'none']: (o[r.termination ?? 'none'] ?? 0) + 1 }), {}),
    router_models: [...new Set(ordered.map((r) => r.router_models).filter(Boolean))],
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const manifest = JSON.parse(fs.readFileSync(arg('--items'), 'utf8'));
  const dir = arg('--results');
  const results = fs.readdirSync(dir).filter((f) => /^[0-9a-f-]{36}\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  const summary = report(manifest, results);
  fs.writeFileSync(arg('--out'), `${JSON.stringify({ protocol: 'MFR-001', summary, items: results }, null, 1)}\n`);
  console.log(JSON.stringify(summary, null, 1));
}
