// STE-001 registered readout at stop_by (docs/research/ace/STE-001_RESULT.md). Read-only; changes nothing.
// Prod:   docker exec -i -e NODE_PATH=/app/node_modules -w /app/packages/server djimitflo-live node --input-type=module - < STE-001_readout.mjs
//         opens /data/djimitflo.sqlite with { readonly: true } + query_only and prints the readout JSON.
// Replay: STE_DUMP=<dump.json> node STE-001_readout.mjs   (a saved { at, env, rows, ev, goals, boundaries } of the same SELECTs)
import fs from 'fs';
import { createHash } from 'crypto';

async function fetchData() {
  if (process.env.STE_DUMP) return JSON.parse(fs.readFileSync(process.env.STE_DUMP, 'utf8'));
  const { default: Sqlite } = await import('better-sqlite3');
  const d = new Sqlite('/data/djimitflo.sqlite', { readonly: true, fileMustExist: true }); d.pragma('query_only = ON');
  // every production maker outcome carrying an STE-001 arm, with its run, goal, proposal and the run's latest assignment
  const rows = d.prepare(`SELECT o.id, o.created_at, substr(r.value,13) AS arm, o.success, o.tokens_used, o.evidence_refs_json AS refs, o.task_id, o.skill_id,
    lr.goal_id, lr.status AS run_status, lr.gates_json, lr.created_at AS run_created, g.created_at AS goal_created, g.improvement_id,
    s.status AS prop_status, s.evidence_refs_json AS prop_refs,
    (SELECT e.metadata FROM loop_events e WHERE e.loop_run_id = o.task_id AND e.event_type='assignment_context' ORDER BY e.created_at DESC LIMIT 1) AS assign_meta,
    (SELECT COUNT(*) FROM worker_leases fl WHERE fl.loop_run_id = o.task_id AND json_extract(fl.metadata,'$.runtime_fallback') IS NOT NULL) AS fb_leases
    FROM skill_outcomes o, json_each(o.evidence_refs_json) r
    LEFT JOIN loop_runs lr ON lr.id = o.task_id LEFT JOIN goals g ON g.id = lr.goal_id LEFT JOIN self_improvements s ON s.id = g.improvement_id
    WHERE r.value LIKE 'ste-001-arm:%' AND o.skill_id LIKE 'loop-maker:%' AND o.skill_id NOT LIKE 'loop-maker:gym:%' ORDER BY o.created_at`).all();
  // delivery: the maker leases of those runs (recorded arm, template gene, the LOOP_WORK.md if still on disk) and the remote prompts
  const leaseQ = d.prepare(`SELECT id, runtime, status, created_at, json_extract(metadata,'$.ste_001') AS ste, json_extract(metadata,'$.genome.template') AS template,
    json_extract(metadata,'$.assignment_file') AS file, json_extract(metadata,'$.runtime_fallback') AS fb FROM worker_leases WHERE loop_run_id = ? AND role = 'maker' ORDER BY created_at`);
  const remoteQ = d.prepare('SELECT lease_id, status, instr(prompt, ?) > 0 AS ste, instr(prompt, ?) > 0 AS current FROM remote_maker_jobs WHERE loop_run_id = ?');
  for (const r of rows) {
    r.leases = leaseQ.all(r.task_id).map((l) => {
      let text = null;
      try { if (l.file && fs.existsSync(l.file)) { const t = fs.readFileSync(l.file, 'utf8'); text = { ste: t.includes(STE_LINE), current: t.includes(CURRENT_LINE) }; } } catch { /* unreadable */ }
      return { id: l.id, runtime: l.runtime, status: l.status, created_at: l.created_at, ste: l.ste ? JSON.parse(l.ste) : null, template: l.template, fb: l.fb, file_text: text };
    });
    r.remote_jobs = remoteQ.all(STE_LINE, CURRENT_LINE, r.task_id);
  }
  // every assignment that carried an STE-001 context (runs without an outcome; template hashes over time)
  const ev = d.prepare(`SELECT e.loop_run_id, e.created_at, json_extract(e.metadata,'$.ste_001') AS ste, json_extract(e.metadata,'$.ace_001.arm') AS ace, lr.goal_id, lr.status AS run_status, s.status AS prop_status
    FROM loop_events e LEFT JOIN loop_runs lr ON lr.id=e.loop_run_id LEFT JOIN goals g ON g.id=lr.goal_id LEFT JOIN self_improvements s ON s.id=g.improvement_id
    WHERE e.event_type='assignment_context' AND json_extract(e.metadata,'$.ste_001') IS NOT NULL ORDER BY e.created_at`).all();
  // the hashed population: every oracle-lane goal created in the window (is an arm imbalance from the hash or from attrition?)
  const goals = d.prepare(`SELECT g.id, g.created_at, s.evidence_refs_json AS r FROM goals g JOIN self_improvements s ON s.id = g.improvement_id
    WHERE g.created_at >= '2026-10-11' AND (s.evidence_refs_json LIKE '%"mutation-gap:%' OR s.evidence_refs_json LIKE '%"test-gap:%')`).all()
    .map((g) => ({ id: g.id, created_at: g.created_at, lane: g.r.includes('"mutation-gap:') ? 'mutation' : g.r.includes('#exports') ? 'exports' : 'test-gap' }));
  const boundaries = d.prepare("SELECT * FROM experiment_period_boundaries WHERE experiment_id = 'STE-001' ORDER BY at").all();
  return { at: new Date().toISOString(), env: { STE_001_MODE: process.env.STE_001_MODE ?? null, ACE_001_MODE: process.env.ACE_001_MODE ?? null }, rows, ev, goals, boundaries };
}
// first rule of each template (ste-001.ts MAKER_TEMPLATE_RULES_STE, loop-service.ts MAKER_TEMPLATE_RULES); a remote prompt is flattened, so no list prefix
const STE_LINE = 'Change only the files that the finding names.', CURRENT_LINE = 'Keep the diff small and local to the finding.';
const STE_TEMPLATE_HASH = '49b6259fcefa', CURRENT_TEMPLATE_HASH = 'c8483ca33a01';

