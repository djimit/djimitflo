#!/usr/bin/env node
/*
 * DI-001 P3: discovery relevance benchmark (docs/research/di-001/relevance/PREREG.md). READ-ONLY.
 * Opens the database with better-sqlite3 {readonly: true}; no network, no inference, no embedding call.
 * Run on prod inside the container:
 *   docker cp relevance-bench.cjs djimitflo-live:/tmp/x.js
 *   docker exec -e NODE_PATH=/app/node_modules djimitflo-live node /tmp/x.js > results.json
 *   docker exec -u root djimitflo-live rm -f /tmp/x.js
 * DB path: DB_PATH env, default /data/djimitflo.sqlite.
 */
const crypto = require('crypto');
const SCOPE = new Set(['djimitflo-scout', 'operator-chatgpt']);
const RELEVANT = new Set(['open_problem', 'lane_technique']);
const POS_STATES = new Set(['CHECKED', 'APPROVED', 'ACTIVE']);
const NEG_STATES = new Set(['REJECTED', 'REVOKED']);
const AUTOMATED = /^(ingestion:|model-review:|codex:|system|loop:|agent:|claude|opencode|hermes|scheduler)/i;
const SEED = 20261014; const B = 2000;

// ---- stats helpers
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function wilson(k, n) { if (!n) return { k, n, p: null, lo: null, hi: null }; const z = 1.959964, p = k / n, d = 1 + z * z / n; const c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d; return { k, n, p: +p.toFixed(4), lo: +Math.max(0, c - h).toFixed(4), hi: +Math.min(1, c + h).toFixed(4) }; }
const pct = (xs, q) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
function bootstrap(groups, stat) { // groups: array of arrays of items; resample groups
  const rnd = mulberry32(SEED); const vals = [];
  for (let b = 0; b < B; b++) { const pick = []; for (let i = 0; i < groups.length; i++) pick.push(...groups[Math.floor(rnd() * groups.length)]); const v = stat(pick); if (v !== null && Number.isFinite(v)) vals.push(v); }
  return vals.length ? { lo: +pct(vals, 0.025).toFixed(4), hi: +pct(vals, 0.975).toFixed(4), b: vals.length } : null;
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
function isoWeek(iso) { const d = new Date(iso); const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day); const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1)); return `${t.getUTCFullYear()}-W${String(Math.ceil(((t - y) / 86400000 + 1) / 7)).padStart(2, '0')}`; }

const round4 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? null : +x.toFixed(4));

// ---- L2 (PREREG amendment 2): the #835 labelling UI writes one judgments row per (ref, pass), mode 'operator_label',
// state_hash 'discovery_relevance', answers_json {label, pass: 'first'|'relabel', sample, actor, seconds, ...}.
// Only pass 'first' is a label. 'relabel' rows are used solely for the consistency statistic, paired with the same ref's
// first label; they never replace or override it. A row without a recognised pass is ignored (counted).
const L2_VALUE = { relevant: 'positive', not_relevant: 'negative', unclear: 'unclear', yes: 'positive', no: 'negative' };
function parseL2(rows) { // rows ordered by created_at, rowid
  const first = new Map(); const relabel = new Map(); const ignored = [];
  for (const r of rows) {
    let a = {}; try { a = JSON.parse(r.answers_json || '{}') || {}; } catch { a = {}; }
    const target = a.pass === 'first' ? first : a.pass === 'relabel' ? relabel : null;
    if (!target) { ignored.push(r.subject_id); continue; }
    if (target.has(r.subject_id)) continue; // the earliest row per (ref, pass) wins; #835 refuses a changed answer anyway
    target.set(r.subject_id, { ref: r.subject_id, value: L2_VALUE[a.label] || L2_VALUE[r.decision] || 'unclear', at: r.created_at,
      actor: a.actor || null, sample: a.sample || null, seconds: a.seconds ?? null });
  }
  return { first, relabel, ignored };
}

