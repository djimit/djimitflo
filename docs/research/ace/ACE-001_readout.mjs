// ACE-001 registered readout (docs/research/ace/ACE-001_RESULT.md). Read-only; changes nothing.
// Prod:   docker exec -i -e NODE_PATH=/app/node_modules -w /app/packages/server djimitflo-live node --input-type=module - < ACE-001_readout.mjs
//         opens /data/djimitflo.sqlite with { readonly: true } + query_only and prints the readout JSON.
// Replay: ACE_DUMP=<rows.json> node ACE-001_readout.mjs   (a saved { at, rows, ev } dump of the same two SELECTs)
import fs from 'fs';
import { createHash } from 'crypto';
async function fetchData() {
  if (process.env.ACE_DUMP) return JSON.parse(fs.readFileSync(process.env.ACE_DUMP, 'utf8'));
  const { default: Sqlite } = await import('better-sqlite3');
  const d = new Sqlite('/data/djimitflo.sqlite', { readonly: true, fileMustExist: true }); d.pragma('query_only = ON');
  // every production maker outcome carrying an ACE-001 arm, with its run, goal, proposal and the run's latest assignment
  const rows = d.prepare(`SELECT o.id, o.created_at, substr(r.value,13) AS arm, o.success, o.tokens_used, o.evidence_refs_json AS refs, o.task_id, o.skill_id, o.skill_content_hash,
    lr.goal_id, lr.status AS run_status, lr.gates_json, lr.created_at AS run_created, g.created_at AS goal_created, g.improvement_id,
    s.status AS prop_status, s.evidence_refs_json AS prop_refs,
    (SELECT e.metadata FROM loop_events e WHERE e.loop_run_id = o.task_id AND e.event_type='assignment_context' ORDER BY e.created_at DESC LIMIT 1) AS assign_meta,
    (SELECT COUNT(*) FROM worker_leases fl WHERE fl.loop_run_id = o.task_id AND json_extract(fl.metadata,'$.runtime_fallback') IS NOT NULL) AS fb_leases
    FROM skill_outcomes o, json_each(o.evidence_refs_json) r
    LEFT JOIN loop_runs lr ON lr.id = o.task_id LEFT JOIN goals g ON g.id = lr.goal_id LEFT JOIN self_improvements s ON s.id = g.improvement_id
    WHERE r.value LIKE 'ace-001-arm:%' AND o.skill_id LIKE 'loop-maker:%' AND o.skill_id NOT LIKE 'loop-maker:gym:%' ORDER BY o.created_at`).all();
  // every assignment that carried an ACE-001 context (delivery, and runs that never produced an outcome)
  const ev = d.prepare(`SELECT e.loop_run_id, e.created_at, e.metadata, lr.goal_id, lr.status AS run_status, s.status AS prop_status
    FROM loop_events e LEFT JOIN loop_runs lr ON lr.id=e.loop_run_id LEFT JOIN goals g ON g.id=lr.goal_id LEFT JOIN self_improvements s ON s.id=g.improvement_id
    WHERE e.event_type='assignment_context' AND json_extract(e.metadata,'$.ace_001') IS NOT NULL ORDER BY e.created_at`).all();
  return { at: new Date().toISOString(), rows, ev };
}
const D = await fetchData();
const SINCE = '2026-10-12T00:00:00Z';
const TRIGGER = '2026-11-11T11:30:24.323Z'; // arm 01 reached its 50th goal (the last arm to reach the target)
const MEM = '2026-10-27T05:52:42Z', SIB = '2026-11-08T00:00:02Z';
const FINE = ['2026-10-27T05:52:42Z', '2026-11-05T19:58:00Z', '2026-11-06T13:35:44.451Z', '2026-11-07T12:00:09.698Z', '2026-11-08T00:00:02Z', '2026-11-08T02:32:21.176Z', '2026-11-09T00:08:31.145Z'];
const ARMS = ['00', '01', '10', '11'];
const lane3 = (p) => p?.includes('"mutation-gap:') ? 'mutation' : p?.includes('#exports') ? 'exports' : p?.includes('"test-gap:') ? 'test-gap' : 'other';
const lane2 = (p) => p?.includes('"mutation-gap:') ? 'mutation' : 'test-gap';
function prep(r) {
  const m = JSON.parse(r.assign_meta); const gates = JSON.parse(r.gates_json || '[]');
  const g = (n) => gates.find((x) => x.name === n)?.status ?? null;
  const refs = JSON.parse(r.refs); const gr = refs.find((x) => x.startsWith('graded:'));
  return { id: r.id, t: r.created_at, arm: r.arm, R: +r.arm[0], S: +r.arm[1], y: r.success ? 1 : 0, status: r.prop_status,
    lane: lane3(r.prop_refs), lane2: lane2(r.prop_refs), h: m.memory_holdout ? 'holdout' : (m.rule_ids?.length ? 'rules' : 'none'),
    p3: r.created_at < MEM ? 'P1' : r.created_at < SIB ? 'P2' : 'P3', pf: 'F' + FINE.filter((b) => r.created_at >= b).length,
    tokens: typeof r.tokens_used === 'number' && r.tokens_used > 0 ? r.tokens_used : null, graded: gr ? +gr.slice(7) : null,
    regressed: r.prop_status === 'regressed' ? 1 : 0, scopeFail: (g('auto_approved_scope') === 'fail' || g('objective_scope') === 'fail') ? 1 : 0,
    secFail: g('security_checker_verdict') === 'fail' ? 1 : 0, checkerFail: g('checker_verdict') === 'fail' ? 1 : 0,
    hash: r.skill_content_hash ?? null, fbLease: r.fb_leases > 0 };
}
function load({ cutoff = TRIGGER, includeOutageFallback = false } = {}) {
  return D.rows.filter((r) => r.created_at >= SINCE && r.created_at <= cutoff && (includeOutageFallback || !r.refs.includes('runtime_fallback'))).map(prep);
}
// ---- statistics
const z = 1.959963984540054;
function wilson(x, n) { if (!n) return null; const p = x / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d; return [c - h, c + h]; }
function newcombe(x1, n1, x0, n0) { const p1 = x1 / n1, p0 = x0 / n0, [l1, u1] = wilson(x1, n1), [l0, u0] = wilson(x0, n0), d = p1 - p0;
  return [d - Math.sqrt((p1 - l1) ** 2 + (u0 - p0) ** 2), d + Math.sqrt((u1 - p1) ** 2 + (p0 - l0) ** 2)]; }