const D = await fetchData();
// registered window: experiment-registry.ts STE-001 started_at .. stop_by (Amendment 1)
const SINCE = '2026-10-11T00:00:00.000Z', STOP_BY = '2026-11-14T00:00:00.000Z', TARGET = 100;
// registered period boundaries: Amendment 2 (memory rules off) and Amendment 3 (evolve siblings off)
const MEM = '2026-10-27T05:52:42Z', SIB = '2026-11-08T00:00:02Z';
// every recorded context change in the window (sensitivity only): the two above, the operator-plan maker prompt change (EXP-2_RESULT.md,
// no DB row) and the experiment_period_boundaries rows written for STE-001
const FINE = [MEM, '2026-11-05T19:58:00Z', ...D.boundaries.map((b) => b.at), SIB].sort();
const ARMS = ['0', '1'];
const lane3 = (p) => (p?.includes('"mutation-gap:') ? 'mutation' : p?.includes('#exports') ? 'exports' : p?.includes('"test-gap:') ? 'test-gap' : 'other');
const isFallback = (r) => r.refs.includes('"runtime_fallback:ollama_outage"'); // notFallbackOutcomeSql (ollama-outage-fallback.ts)

function prep(r) {
  const m = JSON.parse(r.assign_meta || '{}'); const refs = JSON.parse(r.refs); const gr = refs.find((x) => x.startsWith('graded:'));
  return { id: r.id, t: r.created_at, arm: r.arm, x: +r.arm, y: r.success ? 1 : 0, status: r.prop_status, lane: lane3(r.prop_refs), ace: m.ace_001?.arm ?? 'none',
    oos: refs.includes('gate:auto_approved_scope:fail') ? 1 : 0, // the registered out-of-scope reading (ste001Evidence)
    p3: r.created_at < MEM ? 'P1' : r.created_at < SIB ? 'P2' : 'P3', pf: 'F' + FINE.filter((b) => r.created_at >= b).length,
    tokens: typeof r.tokens_used === 'number' && r.tokens_used > 0 ? r.tokens_used : null, graded: gr ? +gr.slice(7) : null, regressed: r.prop_status === 'regressed' ? 1 : 0 };
}
/** the registered population: ste001Evidence's rows (production maker outcomes, no outage fallback) in [SINCE, STOP_BY) */
const load = ({ includeFallback = false } = {}) => D.rows.filter((r) => r.created_at >= SINCE && r.created_at < STOP_BY && (includeFallback || !isFallback(r))).map(prep);