/** Verification of one ref from its independent facts (PREREG §2): L2 first-pass over L1; L3 only adds positives. */
function verifyRef({ l1Event = null, l2First = null, l3Hit = false }) {
  const lab = [];
  if (l1Event && POS_STATES.has(l1Event.to_state)) lab.push(['L1', 'positive', l1Event.created_at]);
  if (l1Event && NEG_STATES.has(l1Event.to_state)) lab.push(['L1', 'negative', l1Event.created_at]);
  if (l2First) lab.push(['L2', l2First.value, l2First.at]);
  if (l3Hit) lab.push(['L3', 'positive', null]);
  // AL labels (sample 'al') are training labels: kept on the record, never in an evaluation number (PREREG §6a)
  const use = l2First && l2First.sample === 'al' ? 'training' : 'evaluation';
  const l2pick = lab.find((x) => x[0] === 'L2' && x[1] !== 'unclear');
  const vals = new Set(lab.filter((x) => x[1] !== 'unclear').map((x) => x[1]));
  if (l2pick && !(vals.size > 1 && lab.some((x) => x[0] === 'L3'))) return { label: l2pick[1], source: 'L2', session: String(l2pick[2]).slice(0, 10), use };
  if (vals.size > 1) return { label: 'conflict', source: lab.map((x) => x[0]).join('+'), session: null, use };
  if (vals.size === 1) { const f = lab.find((x) => x[1] !== 'unclear'); return { label: f[1], source: lab.map((x) => x[0]).join('+'), session: f[2] ? String(f[2]).slice(0, 10) : 'L3', use }; }
  if (lab.length) return { label: 'unclear', source: lab.map((x) => x[0]).join('+'), session: null, use };
  return { label: 'unlabelled', source: null, session: null, use };
}

function cohenKappa(pairs) {
  const n = pairs.length; if (!n) return null;
  const cats = [...new Set(pairs.flat())];
  const po = pairs.filter(([a, b]) => a === b).length / n;
  let pe = 0; for (const c of cats) pe += (pairs.filter((p) => p[0] === c).length / n) * (pairs.filter((p) => p[1] === c).length / n);
  return pe === 1 ? null : (po - pe) / (1 - pe);
}

/**
 * Agreement between each ref's first label and its re-label (PREREG §6b, amendment 1). Same actor on both passes =
 * intra-annotator consistency (test-retest), never presented as inter-annotator agreement. Different actors =
 * inter-annotator agreement. An actor missing on either side = annotator_unknown (reported, never called inter).
 */
function consistency(first, relabel) {
  const buckets = { intra_annotator_consistency: [], inter_annotator_agreement: [], annotator_unknown: [] }; const unpaired = [];
  for (const [ref, r] of relabel) {
    const f = first.get(ref); if (!f) { unpaired.push(ref); continue; }
    const k = !f.actor || !r.actor ? 'annotator_unknown' : f.actor === r.actor ? 'intra_annotator_consistency' : 'inter_annotator_agreement';
    buckets[k].push([f.value, r.value]);
  }
  const stat = (x) => {
    if (!x.length) return { n: 0 };
    const bin = x.filter(([a, b]) => a !== 'unclear' && b !== 'unclear'); const confusion = {};
    for (const [a, b] of x) confusion[`${a}->${b}`] = (confusion[`${a}->${b}`] || 0) + 1;
    return { n: x.length, raw_agreement: wilson(x.filter(([a, b]) => a === b).length, x.length), kappa: round4(cohenKappa(x)),
      kappa_ci: bootstrap(x.map((p) => [p]), (s) => cohenKappa(s)), n_binary: bin.length, kappa_binary: round4(cohenKappa(bin)), confusion };
  };
  return { ...Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, stat(v)])), relabels_without_first: unpaired,
    note: 'intra_annotator_consistency is one annotator re-labelling blind; it is not inter-annotator agreement' };
}

