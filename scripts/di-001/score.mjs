#!/usr/bin/env node
// DI-001 scorer (docs/research/di-001/PREREG.md §6–§9). Reproduces every number in the DI-001 docs from the frozen manifest
// plus a read-only DB read. Deterministic: manifest order, sorted clusters, seeded bootstrap (mulberry32, seed 20261014).
// usage: node score.mjs --manifest manifest.json --db /data/djimitflo.sqlite > results.json
import { readFileSync } from 'fs';
import { openDb, extract, labelOf, sha256, ms, POSITIVE, NEGATIVE, testOnly, PREREG_SHA256 } from './lib.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const m = JSON.parse(readFileSync(arg('--manifest', 'manifest.json'), 'utf8'));
if (sha256(JSON.stringify(m.rows)) !== m.rows_sha256) throw new Error('manifest rows_sha256 mismatch');
if (m.prereg_sha256 !== PREREG_SHA256) throw new Error('manifest was built under another PREREG');
const db = openDb(arg('--db', '/data/djimitflo.sqlite'));
const SEED = 20261014; const B = 2000;
const r4 = (x) => (x === null || x === undefined || Number.isNaN(x) ? null : Math.round(x * 1e4) / 1e4);

// ---- data -------------------------------------------------------------------------------------------------------------
const xs = extract(db, m.snapshot_at, m.rows.map((r) => r.id));
const X = new Map(xs.map((x) => [x.p.id, x]));
const drift = [];
for (const r of m.rows) {
  const x = X.get(r.id);
  if (!x) { drift.push({ id: r.id, now: 'missing' }); continue; }
  const now = labelOf(x).cls;
  if (now !== r.label_class || x.p.status !== r.status) drift.push({ id: r.id, manifest: `${r.status}/${r.label_class}`, now: `${x.p.status}/${now}` });
}

const LABELS = {
  primary: (r) => (POSITIVE.has(r.label_class) ? 1 : NEGATIVE.has(r.label_class) ? 0 : null),
  status: (r) => (r.status === 'verified' ? 1 : 0),
  oracle_only: (r) => (['ORACLE_PASS_VERIFIED', 'CHECKER_REJECT', 'NO_VERDICT'].includes(r.label_class) ? 1 : NEGATIVE.has(r.label_class) ? 0 : null),
  // EXPLORATORY (not pre-registered): the status label among changes that were evaluated at all (ENV removed)
  x_status_evaluated: (r) => (r.label_class === 'ENV' || r.label_class === 'UNCLASSIFIED' ? null : r.status === 'verified' ? 1 : 0),
};