// ---- statistics
const z = 1.959963984540054;
function wilson(x, n) { if (!n) return null; const p = x / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d; return [c - h, c + h]; }
function newcombe(x1, n1, x0, n0) { const p1 = x1 / n1, p0 = x0 / n0, [l1, u1] = wilson(x1, n1), [l0, u0] = wilson(x0, n0), d = p1 - p0;
  return [d - Math.sqrt((p1 - l1) ** 2 + (u0 - p0) ** 2), d + Math.sqrt((u1 - p1) ** 2 + (p0 - l0) ** 2)]; }
const erf = (x) => { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const v = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? v : -v; };
const pNorm2 = (zz) => 2 * (1 - 0.5 * (1 + erf(Math.abs(zz) / Math.SQRT2)));
/** two-proportion z-test, pooled variance (the protocol's first-named test) */
function twoProp(x1, n1, x0, n0) { const p = (x1 + x0) / (n1 + n0), se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n0)); const zz = se ? (x1 / n1 - x0 / n0) / se : 0; return { z: zz, p: pNorm2(zz) }; }
const lgam = (() => { const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  return (x) => { let y = x, t = x + 5.5; t -= (x + 0.5) * Math.log(t); let s = 1.000000000190015; for (const k of c) s += k / ++y; return -t + Math.log(2.5066282746310005 * s / x); }; })();
const lchoose = (n, k) => lgam(n + 1) - lgam(k + 1) - lgam(n - k + 1);
function hyper(N, M, n) { const lo = Math.max(0, n - (N - M)), hi = Math.min(n, M); const p = {}; for (let x = lo; x <= hi; x++) p[x] = Math.exp(lchoose(M, x) + lchoose(N - M, n - x) - lchoose(N, n)); return p; }
/** Fisher exact, two-sided (sum of tables no more likely than the observed one) */
function fisher(x1, n1, x0, n0) { const h = hyper(n1 + n0, x1 + x0, n1); const po = h[x1]; let p = 0; for (const v of Object.values(h)) if (v <= po * (1 + 1e-7)) p += v; return Math.min(1, p); }
/** exact stratified permutation (sum of per-stratum hypergeometrics), two-sided on the crude difference; sensitivity only */
function stratPerm(rows, strat) {
  const S = new Map(); for (const r of rows) { const k = strat(r); if (!S.has(k)) S.set(k, { N: 0, M: 0, n1: 0, x1: 0 }); const s = S.get(k); s.N++; s.M += r.y; if (r.x) { s.n1++; s.x1 += r.y; } }
  let dist = { 0: 1 };
  for (const s of S.values()) { const h = hyper(s.N, s.M, s.n1); const nd = {}; for (const [a, pa] of Object.entries(dist)) for (const [b, pb] of Object.entries(h)) { const k = +a + +b; nd[k] = (nd[k] || 0) + pa * pb; } dist = nd; }
  const N1 = [...S.values()].reduce((a, s) => a + s.n1, 0), N0 = rows.length - N1, M = rows.reduce((a, r) => a + r.y, 0), T = [...S.values()].reduce((a, s) => a + s.x1, 0);
  const Dd = (t) => t / N1 - (M - t) / N0; const dObs = Dd(T); let p = 0; for (const [t, pr] of Object.entries(dist)) if (Math.abs(Dd(+t)) >= Math.abs(dObs) - 1e-12) p += pr;
  return { p: Math.min(1, p), strata: S.size };
}
/** Mantel–Haenszel risk difference with Sato's variance */
function mhRD(rows, strat) {
  const S = new Map(); for (const r of rows) { const k = strat(r); if (!S.has(k)) S.set(k, { a: 0, n1: 0, c: 0, n0: 0 }); const s = S.get(k); if (r.x) { s.n1++; s.a += r.y; } else { s.n0++; s.c += r.y; } }
  let num = 0, W = 0, P = 0, Q = 0; for (const { a, n1, c, n0 } of S.values()) { const N = n1 + n0; if (!n1 || !n0) continue; num += (a * n0 - c * n1) / N; W += n1 * n0 / N;
    P += (n1 * n1 * c - n0 * n0 * a + n1 * n0 * (n0 - n1) / 2) / (N * N); Q += (a * (n0 - c) + c * (n1 - a)) / (2 * N); }
  const rd = num / W, se = Math.sqrt((rd * P + Q) / (W * W)); return { rd, ci: [rd - z * se, rd + z * se] };
}
const r3 = (x) => (x === null || x === undefined ? null : +x.toFixed(3));
const p4 = (x) => +x.toPrecision(4);