const lgam = (() => { const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  return (x) => { let y = x, t = x + 5.5; t -= (x + 0.5) * Math.log(t); let s = 1.000000000190015; for (const k of c) s += k / ++y; return -t + Math.log(2.5066282746310005 * s / x); }; })();
const lchoose = (n, k) => lgam(n + 1) - lgam(k + 1) - lgam(n - k + 1);
function hyper(N, M, n) { const lo = Math.max(0, n - (N - M)), hi = Math.min(n, M); const p = {}; for (let x = lo; x <= hi; x++) p[x] = Math.exp(lchoose(M, x) + lchoose(N - M, n - x) - lchoose(N, n)); return p; }
/** exact permutation test of the factor label within strata: T = successes among factor-on is a sum of independent hypergeometrics */
function stratPerm(rows, f, strat) {
  const S = new Map(); for (const r of rows) { const k = strat(r); if (!S.has(k)) S.set(k, { N: 0, M: 0, n1: 0, x1: 0 }); const s = S.get(k); s.N++; s.M += r.y; if (r[f]) { s.n1++; s.x1 += r.y; } }
  let dist = { 0: 1 };
  for (const s of S.values()) { const h = hyper(s.N, s.M, s.n1); const nd = {}; for (const [a, pa] of Object.entries(dist)) for (const [b, pb] of Object.entries(h)) { const k = +a + +b; nd[k] = (nd[k] || 0) + pa * pb; } dist = nd; }
  const N1 = [...S.values()].reduce((a, s) => a + s.n1, 0), N = rows.length, N0 = N - N1, M = rows.reduce((a, r) => a + r.y, 0), T = [...S.values()].reduce((a, s) => a + s.x1, 0);
  const Dd = (t) => t / N1 - (M - t) / N0; const dObs = Dd(T); const ET = Object.entries(dist).reduce((a, [t, p]) => a + +t * p, 0);
  let p = 0, pc = 0; for (const [t, pr] of Object.entries(dist)) { if (Math.abs(Dd(+t)) >= Math.abs(dObs) - 1e-12) p += pr; if (Math.abs(+t - ET) >= Math.abs(T - ET) - 1e-9) pc += pr; }
  return { diff: dObs, p_two_sided: Math.min(1, p), p_centered: Math.min(1, pc), strata: S.size, expected_on_successes: ET, observed_on_successes: T };
}
/** Monte Carlo cross-check: permute the 4-arm labels within strata (seeded) */
function mcPerm(rows, f, strat, B = 100000, seed = 20261113) {
  let s = seed >>> 0; const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const groups = new Map(); rows.forEach((r, i) => { const k = strat(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); });
  const ys = rows.map((r) => r.y), lab = rows.map((r) => r[f]);
  const stat = (L) => { let a = 0, n1 = 0, b = 0, n0 = 0; for (let i = 0; i < ys.length; i++) if (L[i]) { a += ys[i]; n1++; } else { b += ys[i]; n0++; } return a / n1 - b / n0; };
  const obs = stat(lab); let ext = 0; const L = lab.slice();
  for (let it = 0; it < B; it++) { for (const idx of groups.values()) { for (let j = idx.length - 1; j > 0; j--) { const k = Math.floor(rnd() * (j + 1)); const a = idx[j], b = idx[k]; const t = L[a]; L[a] = L[b]; L[b] = t; } } if (Math.abs(stat(L)) >= Math.abs(obs) - 1e-12) ext++; }
  return { diff: obs, p_mc: (ext + 1) / (B + 1), B };
}
/** Mantel–Haenszel risk difference with Sato's variance */
function mhRD(rows, f, strat) {
  const S = new Map(); for (const r of rows) { const k = strat(r); if (!S.has(k)) S.set(k, { a: 0, n1: 0, c: 0, n0: 0 }); const s = S.get(k); if (r[f]) { s.n1++; s.a += r.y; } else { s.n0++; s.c += r.y; } }
  let num = 0, W = 0, P = 0, Q = 0; for (const { a, n1, c, n0 } of S.values()) { const N = n1 + n0; if (!n1 || !n0) continue; num += (a * n0 - c * n1) / N; W += n1 * n0 / N;
    P += (n1 * n1 * c - n0 * n0 * a + n1 * n0 * (n0 - n1) / 2) / (N * N); Q += (a * (n0 - c) + c * (n1 - a)) / (2 * N); }
  const rd = num / W, se = Math.sqrt((rd * P + Q) / (W * W)); return { rd, ci: [rd - z * se, rd + z * se] };
}
/** logistic regression by IRLS; returns coefficients, SE, Wald p */
function logit(X, y, names) {
  const p = X[0].length; let b = new Array(p).fill(0);
  const solve = (A, v) => { const n = v.length, M = A.map((r, i) => [...r, v[i]]); for (let i = 0; i < n; i++) { let mx = i; for (let k = i + 1; k < n; k++) if (Math.abs(M[k][i]) > Math.abs(M[mx][i])) mx = k; [M[i], M[mx]] = [M[mx], M[i]];
    for (let k = 0; k < n; k++) if (k !== i) { const f = M[k][i] / M[i][i]; for (let j = i; j <= n; j++) M[k][j] -= f * M[i][j]; } } return M.map((r, i) => r[n] / r[i]); };
  const inv = (A) => A.map((_, j) => solve(A, A.map((__, i) => (i === j ? 1 : 0)))); let H;
  for (let it = 0; it < 50; it++) { const g = new Array(p).fill(0); H = Array.from({ length: p }, () => new Array(p).fill(0));
    X.forEach((x, i) => { const eta = x.reduce((a, v, j) => a + v * b[j], 0), mu = 1 / (1 + Math.exp(-eta)), w = mu * (1 - mu); for (let j = 0; j < p; j++) { g[j] += x[j] * (y[i] - mu); for (let k = 0; k < p; k++) H[j][k] += w * x[j] * x[k]; } });
    const step = solve(H, g); b = b.map((v, j) => v + step[j]); if (Math.max(...step.map(Math.abs)) < 1e-10) break; }
  const V = inv(H); // inverse columns -> symmetric
  const erf = (x) => { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const yv = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? yv : -yv; };
  return names.map((n, j) => { const se = Math.sqrt(V[j][j]); const zz = b[j] / se; return { term: n, coef: b[j], se, or: Math.exp(b[j]), or_ci: [Math.exp(b[j] - z * se), Math.exp(b[j] + z * se)], p: 2 * (1 - 0.5 * (1 + erf(Math.abs(zz) / Math.SQRT2))) }; });
}
// ---- readout
function readout(rows) {
  const r3 = (x) => x === null ? null : +x.toFixed(3);
  const arms = Object.fromEntries(ARMS.map((a) => { const r = rows.filter((x) => x.arm === a); const v = r.filter((x) => x.y).length; const t = r.map((x) => x.tokens).filter((x) => x !== null); const g = r.map((x) => x.graded).filter((x) => x !== null);
    const c = (k) => r.reduce((s, x) => s + x[k], 0);
    return [a, { n: r.length, verified: v, rate: r3(v / r.length), wilson: wilson(v, r.length).map(r3), regressed: c('regressed'), infra_failed: r.filter((x) => x.status === 'infra_failed').length, no_change: r.filter((x) => x.status === 'no_change').length,
      settled_rate: r3(v / (v + c('regressed'))), scope_fail: c('scopeFail'), security_fail: c('secFail'), checker_fail: c('checkerFail'),
      graded_n: g.length, graded_mean: g.length ? r3(g.reduce((s, x) => s + x, 0) / g.length) : null, tokens_n: t.length, tokens_mean: t.length ? Math.round(t.reduce((s, x) => s + x, 0) / t.length) : null,
      distinct_skill_hashes: new Set(r.map((x) => x.hash)).size }]; }));
  const strat = (r) => r.lane + '|' + r.h;
  const factor = (f) => { const on = rows.filter((r) => r[f]), off = rows.filter((r) => !r[f]); const x1 = on.filter((r) => r.y).length, x0 = off.filter((r) => r.y).length;
    const reg1 = on.reduce((s, r) => s + r.regressed, 0), reg0 = off.reduce((s, r) => s + r.regressed, 0), sc1 = on.reduce((s, r) => s + r.scopeFail, 0), sc0 = off.reduce((s, r) => s + r.scopeFail, 0);
    const sec1 = on.reduce((s, r) => s + r.secFail, 0), sec0 = off.reduce((s, r) => s + r.secFail, 0);
    const tk = (g) => { const t = g.map((r) => r.tokens).filter((x) => x !== null); return { n: t.length, mean: Math.round(t.reduce((s, x) => s + x, 0) / t.length) }; };
    const t1 = tk(on), t0 = tk(off);
    return { on: `${x1}/${on.length}`, off: `${x0}/${off.length}`, rate_on: r3(x1 / on.length), rate_off: r3(x0 / off.length), diff: r3(x1 / on.length - x0 / off.length), newcombe95: newcombe(x1, on.length, x0, off.length).map(r3),
      exact_strat_perm: (({ p_two_sided, p_centered, strata }) => ({ p_two_sided: +p_two_sided.toPrecision(4), p_centered: +p_centered.toPrecision(4), strata }))(stratPerm(rows, f, strat)),
      mc_perm_4arm_labels: (({ p_mc, B }) => ({ p: +p_mc.toPrecision(4), B }))(mcPerm(rows, f, strat)),
      mh_rd_lane_holdout: (({ rd, ci }) => ({ rd: r3(rd), ci: ci.map(r3) }))(mhRD(rows, f, strat)),
      safety: { regressed_on: `${reg1}/${on.length}`, regressed_off: `${reg0}/${off.length}`, regressed_diff: r3(reg1 / on.length - reg0 / off.length), regressed_diff_ci: newcombe(reg1, on.length, reg0, off.length).map(r3),
        scope_on: `${sc1}/${on.length}`, scope_off: `${sc0}/${off.length}`, scope_diff_ci: newcombe(sc1, on.length, sc0, off.length).map(r3), security_fail_on: `${sec1}/${on.length}`, security_fail_off: `${sec0}/${off.length}` },
      tokens: { on: t1, off: t0, change: r3(t1.mean / t0.mean - 1) } }; };
  const lanes = ['exports', 'mutation', 'test-gap'], hs = ['rules', 'holdout', 'none'];
  const X = rows.map((r) => [1, r.R, r.S, r.R * r.S, r.lane === 'mutation' ? 1 : 0, r.lane === 'test-gap' ? 1 : 0, r.h === 'holdout' ? 1 : 0, r.h === 'none' ? 1 : 0]);
  const lr = logit(X, rows.map((r) => r.y), ['intercept', 'R', 'S', 'R:S', 'lane=mutation', 'lane=test-gap', 'holdout=withheld', 'holdout=rules_off']).map((t) => ({ ...t, coef: r3(t.coef), se: r3(t.se), or: r3(t.or), or_ci: t.or_ci.map(r3), p: +t.p.toPrecision(3) }));
  return { n: rows.length, arms, R: factor('R'), S: factor('S'), logistic: lr, lanes: Object.fromEntries(lanes.map((l) => [l, rows.filter((r) => r.lane === l).length])), holdout: Object.fromEntries(hs.map((h) => [h, rows.filter((r) => r.h === h).length])) };
}
function periods(rows, key) {
  const ks = [...new Set(rows.map((r) => r[key]))].sort();
  return Object.fromEntries(ks.map((k) => { const g = rows.filter((r) => r[key] === k); const cell = (f, v) => { const s = g.filter((r) => r[f] === v); return `${s.filter((r) => r.y).length}/${s.length}`; };
    const d = (f) => { const on = g.filter((r) => r[f]), off = g.filter((r) => !r[f]); if (!on.length || !off.length) return null; const x1 = on.filter((r) => r.y).length, x0 = off.filter((r) => r.y).length;
      return { on: `${x1}/${on.length}`, off: `${x0}/${off.length}`, diff: +(x1 / on.length - x0 / off.length).toFixed(3), ci: newcombe(x1, on.length, x0, off.length).map((x) => +x.toFixed(3)) }; };
    return [k, { n: g.length, arms: Object.fromEntries(ARMS.map((a) => [a, cell('arm', a)])), R: d('R'), S: d('S') }]; }));
}
{
  const cutoff = TRIGGER;
  const rows = load({ cutoff });
  const out = { dump_at: D.at, cutoff, primary: readout(rows) };
  const pk = (r) => r.lane + '|' + r.h + '|' + r.p3, fk = (r) => r.lane + '|' + r.h + '|' + r.pf;
  out.periods_registered = periods(rows, 'p3');
  out.period_term = Object.fromEntries(['R', 'S'].map((f) => { const e = stratPerm(rows, f, pk), m = mhRD(rows, f, pk), ef = stratPerm(rows, f, fk), mf = mhRD(rows, f, fk);
    return [f, { registered_periods: { p: +e.p_two_sided.toPrecision(4), mh_rd: +m.rd.toFixed(3), ci: m.ci.map((x) => +x.toFixed(3)), strata: e.strata },
      all_boundaries: { p: +ef.p_two_sided.toPrecision(4), mh_rd: +mf.rd.toFixed(3), ci: mf.ci.map((x) => +x.toFixed(3)), strata: ef.strata } }]; }));
  out.periods_fine = periods(rows, 'pf');
  // safety stop retro-check: cumulative from 20 goals per arm on
  const sorted = rows.slice().sort((a, b) => (a.t < b.t ? -1 : 1)); const cum = Object.fromEntries(ARMS.map((a) => [a, { n: 0, reg: 0 }])); let worst = { gap: -1 };
  for (const r of sorted) { cum[r.arm].n++; cum[r.arm].reg += r.regressed; if (ARMS.every((a) => cum[a].n >= 20)) for (const a of ['01', '10', '11']) { const gap = cum[a].reg / cum[a].n - cum['00'].reg / cum['00'].n; if (gap > worst.gap) worst = { gap: +gap.toFixed(3), arm: a, at: r.t, cum: JSON.parse(JSON.stringify(cum)) }; } }
  out.safety_stop_max_gap = worst;
  // sensitivities (exploratory)
  const sens = {};
  sens.all_data_to_dump = readout(load({ cutoff: D.at }));
  const set = (rs) => rs.filter((r) => r.status === 'verified' || r.status === 'regressed');
  const s1 = set(rows); sens.settled_only = { n: s1.length, R: readout(s1).R, S: readout(s1).S };
  const wf = load({ cutoff, includeOutageFallback: true }); sens.with_outage_fallback = { n: wf.length, R: readout(wf).R, S: readout(wf).S };
  const strat2 = (r) => r.lane2 + '|' + r.h; sens.lane2_strata = Object.fromEntries(['R', 'S'].map((f) => [f, +stratPerm(rows, f, strat2).p_two_sided.toPrecision(4)]));
  sens.unstratified = Object.fromEntries(['R', 'S'].map((f) => [f, +stratPerm(rows, f, () => 'all').p_two_sided.toPrecision(4)]));
  // ITT with the cancelled assigned runs (no outcome) counted as not verified
  const outRuns = new Set(D.rows.map((r) => r.task_id)); const canc = new Map();
  for (const e of D.ev) if (e.created_at >= SINCE && e.created_at <= cutoff && !outRuns.has(e.loop_run_id)) canc.set(e.loop_run_id, e);
  const extra = [...canc.values()].map((e) => { const a = JSON.parse(e.metadata).ace_001.arm; return { arm: a, R: +a[0], S: +a[1], y: 0 }; });
  const itt = [...rows, ...extra]; sens.itt_with_cancelled = { cancelled: extra.length, by_arm: extra.reduce((m, x) => (m[x.arm] = (m[x.arm] || 0) + 1, m), {}),
    R: (() => { const on = itt.filter((r) => r.R), off = itt.filter((r) => !r.R); const x1 = on.filter((r) => r.y).length, x0 = off.filter((r) => r.y).length; return { on: `${x1}/${on.length}`, off: `${x0}/${off.length}`, diff: +(x1 / on.length - x0 / off.length).toFixed(3), ci: newcombe(x1, on.length, x0, off.length).map((x) => +x.toFixed(3)) }; })(),
    S: (() => { const on = itt.filter((r) => r.S), off = itt.filter((r) => !r.S); const x1 = on.filter((r) => r.y).length, x0 = off.filter((r) => r.y).length; return { on: `${x1}/${on.length}`, off: `${x0}/${off.length}`, diff: +(x1 / on.length - x0 / off.length).toFixed(3), ci: newcombe(x1, on.length, x0, off.length).map((x) => +x.toFixed(3)) }; })() };
  out.sensitivity_exploratory = sens;
  // by lane (descriptive)
  out.by_lane = Object.fromEntries(['exports', 'mutation', 'test-gap'].map((l) => [l, periods(rows.filter((r) => r.lane === l).map((r) => ({ ...r, all: 'all' })), 'all').all]));
  out.integrity = integrity(cutoff);
  console.log(JSON.stringify(out, null, 1));
}