// ---- predictors (PREREG §6) -------------------------------------------------------------------------------------------
const leak = {};
const firstJudgment = (x, name, r) => {
  const js = x.judgments.filter((j) => j.judgment === name);
  if (!js.length) return { j: null, reason: 'none' };
  const j = js[0];
  let a = {}; try { a = JSON.parse(j.answers_json || '{}'); } catch { /* unparsable → abstain */ }
  const goalAt = x.goals[0]?.created_at ?? null;
  const k = (leak[name] ??= { with_judgment: 0, created_after_outcome: 0, as_of_after_goal: 0, error_or_unparsable: 0 });
  k.with_judgment++;
  if (!(ms(j.created_at) < ms(r.outcome_at))) { k.created_after_outcome++; return { j: null, reason: 'leak_created' }; }
  if (typeof a.as_of === 'string' && goalAt && !(ms(a.as_of) < ms(goalAt))) { k.as_of_after_goal++; return { j: null, reason: 'leak_as_of' }; }
  if (j.decision === 'error') { k.error_or_unparsable++; return { j: null, reason: 'error' }; }
  return { j, a };
};
const expanding = (r, keyFn, okFn) => {
  const t = ms(r.created_at); let k = 0; let n = 0;
  for (const o of m.rows) if (keyFn(o) === keyFn(r) && ms(o.outcome_at) < t) { n++; if (okFn(o)) k++; }
  return { k, n, rate: (k + 1) / (n + 2) };
};
const PRED = {
  committee: (r, x) => { const { j, a } = firstJudgment(x, 'forecast:committee', r); if (!j) return null; const p = typeof a.p === 'number' ? a.p : null; return { accept: j.decision === 'yes', p, j }; },
  A0_accept_all: () => ({ accept: true, p: null }),
  A1_reject_all: () => ({ accept: false, p: null }),
  A2_source_rate: (r) => { const e = expanding(r, (o) => o.source, (o) => o.status === 'verified'); return { accept: e.rate >= 0.5, p: e.rate, n_prior: e.n }; },
  A3_test_only: (r, x) => ({ accept: testOnly(x.p, x.refs), p: null }),
  A4_template_regress: (r) => { const e = expanding(r, (o) => o.template, (o) => o.status === 'regressed'); return { accept: e.rate < 0.5, p: 1 - e.rate, n_prior: e.n }; },
  // SENSITIVITY (not pre-registered, see BASELINE.md §Deviations): the system's own leakage rule only (as_of < goal), and no filter
  committee_asof_only: (r, x) => { const j = x.judgments.find((q) => q.judgment === 'forecast:committee' && q.decision !== 'error'); if (!j) return null; let a = {}; try { a = JSON.parse(j.answers_json || '{}'); } catch { return null; } const g = x.goals[0]?.created_at; if (typeof a.as_of !== 'string' || !g || !(ms(a.as_of) < ms(g))) return null; return { accept: j.decision === 'yes', p: typeof a.p === 'number' ? a.p : null, j }; },
  committee_unfiltered: (r, x) => { const j = x.judgments.find((q) => q.judgment === 'forecast:committee' && q.decision !== 'error'); if (!j) return null; let a = {}; try { a = JSON.parse(j.answers_json || '{}'); } catch { return null; } return { accept: j.decision === 'yes', p: typeof a.p === 'number' ? a.p : null, j }; },
  prescreen: (r, x) => { const { j } = firstJudgment(x, 'proposal_prescreen', r); if (!j || !['yes', 'no'].includes(j.decision)) return null; return { accept: j.decision === 'yes', p: null, j }; },
};
const preds = Object.fromEntries(Object.keys(PRED).map((k) => [k, new Map(m.rows.map((r) => [r.id, PRED[k](r, X.get(r.id))]))]));

// ---- metrics ----------------------------------------------------------------------------------------------------------
const DEFAULT_W = { fa: { security: 20, production: 10, low: 3 }, fr: 1 };
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const wilson = (k, n, z = 1.959964) => { if (!n) return null; const p = k / n; const d = 1 + z * z / n; const c = p + z * z / (2 * n); const h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return [r4((c - h) / d), r4((c + h) / d)]; };
const pct = (xs, q) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const rowLoss = (r, acc, y, w) => (acc && y === 0 ? w.fa[r.risk_class] : !acc && y === 1 ? w.fr : 0);
/** PREREG §7: mean over clusters of the cluster's mean row loss. */
function clusterLoss(rows, predName, y, w) {
  const by = new Map();
  for (const r of rows) { const l = rowLoss(r, preds[predName].get(r.id).accept, y(r), w); const c = by.get(r.cluster_id) ?? []; c.push(l); by.set(r.cluster_id, c); }
  const ms_ = [...by.values()].map((c) => c.reduce((a, b) => a + b, 0) / c.length);
  return ms_.length ? ms_.reduce((a, b) => a + b, 0) / ms_.length : null;
}
function bootstrap(rows, fn, seed = SEED) {
  const cl = [...new Set(rows.map((r) => r.cluster_id))].sort();
  if (cl.length < 2) return null;
  const members = new Map(cl.map((c) => [c, rows.filter((r) => r.cluster_id === c)]));
  const rnd = mulberry32(seed); const out = [];
  for (let b = 0; b < B; b++) {
    const sample = [];
    for (let i = 0; i < cl.length; i++) { const c = cl[Math.floor(rnd() * cl.length)]; for (const r of members.get(c)) sample.push({ ...r, cluster_id: `${c}#${i}` }); }
    const v = fn(sample); if (v !== null && !Number.isNaN(v)) out.push(v);
  }
  return out.length ? [r4(pct(out, 0.025)), r4(pct(out, 0.975))] : null;
}
function ece(pairs, bins = 10) {
  let e = 0; for (let b = 0; b < bins; b++) {
    const xs_ = pairs.filter(([p]) => (b === bins - 1 ? p >= b / bins : p >= b / bins && p < (b + 1) / bins)); if (!xs_.length) continue;
    const conf = xs_.reduce((a, [p]) => a + p, 0) / xs_.length; const acc = xs_.reduce((a, [, y]) => a + y, 0) / xs_.length; e += (xs_.length / pairs.length) * Math.abs(conf - acc);
  } return e;
}
const nClusters = (rows) => new Set(rows.map((r) => r.cluster_id)).size;