// ---- readout
/** one binary endpoint, STE (arm 1) vs current (arm 0): rates, Wilson, Newcombe difference, z-test and Fisher */
function contrast(rows, key) {
  const on = rows.filter((r) => r.x), off = rows.filter((r) => !r.x); const x1 = on.reduce((s, r) => s + r[key], 0), x0 = off.reduce((s, r) => s + r[key], 0);
  const t = twoProp(x1, on.length, x0, off.length);
  return { ste: `${x1}/${on.length}`, current: `${x0}/${off.length}`, rate_ste: r3(x1 / on.length), rate_current: r3(x0 / off.length),
    wilson_ste: wilson(x1, on.length).map(r3), wilson_current: wilson(x0, off.length).map(r3),
    diff_ste_minus_current: r3(x1 / on.length - x0 / off.length), newcombe95: newcombe(x1, on.length, x0, off.length).map(r3),
    z: r3(t.z), p_two_prop: p4(t.p), p_fisher: p4(fisher(x1, on.length, x0, off.length)) };
}
function readout(rows) {
  const arms = Object.fromEntries(ARMS.map((a) => { const r = rows.filter((x) => x.arm === a); const v = r.filter((x) => x.y).length; const t = r.map((x) => x.tokens).filter((x) => x !== null);
    const g = r.map((x) => x.graded).filter((x) => x !== null); const c = (k) => r.reduce((s, x) => s + x[k], 0); const st = (s) => r.filter((x) => x.status === s).length;
    return [a, { n: r.length, verified: v, rate: r3(v / r.length), wilson: wilson(v, r.length).map(r3), regressed: st('regressed'), infra_failed: st('infra_failed'), no_change: st('no_change'),
      out_of_scope: c('oos'), out_of_scope_share: r3(c('oos') / r.length), tokens_n: t.length, tokens_coverage: r3(t.length / r.length),
      tokens_mean: t.length ? Math.round(t.reduce((s, x) => s + x, 0) / t.length) : null, graded_n: g.length, graded_mean: g.length ? r3(g.reduce((s, x) => s + x, 0) / g.length) : null,
      lanes: Object.fromEntries(['exports', 'mutation', 'test-gap'].map((l) => [l, r.filter((x) => x.lane === l).length])) }]; }));
  return { n: rows.length, arms, primary_verified: contrast(rows, 'y'), out_of_scope: contrast(rows, 'oos'), regressed: contrast(rows, 'regressed'),
    tokens_change: r3(arms['1'].tokens_mean / arms['0'].tokens_mean - 1) };
}
function byGroup(rows, key) {
  return Object.fromEntries([...new Set(rows.map((r) => r[key]))].sort().map((k) => { const g = rows.filter((r) => r[key] === k); const on = g.filter((r) => r.x), off = g.filter((r) => !r.x);
    const x1 = on.filter((r) => r.y).length, x0 = off.filter((r) => r.y).length;
    return [k, { n: g.length, ste: `${x1}/${on.length}`, current: `${x0}/${off.length}`, out_of_scope_ste: `${on.reduce((s, r) => s + r.oos, 0)}/${on.length}`, out_of_scope_current: `${off.reduce((s, r) => s + r.oos, 0)}/${off.length}`,
      diff: on.length && off.length ? r3(x1 / on.length - x0 / off.length) : null, newcombe95: on.length && off.length ? newcombe(x1, on.length, x0, off.length).map(r3) : null }]; }));
}