// ---- integrity and delivery (as registered: delivery rule from Amendment 1)
function integrity(cutoff) {
  const armOf = (g) => { const x = parseInt(createHash('sha256').update(`ace-001:${g}`).digest('hex').slice(0, 8), 16) % 4; return `${x >> 1}${x & 1}`; };
  const win = D.rows.filter((r) => r.created_at >= SINCE && r.created_at <= cutoff);
  const goals = new Set(win.map((r) => r.goal_id));
  const latest = new Map(); for (const e of D.ev) if (e.created_at >= SINCE && e.created_at <= cutoff) { const p = latest.get(e.loop_run_id); if (!p || p.created_at <= e.created_at) latest.set(e.loop_run_id, e); }
  const del = Object.fromEntries(ARMS.map((a) => [a, { runs: 0, r_treated: 0, r_delivered: 0, s_treated: 0, s_delivered: 0 }]));
  for (const e of latest.values()) { const c = JSON.parse(e.metadata).ace_001; const x = del[c.arm]; x.runs++;
    if (c.arm[0] === '1') { x.r_treated++; if (!c.fallback.includes('r')) x.r_delivered++; } if (c.arm[1] === '1') { x.s_treated++; if (!c.fallback.includes('s')) x.s_delivered++; } }
  const tot = (k) => ARMS.reduce((s, a) => s + del[a][k], 0);
  return { outcomes_in_window: win.length, distinct_goals: goals.size, one_outcome_per_goal: goals.size === win.length,
    stored_arm_vs_hash_mismatches: win.filter((r) => armOf(r.goal_id) !== r.arm).length,
    assignment_arm_vs_outcome_arm_mismatches: win.filter((r) => JSON.parse(r.assign_meta).ace_001?.arm !== r.arm).length,
    delivery: { per_arm: del, retrieval: `${tot('r_delivered')}/${tot('r_treated')}`, examples: `${tot('s_delivered')}/${tot('s_treated')}` },
    delivery_invalid_before_since: D.rows.filter((r) => r.created_at < SINCE).length,
    outage_fallback_excluded: D.rows.filter((r) => r.created_at >= SINCE && r.created_at <= cutoff && r.refs.includes('runtime_fallback')).length };
}