function score(predName, rows, labelName, w = DEFAULT_W) {
  const y = LABELS[labelName];
  const eligible = rows.filter((r) => y(r) !== null);
  const covered = eligible.filter((r) => preds[predName].get(r.id));
  const c = { TP: 0, FP: 0, TN: 0, FN: 0 };
  for (const r of covered) { const a = preds[predName].get(r.id).accept; const v = y(r); c[a ? (v ? 'TP' : 'FP') : (v ? 'FN' : 'TN')]++; }
  const n = covered.length; const pos = c.TP + c.FN; const neg = c.FP + c.TN;
  const probs = covered.map((r) => [preds[predName].get(r.id).p, y(r)]).filter(([p]) => typeof p === 'number');
  return {
    eligible: eligible.length, covered: n, clusters: nClusters(covered), positives: pos, negatives: neg, ...c,
    coverage: r4(eligible.length ? n / eligible.length : null), abstention: r4(eligible.length ? 1 - n / eligible.length : null),
    P_FA: r4(n ? c.FP / n : null), P_FR: r4(n ? c.FN / n : null),
    precision: r4(c.TP + c.FP ? c.TP / (c.TP + c.FP) : null), recall: r4(pos ? c.TP / pos : null),
    FAR: r4(neg ? c.FP / neg : null), FRR: r4(pos ? c.FN / pos : null),
    accuracy_note: 'per risk class only; never pooled across risk classes as one accuracy',
    loss: r4(n ? clusterLoss(covered, predName, y, w) : null),
    loss_ci95: n ? bootstrap(covered, (s) => clusterLoss(s, predName, y, w)) : null,
    brier: probs.length ? r4(probs.reduce((a, [p, v]) => a + (p - v) ** 2, 0) / probs.length) : null,
    ece10: probs.length ? r4(ece(probs)) : null, n_prob: probs.length,
    by_risk_class: Object.fromEntries(['security', 'production', 'low'].map((k) => { const rs = covered.filter((r) => r.risk_class === k); const fa = rs.filter((r) => preds[predName].get(r.id).accept && y(r) === 0).length; const fr = rs.filter((r) => !preds[predName].get(r.id).accept && y(r) === 1).length; return [k, { n: rs.length, FA: fa, FR: fr }]; })),
  };
}

const SPL = { development: (r) => r.split === 'development', calibration: (r) => r.split === 'calibration', holdout: (r) => r.split === 'holdout', all: () => true };
const rowsOf = (s, extra = () => true) => m.rows.filter((r) => SPL[s](r) && extra(r));
const results = { study: 'DI-001', prereg_sha256: PREREG_SHA256, manifest_rows_sha256: m.rows_sha256, snapshot_at: m.snapshot_at, seed: SEED, bootstrap_B: B, label_drift_since_manifest: drift };