function main() {
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || '/data/djimitflo.sqlite', { readonly: true, fileMustExist: true });
const all = (sql, ...a) => db.prepare(sql).all(...a);
const snapshot_at = new Date().toISOString();
// ---- population: distinct discovery refs
const refs = new Map();
for (const r of all(`SELECT json_extract(payload,'$.ref') ref, COALESCE(json_extract(payload,'$.agent'), source) src, event_type, occurred_at FROM external_events
  WHERE event_type LIKE 'discovery.%' AND occurred_at <= ? ORDER BY occurred_at`, snapshot_at)) {
  if (!r.ref) continue;
  // Deviation 1 (BENCHMARK §Deviations): a ref sent by several sources is in scope if any sender is; its source is the
  // first in-scope sender, else the first sender.
  const d = refs.get(r.ref);
  if (d) { d.senders.add(r.src); if (!SCOPE.has(d.src) && SCOPE.has(r.src)) d.src = r.src; continue; }
  refs.set(r.ref, { ref: r.ref, src: r.src, senders: new Set([r.src]), kind: r.event_type.slice(10), at: r.occurred_at });
}
// Deviation 2: Djimitflo's own repository is not a discovery whose use can be verified (every change "cites" it)
const SELF_REFS = new Set(['github:djimit/djimitflo']);
// ---- admission: units by alias
const unitByRef = new Map(); const unitById = new Map();
for (const u of all(`SELECT e.id, e.lifecycle_state, e.aliases_json, json_extract(e.provenance_json,'$.source') usrc,
  (SELECT COUNT(*) FROM expert_capabilities c WHERE c.expert_id = e.id AND c.derived_by LIKE 'source-units:%') caps,
  (SELECT json_extract(v.metadata_json,'$.derived') FROM expert_evidence v WHERE v.expert_id = e.id LIMIT 1) derived
  FROM expert_identities e WHERE e.kind IN ('paper','repository')`)) {
  unitById.set(u.id, u);
  for (const a of JSON.parse(u.aliases_json)) unitByRef.set(a, u);
}
// ---- classification C: first non-error jev row per ref (or per its unit)
const jevBy = new Map(); const jevErr = new Map();
for (const j of all(`SELECT subject_type, subject_id, decision, created_at, latency_ms, input_tokens, output_tokens,
  json_extract(answers_json,'$.relevance.choice') cls, json_extract(answers_json,'$.relevance.confidence') conf
  FROM judgments WHERE judgment = 'discovery_relevance' AND created_at <= ? ORDER BY created_at, rowid`, snapshot_at)) {
  const key = unitById.has(j.subject_id) ? JSON.parse(unitById.get(j.subject_id).aliases_json)[0] : j.subject_id;
  if (j.decision === 'error') { jevErr.set(key, (jevErr.get(key) || 0) + 1); continue; }
  if (!jevBy.has(key)) jevBy.set(key, j);
}
// ---- verification L1 / L2 / L3
const human = (actor) => !!actor && !AUTOMATED.test(actor) && /@/.test(actor);
const l1 = new Map();
for (const e of all(`SELECT expert_id, to_state, actor, created_at FROM expert_lifecycle_events WHERE created_at <= ? ORDER BY created_at, rowid`, snapshot_at.replace('T', ' ').slice(0, 19))) {
  if (!unitById.has(e.expert_id) || !human(e.actor)) continue;
  l1.set(e.expert_id, e); // latest human event wins
}
const l2 = parseL2(all(`SELECT subject_id, decision, answers_json, created_at FROM judgments WHERE mode IN ('operator_label','annotation')
  AND (judgment = 'discovery_relevance' OR state_hash = 'discovery_relevance') AND created_at <= ? ORDER BY created_at, rowid`, snapshot_at));