const rows = load();
const out = { dump_at: D.at, env_at_dump: D.env, window: [SINCE, STOP_BY], target_per_arm: TARGET };
// ---- the stop rule (Amendment 1): every arm at the target by stop_by? (registered count = ste001Evidence's: fallback outcomes excluded)
const n = Object.fromEntries(ARMS.map((a) => [a, rows.filter((r) => r.arm === a).length]));
const nWithFallback = Object.fromEntries(ARMS.map((a) => [a, load({ includeFallback: true }).filter((r) => r.arm === a).length]));
const reachedAt = Object.fromEntries(ARMS.map((a) => [a, rows.filter((r) => r.arm === a)[TARGET - 1]?.t ?? null]));
// Amendment 1's own accrual reading (arm 0 = 33, arm 1 = 30 at 2026-10-18 22:33 UTC): which count did it use?
const AM1 = '2026-10-18T22:33:00Z';
const am1 = { with_fallback_excluded: Object.fromEntries(ARMS.map((a) => [a, D.rows.filter((r) => r.arm === a && r.created_at >= SINCE && r.created_at < AM1 && !isFallback(r)).length])),
  with_fallback_included: Object.fromEntries(ARMS.map((a) => [a, D.rows.filter((r) => r.arm === a && r.created_at >= SINCE && r.created_at < AM1).length])) };
out.stop_rule = { n_per_arm: n, n_per_arm_incl_outage_fallback: nWithFallback, target_reached_at: reachedAt, every_arm_at_target: ARMS.every((a) => n[a] >= TARGET),
  amendment_1_accrual_reproduced: am1, outage_fallback_excluded: D.rows.filter((r) => r.created_at >= SINCE && r.created_at < STOP_BY && isFallback(r)).map((r) => ({ arm: r.arm, at: r.created_at, prop_status: r.prop_status, success: r.success })),
  outcomes_after_stop_by: D.rows.filter((r) => r.created_at >= STOP_BY).length, before_since: D.rows.filter((r) => r.created_at < SINCE).length };
out.verdict = out.stop_rule.every_arm_at_target ? 'ANALYSE' : 'INSUFFICIENT_EVIDENCE';
// ---- descriptive readings at the n reached (no verdict follows from these under Amendment 1)
out.at_n_reached = readout(rows);
out.periods_registered = byGroup(rows, 'p3');
out.period_term = { registered: { p_exact: p4(stratPerm(rows, (r) => r.p3).p), mh_rd: r3(mhRD(rows, (r) => r.p3).rd), ci: mhRD(rows, (r) => r.p3).ci.map(r3) },
  all_boundaries: { p_exact: p4(stratPerm(rows, (r) => r.pf).p), mh_rd: r3(mhRD(rows, (r) => r.pf).rd), ci: mhRD(rows, (r) => r.pf).ci.map(r3), strata: stratPerm(rows, (r) => r.pf).strata, boundaries: FINE } };
out.periods_fine = byGroup(rows, 'pf');
out.by_lane = byGroup(rows, 'lane');
out.by_ace_arm = byGroup(rows, 'ace');
out.ace_stratified = { p_exact: p4(stratPerm(rows, (r) => r.ace).p), mh_rd: r3(mhRD(rows, (r) => r.ace).rd), ci: mhRD(rows, (r) => r.ace).ci.map(r3) };
out.lane_stratified = { p_exact: p4(stratPerm(rows, (r) => r.lane).p), mh_rd: r3(mhRD(rows, (r) => r.lane).rd), ci: mhRD(rows, (r) => r.lane).ci.map(r3) };
// ---- harm stop retro-check: from 30 per arm on, was STE ever 25 points or more below control?
{ const cum = { 0: { n: 0, v: 0 }, 1: { n: 0, v: 0 } }; let worst = { gap: Infinity };
  for (const r of rows.slice().sort((a, b) => (a.t < b.t ? -1 : 1))) { cum[r.arm].n++; cum[r.arm].v += r.y;
    if (cum[0].n >= 30 && cum[1].n >= 30) { const gap = cum[1].v / cum[1].n - cum[0].v / cum[0].n; if (gap < worst.gap) worst = { gap: r3(gap), at: r.t, cum: JSON.parse(JSON.stringify(cum)) }; } }
  out.harm_stop_min_gap = worst; }