// population + label provenance
const cls = (rows) => rows.reduce((a, r) => ((a[r.label_class] = (a[r.label_class] ?? 0) + 1), a), {});
results.population = Object.fromEntries(Object.keys(SPL).map((s) => { const rs = rowsOf(s); return [s, { n: rs.length, clusters: nClusters(rs), design_effect: r4(rs.length / Math.max(1, nClusters(rs))), by_label_class: cls(rs), verified: rs.filter((r) => r.status === 'verified').length, regressed: rs.filter((r) => r.status === 'regressed').length }]; }));
const attributed = m.rows.filter((r) => { const x = X.get(r.id); return x && [...x.judgments, ...x.runJudg].some((j) => j.judgment === 'outcome_attribution'); }).length;
const oracleSets = m.rows.map((r) => { const x = X.get(r.id); const mk = x.leases.filter((l) => l.role === 'maker' && !l.meta.superseded_by_maker_lease_id).pop(); return (mk?.meta.deterministic_checks ?? []).map((c) => c.name); });
results.label_provenance = {
  resolved_by_rule: m.rows.filter((r) => r.label_class !== 'UNCLASSIFIED').length, of: m.rows.length,
  with_outcome_attribution: attributed,
  final_maker_ran_checks: oracleSets.filter((s) => s.length).length,
  final_maker_ran_mutation: oracleSets.filter((s) => s.includes('test:mutation:grounded')).length,
  final_maker_ran_assertion_strength: oracleSets.filter((s) => s.includes('test:assertion-strength')).length,
  any_maker_attempt_check_failed: m.rows.filter((r) => X.get(r.id).leases.some((l) => l.role === 'maker' && (l.meta.deterministic_checks ?? []).some((c) => typeof c.exit_status === 'number' && c.exit_status !== 0 && c.exit_status !== 127))).map((r) => ({ id: r.id, label_class: r.label_class, status: r.status })),
  operator_label_rows: m.rows.reduce((a, r) => a + X.get(r.id).judgments.filter((j) => j.judgment === 'operator_label').length, 0),
  attribution_audit_rows: m.rows.reduce((a, r) => a + X.get(r.id).runJudg.filter((j) => j.judgment === 'attribution_audit').length, 0),
  assertion_strength_retroactive: m.rows.reduce((a, r) => { for (const j of X.get(r.id).runJudg.filter((q) => q.judgment === 'assertion_strength_retroactive')) a[j.decision] = (a[j.decision] ?? 0) + 1; return a; }, {}),
  label_reasons: m.rows.reduce((a, r) => { const k = `${r.label_class}: ${r.label_reason}`; a[k] = (a[k] ?? 0) + 1; return a; }, {}),
};
// merge survival (independent, D-class)
const prs = m.rows.map((r) => ({ r, o: X.get(r.id).run?.meta.pr_outcome })).filter((q) => q.o);
results.merge_survival = {
  with_pr: prs.length, by_state: prs.reduce((a, q) => ((a[q.o.state] = (a[q.o.state] ?? 0) + 1), a), {}),
  settled: prs.filter((q) => typeof q.o.survived === 'boolean' && q.o.settled_at).map((q) => ({ id: q.r.id, survived: q.o.survived, label_class: q.r.label_class })),
};

// per-predictor scores
results.scores = {};
for (const lab of Object.keys(LABELS)) for (const s of Object.keys(SPL)) for (const p of Object.keys(PRED)) (results.scores[lab] ??= {})[`${s}/${p}`] = score(p, rowsOf(s), lab);
results.leakage = leak;