// L3: verified self_improvements (and their goals / runs) citing a ref, unit id or claim id
const claimToUnit = new Map(all(`SELECT c.id, c.expert_id FROM expert_claims c JOIN expert_identities e ON e.id = c.expert_id WHERE e.kind IN ('paper','repository')`).map((r) => [r.id, r.expert_id]));
const keyToRef = new Map();
for (const [ref, u] of unitByRef) { keyToRef.set(ref.toLowerCase(), ref); keyToRef.set(u.id.toLowerCase(), ref); const m = /^(arxiv|github):(.+)$/i.exec(ref); if (m) keyToRef.set(m[2].toLowerCase(), ref); }
for (const ref of refs.keys()) { keyToRef.set(ref.toLowerCase(), ref); const m = /^(arxiv|github):(.+)$/i.exec(ref); if (m) keyToRef.set(m[2].toLowerCase(), ref); }
for (const [cid, uid] of claimToUnit) { const u = unitById.get(uid); if (u) keyToRef.set(cid.toLowerCase(), JSON.parse(u.aliases_json)[0]); }
const TOK = /\b\d{4}\.\d{4,5}\b|github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+|(?:arxiv|github):[^\s"',\]]+|(?:expert:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
function cited(text) { const out = new Set(); for (const t of (String(text || '').toLowerCase().match(TOK) || [])) { const k = t.replace(/^github\.com\//, '').replace(/\.git$/, ''); const r = keyToRef.get(k) || keyToRef.get('expert:' + k); if (r) out.add(r); } return out; }
const l3 = new Map(); let siScanned = 0;
for (const s of all(`SELECT s.id, s.title, s.description, s.rationale, s.evidence_refs_json, s.grounding_json,
  (SELECT group_concat(g.objective || ' ' || COALESCE(g.metadata,''), ' ') FROM goals g WHERE g.improvement_id = s.id) gtxt,
  (SELECT group_concat(COALESCE(r.metadata,'') || ' ' || COALESCE(r.findings_json,''), ' ') FROM loop_runs r JOIN goals g ON g.id = r.goal_id WHERE g.improvement_id = s.id) rtxt
  FROM self_improvements s WHERE s.status = 'verified' AND s.created_at <= ?`, snapshot_at)) {
  siScanned++;
  for (const r of cited([s.title, s.description, s.rationale, s.evidence_refs_json, s.grounding_json, s.gtxt, s.rtxt].join(' '))) l3.set(r, s.id);
}
// ---- per-ref record with the three states
const recs = [];
for (const d of refs.values()) {
  const u = unitByRef.get(d.ref) || null; const j = jevBy.get(d.ref) || null;
  const inScope = [...d.senders].some((s) => SCOPE.has(s));
  // A
  let A;
  if (!inScope) A = 'reject';
  else if (j && j.subject_type === 'discovery_rejected') A = 'reject';
  else if (j && j.subject_type === 'discovery_pending') A = 'admit';
  else if (u && u.derived === 'taxonomy_override:jev') A = 'reject';
  else if (u && u.caps > 0) A = 'admit';
  else if (u) A = 'reject';
  else A = 'abstain';
  const C = !j ? 'abstain' : j.decision === 'yes' ? 'admit' : j.decision === 'no' ? 'reject' : 'abstain';
  const Cs = !j ? 'abstain' : j.decision === 'yes' ? 'admit' : 'reject';
  const D = A !== 'admit' ? A : (j && j.decision === 'no' ? 'reject' : 'admit');
  const p = j && j.conf !== null && j.cls ? (RELEVANT.has(j.cls) ? j.conf : 1 - j.conf) : null;
  // verification
  const verification = verifyRef({ l1Event: (u && l1.get(u.id)) || null, l2First: l2.first.get(d.ref) || (u && l2.first.get(u.id)) || null,
    l3Hit: l3.has(d.ref) && !SELF_REFS.has(d.ref) });
  recs.push({ ref: d.ref, src: d.src, senders: d.senders, kind: d.kind, at: d.at, week: isoWeek(d.at), in_scope: inScope,
    classification: { A, B: 'not_computable', C, C_star: Cs, D, jev: j ? { decision: j.decision, cls: j.cls, conf: j.conf, p, subject_type: j.subject_type } : null, jev_errors: jevErr.get(d.ref) || 0 },
    admission: u ? { unit: u.id, derived: u.derived, lifecycle_state: u.lifecycle_state, usrc: u.usrc } : null,
    verification });
}
const primary = recs.filter((r) => r.in_scope);
const labelled = (set) => set.filter((r) => (r.verification.label === 'positive' || r.verification.label === 'negative') && r.verification.use === 'evaluation');
const LAB = labelled(primary); const LAB_ALL = labelled(recs);

// ---- metrics
const CANDS = ['A', 'B', 'C', 'C_star', 'D'];
const W = { fa: 3, fr: 1 }; const GRID = []; for (const fa of [1, 3, 10]) for (const fr of [0.5, 1, 2, 5]) GRID.push({ fa, fr });
const loss = (items, c, w) => { const s = items.filter((r) => ['admit', 'reject'].includes(r.classification[c])); if (!s.length) return null; return s.reduce((a, r) => a + (r.classification[c] === 'admit' && r.verification.label === 'negative' ? w.fa : 0) + (r.classification[c] === 'reject' && r.verification.label === 'positive' ? w.fr : 0), 0) / s.length; };
const sessions = (items) => { const m = new Map(); for (const r of items) { const k = r.verification.session || 'none'; if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return [...m.values()]; };
function score(items, c) {
  const n = { tp: 0, fp: 0, fn: 0, tn: 0, abstain: 0, not_computable: 0 };
  for (const r of items) { const k = r.classification[c]; const pos = r.verification.label === 'positive';
    if (k === 'not_computable') n.not_computable++; else if (k === 'abstain') n.abstain++; else if (k === 'admit') pos ? n.tp++ : n.fp++; else pos ? n.fn++ : n.tn++; }
  const covered = n.tp + n.fp + n.fn + n.tn;
  if (!covered) return { counts: n, status: n.not_computable ? 'NOT_COMPUTABLE' : 'NO_COVERAGE' };
  const out = { counts: n, coverage: wilson(covered, items.length), precision: wilson(n.tp, n.tp + n.fp), recall_within_labelled: wilson(n.tp, n.tp + n.fn),
    loss_default: +loss(items, c, W).toFixed(4),
    loss_ci_session_bootstrap: bootstrap(sessions(items), (s) => loss(s, c, W)),
    loss_ci_item_bootstrap: bootstrap(items.map((r) => [r]), (s) => loss(s, c, W)),
    loss_grid: GRID.map((w) => ({ ...w, loss: +loss(items, c, w).toFixed(4) })),
    downstream_verified_yield: wilson(items.filter((r) => r.classification[c] === 'admit' && r.verification.source && r.verification.source.includes('L3')).length, n.tp + n.fp) };
  if (c === 'C' || c === 'C_star') { const ps = items.filter((r) => r.classification.jev && r.classification.jev.p !== null); out.brier = ps.length ? { n: ps.length, brier: +(ps.reduce((a, r) => a + (r.classification.jev.p - (r.verification.label === 'positive' ? 1 : 0)) ** 2, 0) / ps.length).toFixed(4), ci_item: bootstrap(ps.map((r) => [r]), (s) => s.reduce((a, r) => a + (r.classification.jev.p - (r.verification.label === 'positive' ? 1 : 0)) ** 2, 0) / s.length), ece: ps.length >= 50 ? 'computed only when n >= 50' : 'n < 50: not computed (PREREG §4)' } : null; }
  return out;
}
function evaluable(items, x, y) {
  const pos = items.filter((r) => r.verification.label === 'positive').length, neg = items.length - pos;
  const bySrc = {}; for (const r of items) bySrc[r.src] = (bySrc[r.src] || 0) + 1;
  const srcOk = Object.values(bySrc).filter((n) => n >= 10).length;
  const dis = items.filter((r) => ['admit', 'reject'].includes(r.classification[x]) && ['admit', 'reject'].includes(r.classification[y]) && r.classification[x] !== r.classification[y]).length;
  const why = []; if (items.length < 50) why.push(`n=${items.length}<50`); if (pos < 10) why.push(`positives=${pos}<10`); if (neg < 10) why.push(`negatives=${neg}<10`); if (srcOk < 2) why.push(`sources_with_10=${srcOk}<2`); if (dis < 10) why.push(`disagreements=${dis}<10`);
  for (const c of [x, y]) if (items.every((r) => r.classification[c] === 'not_computable')) why.push(`${c} NOT_COMPUTABLE`);
  return { x, y, disagreements: dis, verdict: why.length ? 'INSUFFICIENT' : 'EVALUABLE', why };
}
const dist = (items, f) => { const m = {}; for (const r of items) { const k = f(r); m[k] = (m[k] || 0) + 1; } return m; };

// ---- label-free population numbers, disagreement psi, N_eval
const popDecisions = Object.fromEntries(CANDS.map((c) => [c, dist(primary, (r) => r.classification[c])]));
const both = primary.filter((r) => ['admit', 'reject'].includes(r.classification.A) && ['admit', 'reject'].includes(r.classification.C_star));
const psi = both.filter((r) => r.classification.A !== r.classification.C_star).length / (both.length || 1);
const delta = 0.10;
const nMcNemar = (ps, dl) => Math.pow(1.959964 * Math.sqrt(ps) + 0.841621 * Math.sqrt(Math.max(ps - dl * dl, 0)), 2) / (dl * dl);
let N_eval = Math.min(400, Math.max(100, Math.ceil(nMcNemar(psi, delta) / 10) * 10));
// protected evaluation sample: source x ISO week, proportional, min 3 per non-empty cell, sha256 order within cell
const cells = new Map(); for (const r of primary) { const k = `${r.src}|${r.week}`; if (!cells.has(k)) cells.set(k, []); cells.get(k).push(r); }
const alloc = [...cells.entries()].map(([k, rs]) => ({ k, rs, n: Math.min(rs.length, Math.max(3, Math.round(N_eval * rs.length / primary.length))) }));
let over = alloc.reduce((a, c) => a + c.n, 0) - N_eval; // trim largest cells until the total is N_eval
while (over > 0) { const big = alloc.filter((c) => c.n > 3).sort((a, b) => b.n - a.n)[0]; if (!big) break; big.n--; over--; }
while (over < 0) { const room = alloc.filter((c) => c.n < c.rs.length).sort((a, b) => b.rs.length / (b.n + 1) - a.rs.length / (a.n + 1))[0]; if (!room) break; room.n++; over++; }
const evalSample = alloc.flatMap((c) => c.rs.map((r) => ({ ref: r.ref, src: r.src, week: r.week, h: sha(r.ref + 'di001-relevance-eval') })).sort((a, b) => a.h < b.h ? -1 : 1).slice(0, c.n)).map(({ ref, src, week }) => ({ ref, src, week })).sort((a, b) => a.ref < b.ref ? -1 : 1);
const evalSet = new Set(evalSample.map((r) => r.ref));
const outside = primary.filter((r) => !evalSet.has(r.ref));
const alPool = dist(outside, (r) => `A:${r.classification.A}|jev:${r.classification.jev ? r.classification.jev.decision : 'unjudged'}`);

// ---- cost / latency (C)
const jrows = all(`SELECT decision, latency_ms, COALESCE(input_tokens,0) + COALESCE(output_tokens,0) tok FROM judgments WHERE judgment = 'discovery_relevance' AND created_at <= ?`, snapshot_at);
const ok = jrows.filter((r) => r.decision !== 'error'); const lat = ok.map((r) => r.latency_ms).filter((x) => x !== null);
const cost = { calls: jrows.length, errors: jrows.length - ok.length, error_rate: wilson(jrows.length - ok.length, jrows.length), tokens_total: jrows.reduce((a, r) => a + r.tok, 0),
  tokens_per_ok_call: ok.length ? Math.round(ok.reduce((a, r) => a + r.tok, 0) / ok.length) : null, latency_ms: { n: lat.length, p50: pct(lat, 0.5), p95: pct(lat, 0.95) } };

const ser = (r) => ({ ref: r.ref, src: r.src, senders: [...r.senders], kind: r.kind, at: r.at, classification: r.classification, admission: r.admission, verification: r.verification });
const result = {
  protocol: 'docs/research/di-001/relevance/PREREG.md', snapshot_at, scope: [...SCOPE],
  population: { refs_all: recs.length, refs_primary: primary.length, by_source: dist(recs, (r) => r.src), primary_decisions_label_free: popDecisions,
    admitted_units_primary: primary.filter((r) => r.admission).length },
  labels: { L1_human_units_any_kind: l1.size, L2_first_pass: l2.first.size, L2_relabel_pass: l2.relabel.size, L2_ignored_no_pass: l2.ignored.length,
    L2_training_only: recs.filter((r) => r.verification.use === 'training').length, L3_cited_refs_raw: [...l3.entries()].map(([ref, si]) => ({ ref, si, excluded: SELF_REFS.has(ref) ? "self repository (deviation 2)" : null })), verified_self_improvements_scanned: siScanned,
    labelled_primary: LAB.length, labelled_all_sources: LAB_ALL.length, by_label: dist(LAB, (r) => r.verification.label), by_source: dist(LAB, (r) => r.src),
    by_session: dist(LAB, (r) => r.verification.session), conflicts: recs.filter((r) => r.verification.label === 'conflict').map((r) => r.ref),
    labelled_items: LAB_ALL.map(ser) },
  representativeness: {
    source: { labelled: dist(LAB, (r) => r.src), population: dist(primary, (r) => r.src) },
    jev_decision: { labelled: dist(LAB, (r) => r.classification.jev ? r.classification.jev.decision : 'unjudged'), population: dist(primary, (r) => r.classification.jev ? r.classification.jev.decision : 'unjudged') },
    A: { labelled: dist(LAB, (r) => r.classification.A), population: dist(primary, (r) => r.classification.A) },
    admission: { labelled: dist(LAB, (r) => r.admission ? 'unit' : 'no_unit'), population: dist(primary, (r) => r.admission ? 'unit' : 'no_unit') },
    kind: { labelled: dist(LAB, (r) => r.kind), population: dist(primary, (r) => r.kind) },
  },
  scores_primary: Object.fromEntries(CANDS.map((c) => [c, score(LAB, c)])),
  comparisons: [['A', 'C'], ['A', 'C_star'], ['A', 'D'], ['C_star', 'D'], ['A', 'B'], ['B', 'C_star']].map(([x, y]) => evaluable(LAB, x, y)),
  label_consistency: consistency(l2.first, l2.relabel),
  cost_C: cost,
  plan: { delta, alpha: 0.05, power: 0.8, psi_A_vs_Cstar: +psi.toFixed(4), psi_n: both.length, n_mcnemar_raw: Math.ceil(nMcNemar(psi, delta)), N_eval,
    overlap_relabel: Math.ceil(N_eval * 0.2), eval_cells: alloc.length, active_learning_pool_outside_eval: alPool },
  eval_sample: evalSample,
};
process.stdout.write(JSON.stringify(result, null, 1) + '\n');
}

if (require.main === module) main();
module.exports = { parseL2, verifyRef, consistency, cohenKappa };