// ---- counterfactual (not a verdict): the one outage-fallback outcome counted, which brings arm 1 to 100
{ const all = load({ includeFallback: true }); const r = readout(all); out.counterfactual_incl_fallback = { n_per_arm: nWithFallback, primary_verified: r.primary_verified, out_of_scope: r.out_of_scope }; }
// ---- ITT with assigned runs that never produced an outcome (counted not verified, not out of scope); sensitivity
{ const outRuns = new Set(D.rows.map((r) => r.task_id)); const latest = new Map();
  for (const e of D.ev) if (e.created_at >= SINCE && e.created_at < STOP_BY && !outRuns.has(e.loop_run_id)) latest.set(e.loop_run_id, e);
  const extra = [...latest.values()].map((e) => { const a = String(JSON.parse(e.ste).arm); return { arm: a, x: +a, y: 0, oos: 0 }; });
  out.itt_with_no_outcome_runs = { runs: extra.length, by_arm: extra.reduce((m, x) => ((m[x.arm] = (m[x.arm] || 0) + 1), m), {}), primary_verified: contrast([...rows, ...extra], 'y') }; }
// ---- integrity and delivery
{ const armOf = (g) => String(parseInt(createHash('sha256').update(`ste-001:${g}`).digest('hex').slice(0, 8), 16) % 2);
  const win = D.rows.filter((r) => r.created_at >= SINCE && r.created_at < STOP_BY);
  const leases = win.flatMap((r) => r.leases.map((l) => ({ ...l, arm: r.arm })));
  const recorded = leases.filter((l) => l.ste); const files = leases.filter((l) => l.file_text); const remote = win.flatMap((r) => r.remote_jobs.map((j) => ({ ...j, arm: r.arm })));
  const pop = D.goals.filter((g) => g.created_at >= SINCE && g.created_at < STOP_BY); const popArm = ARMS.map((a) => pop.filter((g) => armOf(g.id) === a).length);
  const chi = (a, b) => { const e = (a + b) / 2; const c = ((a - e) ** 2 + (b - e) ** 2) / e; return { chi2: r3(c), p: p4(1 - erf(Math.sqrt(c / 2))) }; }; // 1 df
  out.integrity = { outcomes_in_window: win.length, distinct_goals: new Set(win.map((r) => r.goal_id)).size, distinct_runs: new Set(win.map((r) => r.task_id)).size,
    stored_arm_vs_hash_mismatches: win.filter((r) => armOf(r.goal_id) !== r.arm).length,
    assignment_arm_vs_outcome_arm_mismatches: win.filter((r) => String(JSON.parse(r.assign_meta || '{}').ste_001?.arm) !== r.arm).length,
    assignment_template_hashes: [...new Set(D.ev.filter((e) => e.created_at >= SINCE && e.created_at < STOP_BY).map((e) => e.ste))],
    arm_balance_outcomes: { n: ARMS.map((a) => win.filter((r) => r.arm === a).length), ...chi(...ARMS.map((a) => win.filter((r) => r.arm === a).length)) },
    arm_balance_hashed_population: { goals: pop.length, n: popArm, ...chi(...popArm) },
    ace_cells: win.reduce((m, r) => { const k = `ste${r.arm}/ace${JSON.parse(r.assign_meta || '{}').ace_001?.arm ?? 'none'}`; m[k] = (m[k] || 0) + 1; return m; }, {}) };
  out.delivery = {
    outcome_leases_with_ste_record: `${win.filter((r) => r.leases.some((l) => l.ste && String(l.ste.arm) === r.arm)).length}/${win.length}`,
    lease_record_vs_arm: recorded.reduce((m, l) => { const k = `arm${l.arm}:lease_arm${l.ste.arm}:template_gene=${l.template === STE_TEMPLATE_HASH ? 'ste' : l.template === CURRENT_TEMPLATE_HASH ? 'current' : l.template}`; m[k] = (m[k] || 0) + 1; return m; }, {}),
    leases_without_ste_record: leases.length - recorded.length,
    loop_work_md_on_disk: files.reduce((m, l) => { const k = `arm${l.arm}:${l.file_text.ste ? 'ste' : ''}${l.file_text.current ? 'current' : ''}${!l.file_text.ste && !l.file_text.current ? 'neither' : ''}`; m[k] = (m[k] || 0) + 1; return m; }, {}),
    remote_prompts: remote.reduce((m, j) => { const k = `arm${j.arm}:${j.ste ? 'ste' : ''}${j.current ? 'current' : ''}${!j.ste && !j.current ? 'neither' : ''}`; m[k] = (m[k] || 0) + 1; return m; }, {}) };
}
console.log(JSON.stringify(out, null, 1));