// committee (COMMITTEE.md)
const committeeRows = (s, pn = 'committee') => rowsOf(s, (r) => preds[pn].get(r.id));
function contrast(rows, lab, pn = 'committee') {
  const y = LABELS[lab]; const rs = rows.filter((r) => y(r) !== null);
  const g = (acc) => { const q = rs.filter((r) => preds[pn].get(r.id).accept === acc); return { n: q.length, pos: q.filter((r) => y(r) === 1).length, clusters: nClusters(q) }; };
  const yes = g(true); const no = g(false);
  const diff = (sample) => { const a = sample.filter((r) => preds[pn].get(r.id).accept); const b = sample.filter((r) => !preds[pn].get(r.id).accept); if (!a.length || !b.length) return null; return a.filter((r) => y(r) === 1).length / a.length - b.filter((r) => y(r) === 1).length / b.length; };
  const pbar = rs.length ? rs.filter((r) => y(r) === 1).length / rs.length : null;
  const mde = yes.clusters && no.clusters && pbar !== null ? r4(2.801585 * Math.sqrt(pbar * (1 - pbar) * (1 / yes.clusters + 1 / no.clusters))) : null;
  const d = diff(rs);
  const ci = rs.length ? bootstrap(rs, diff) : null;
  return { yes: { ...yes, rate: r4(yes.n ? yes.pos / yes.n : null), wilson95: wilson(yes.pos, yes.n) }, no: { ...no, rate: r4(no.n ? no.pos / no.n : null), wilson95: wilson(no.pos, no.n) },
    diff: r4(d), diff_cluster_ci95: ci, mde_80pct_power: mde, pooled_rate: r4(pbar),
    verdict: d === null || pbar === 0 || pbar === 1 ? 'INSUFFICIENT (a group or a label class is empty)' : ci && (ci[0] > 0 || ci[1] < 0) ? 'supported (CI excludes 0)' : 'not supported at this n (CI includes 0)' };
}
results.committee = {
  // replication of the prior audit's raw count: first committee forecast per proposal, status label, no leakage filter
  replication_no_leak_filter: (() => { const t = { yes: [0, 0], no: [0, 0] }; for (const r of m.rows) { const j = X.get(r.id).judgments.find((q) => q.judgment === 'forecast:committee'); if (!j || !t[j.decision]) continue; t[j.decision][1]++; if (r.status === 'verified') t[j.decision][0]++; } return { yes_verified: `${t.yes[0]}/${t.yes[1]}`, no_verified: `${t.no[0]}/${t.no[1]}` }; })(),
  contrast: Object.fromEntries(Object.keys(LABELS).flatMap((lab) => ['calibration', 'holdout', 'all'].map((s) => [`${lab}/${s}`, contrast(committeeRows(s), lab)]))),
  sensitivity_contrast: Object.fromEntries(['committee_asof_only', 'committee_unfiltered'].flatMap((pn) => Object.keys(LABELS).flatMap((lab) => ['holdout', 'all'].map((s) => [`${pn}/${lab}/${s}`, contrast(committeeRows(s, pn), lab, pn)])))),
  sensitivity_by_label_class: Object.fromEntries(['committee_asof_only', 'committee_unfiltered'].map((pn) => [pn, Object.fromEntries(['yes', 'no'].map((d) => [d, cls(committeeRows('all', pn).filter((r) => preds[pn].get(r.id).accept === (d === 'yes')))]))])),
  timing_all_forecasts_hours: (() => { const rs = committeeRows('all', 'committee_unfiltered'); const h = (a, b) => (ms(a) - ms(b)) / 3_600_000; const rows = rs.map((r) => { const x = X.get(r.id); const j = preds.committee_unfiltered.get(r.id).j; let a = {}; try { a = JSON.parse(j.answers_json); } catch { /* none */ } return { created_minus_outcome: h(j.created_at, r.outcome_at), as_of_minus_goal: x.goals[0] && a.as_of ? h(a.as_of, x.goals[0].created_at) : null, as_of_minus_outcome: a.as_of ? h(a.as_of, r.outcome_at) : null }; }); const q = (k) => { const v = rows.map((o) => o[k]).filter((z) => z !== null); return { n: v.length, gt0: v.filter((z) => z >= 0).length, p50: r4(pct(v, 0.5)), p95: r4(pct(v, 0.95)) }; }; return { created_minus_outcome: q('created_minus_outcome'), as_of_minus_goal: q('as_of_minus_goal'), as_of_minus_outcome: q('as_of_minus_outcome') }; })(),
  by_label_class: Object.fromEntries(['yes', 'no'].map((d) => [d, cls(committeeRows('all').filter((r) => preds.committee.get(r.id).accept === (d === 'yes')))])),
  p_recorded: committeeRows('all').filter((r) => typeof preds.committee.get(r.id).p === 'number').length,
  confidence_field_recorded: committeeRows('all').filter((r) => /confidence/.test(preds.committee.get(r.id).j.answers_json ?? '')).length,
  latency_minutes_created_minus_as_of: (() => { const l = committeeRows('all').map((r) => { const j = preds.committee.get(r.id).j; let a = {}; try { a = JSON.parse(j.answers_json); } catch { /* none */ } return a.as_of ? (ms(j.created_at) - ms(a.as_of)) / 60000 : null; }).filter((v) => v !== null); return { n: l.length, p50: r4(pct(l, 0.5)), p95: r4(pct(l, 0.95)) }; })(),
  forecast_minus_goal_minutes: (() => { const l = committeeRows('all').map((r) => { const x = X.get(r.id); return x.goals[0] ? (ms(x.goals[0].created_at) - ms(preds.committee.get(r.id).j.created_at)) / 60000 : null; }).filter((v) => v !== null); return { n: l.length, written_after_goal: l.filter((v) => v < 0).length, p50: r4(pct(l, 0.5)) }; })(),
  tokens: (() => { let tin = 0; let tout = 0; let rows = 0; for (const r of committeeRows('all')) for (const j of X.get(r.id).judgments.filter((q) => q.judgment.startsWith('forecast:committee'))) { rows++; tin += j.input_tokens ?? 0; tout += j.output_tokens ?? 0; } const ver = committeeRows('all').filter((r) => r.status === 'verified').length; return { judgment_rows: rows, input_tokens: tin, output_tokens: tout, tokens_recorded: tin + tout > 0, tokens_per_verified: ver ? r4((tin + tout) / ver) : null }; })(),
  selective_risk_status_label_all: (() => { const rs = committeeRows('all').filter((r) => typeof preds.committee.get(r.id).p === 'number').sort((a, b) => Math.abs(preds.committee.get(b.id).p - 0.5) - Math.abs(preds.committee.get(a.id).p - 0.5) || a.id.localeCompare(b.id)); let err = 0; const curve = []; rs.forEach((r, i) => { if (preds.committee.get(r.id).accept !== (r.status === 'verified')) err++; curve.push([r4((i + 1) / rs.length), r4(err / (i + 1))]); }); const at = curve.filter(([, k]) => k <= 0.2).map(([c]) => c); return { n: rs.length, full_coverage_risk: curve.length ? curve[curve.length - 1][1] : null, coverage_at_risk_0_20_optimistic: at.length ? Math.max(...at) : 0, curve_deciles: curve.filter((_, i) => (i + 1) % Math.max(1, Math.floor(rs.length / 10)) === 0) }; })(),
};
// matched comparison on the committee-covered holdout + acceptance rule (PREREG §9) + sensitivity grid (LOSS.md)
const GRID = []; for (const low of [1, 3, 10]) for (const prod of [5, 10, 20]) for (const sec of [10, 20, 50]) for (const fr of [0.5, 1, 2, 5]) GRID.push({ fa: { security: sec, production: prod, low }, fr });
const BASE = ['A0_accept_all', 'A1_reject_all', 'A2_source_rate', 'A3_test_only', 'A4_template_regress'];
function acceptance(lab, split, pn = 'committee') {
  const y = LABELS[lab]; const rows = committeeRows(split, pn).filter((r) => y(r) !== null);
  const point = Object.fromEntries([...BASE, pn].map((p) => [p, r4(clusterLoss(rows, p, y, DEFAULT_W))]));
  const best = BASE.filter((p) => point[p] !== null).sort((a, b) => point[a] - point[b] || a.localeCompare(b))[0];
  const cpos = nClusters(rows.filter((r) => y(r) === 1)); const cneg = nClusters(rows.filter((r) => y(r) === 0));
  const diffCi = rows.length ? bootstrap(rows, (s) => clusterLoss(s, best, y, DEFAULT_W) - clusterLoss(s, pn, y, DEFAULT_W)) : null;
  const grid = GRID.map((w) => { const Lc = clusterLoss(rows, pn, y, w); const Lb = Math.min(...BASE.map((p) => clusterLoss(rows, p, y, w))); return { w, committee: r4(Lc), best_baseline: r4(Lb), committee_better: Lc < Lb, committee_worse: Lc > Lb }; });
  const enough = nClusters(rows) >= 20 && cpos >= 5 && cneg >= 5;
  const better = enough && diffCi && diffCi[0] > 0 && grid.every((g) => g.committee_better);
  const worse = enough && diffCi && diffCi[1] < 0 && grid.every((g) => g.committee_worse);
  const brierOn = (q) => { const v = rows.map((r) => [preds[q].get(r.id).p, y(r)]).filter(([p]) => typeof p === 'number'); return v.length ? r4(v.reduce((a, [p, t]) => a + (p - t) ** 2, 0) / v.length) : null; };
  const matched_brier = { [pn]: brierOn(pn), A2_source_rate: brierOn('A2_source_rate'), A4_template_regress: brierOn('A4_template_regress'), constant_rate: rows.length ? r4(rows.reduce((a, r) => a + (rows.filter((q) => y(q) === 1).length / rows.length - y(r)) ** 2, 0) / rows.length) : null };
  return { label: lab, split, rows: rows.length, clusters: nClusters(rows), clusters_pos: cpos, clusters_neg: cneg, point_loss: point, best_baseline: best, matched_brier,
    diff_best_minus_committee: r4(point[best] - point[pn]), diff_cluster_ci95: diffCi,
    grid_cells: grid.length, grid_committee_better: grid.filter((g) => g.committee_better).length, grid_committee_worse: grid.filter((g) => g.committee_worse).length,
    verdict: !enough ? 'INSUFFICIENT' : better ? 'BETTER' : worse ? 'WORSE' : 'INCONCLUSIVE' };
}
results.acceptance = Object.fromEntries(Object.keys(LABELS).flatMap((lab) => ['holdout', 'all'].map((s) => [`${lab}/${s}`, acceptance(lab, s)])));
results.sensitivity_acceptance = Object.fromEntries(['committee_asof_only', 'committee_unfiltered'].flatMap((pn) => ['status', 'x_status_evaluated'].flatMap((lab) => ['holdout', 'all'].map((s) => [`${pn}/${lab}/${s}`, acceptance(lab, s, pn)]))));
// inference-token component per judgment-based predictor on the population (all judgments of that key, ≤ snapshot)
results.tokens = Object.fromEntries([['committee', /^forecast:committee/], ['prescreen', /^proposal_prescreen$/], ['A2_A4_baselines', /^$/]].map(([k, re]) => {
  let tin = 0; let tout = 0; let n = 0; let lat = [];
  for (const r of m.rows) for (const j of X.get(r.id).judgments.filter((q) => re.test(q.judgment))) { n++; tin += j.input_tokens ?? 0; tout += j.output_tokens ?? 0; if (typeof j.latency_ms === 'number') lat.push(j.latency_ms); }
  const ver = m.rows.filter((r) => r.status === 'verified').length;
  return [k, { judgment_rows: n, input_tokens: tin, output_tokens: tout, tokens_per_verified_in_population: r4((tin + tout) / ver), latency_ms_p50: pct(lat, 0.5), latency_ms_p95: pct(lat, 0.95), note: k === 'A2_A4_baselines' ? 'deterministic, 0 tokens' : tin + tout === 0 ? 'tokens not recorded on these rows (UNKNOWN, not zero)' : '' }];
}));
// human capacity component (LOSS.md): accepted decisions per day on holdout vs 30 min/day
results.human_capacity = (() => { const rs = rowsOf('holdout'); const days = (Math.max(...rs.map((r) => ms(r.created_at))) - Math.min(...rs.map((r) => ms(r.created_at)))) / 86_400_000; return { holdout_days: r4(days), budget_min_per_day: 30, per_predictor: Object.fromEntries(Object.keys(PRED).map((p) => { const acc = rs.filter((r) => preds[p].get(r.id)?.accept).length; return [p, { accepts: acc, accepts_per_day: r4(acc / days), review_minutes_per_accept_at_budget: acc ? r4(30 / (acc / days)) : null }]; })) }; })();

process.stdout.write(JSON.stringify(results, null, 1) + '\n');
