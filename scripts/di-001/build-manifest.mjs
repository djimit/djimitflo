#!/usr/bin/env node
// DI-001: build the frozen manifest (PREREG §1, §2, §4, §5). Read-only DB; manifest JSON on stdout.
// usage: node build-manifest.mjs --db /data/djimitflo.sqlite [--snapshot <ISO>]   (default snapshot = now)
import { openDb, extract, labelOf, clusters, outcomeAt, splitOf, riskOf, templateOf, lostWindow, sha256, ms, PREREG_SHA256 } from './lib.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const snapshotAt = arg('--snapshot', new Date().toISOString());
const db = openDb(arg('--db', '/data/djimitflo.sqlite'));

const statusCounts = Object.entries(db.prepare('SELECT status, created_at FROM self_improvements').all()
  .filter((s) => ms(s.created_at) <= ms(snapshotAt)).reduce((a, s) => ((a[s.status] = (a[s.status] ?? 0) + 1), a), {}))
  .sort(([a], [b]) => a.localeCompare(b)).map(([status, n]) => ({ status, n }));
const xs = extract(db, snapshotAt);
const cl = clusters(xs);
const rows = xs.map((x) => {
  const l = labelOf(x);
  return {
    id: x.p.id, created_at: x.p.created_at, outcome_at: outcomeAt(x), status: x.p.status, label_class: l.cls, label_reason: l.why,
    cluster_id: cl.get(x.p.id), split: splitOf(x.p.created_at), risk_class: riskOf(x.p, x.refs), template: templateOf(x.refs),
    source: x.p.source, lost_window: lostWindow(x), runs: x.nRuns,
  };
}).sort((a, b) => a.id.localeCompare(b.id));
const tally = (k) => rows.reduce((a, r) => ((a[r[k]] = (a[r[k]] ?? 0) + 1), a), {});
const manifest = {
  study: 'DI-001', prereg_sha256: PREREG_SHA256, snapshot_at: snapshotAt, db: 'djimitflo-live:/data/djimitflo.sqlite (readonly)',
  population_rule: "self_improvements.status IN ('verified','regressed') AND created_at <= snapshot_at",
  excluded_statuses_at_snapshot: statusCounts.filter((s) => !['verified', 'regressed'].includes(s.status)),
  n: rows.length, n_clusters: new Set(rows.map((r) => r.cluster_id)).size,
  by_label_class: tally('label_class'), by_split: tally('split'), by_risk_class: tally('risk_class'), lost_window_flagged: rows.filter((r) => r.lost_window).length,
  rows_sha256: sha256(JSON.stringify(rows)), rows,
};
process.stdout.write(JSON.stringify(manifest, null, 1) + '\n');
