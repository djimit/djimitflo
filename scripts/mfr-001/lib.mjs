// MFR-001 shared helpers (docs/research/eco/MFR-001_PROTOCOL.md): arm order, the seeded shown / held-out split, mutant
// descriptors, the two retry prompts, the held-out leak check, outcome classes, the paired statistics and the decision
// rule. Zero dependencies, pure functions only: the test (packages/server/src/__tests__/mfr-001-harness.test.ts) runs
// every rule on fake data, and the runner / scorer import exactly these functions.
import { createHash } from 'node:crypto';

export const PROTOCOL_ID = 'MFR-001';
export const SPLIT_SEED = 'mfr-001/split/v1';
export const ORDER_SEED = 'mfr-001/order/v1';
export const STATS_SEED = 20261021;
export const PROD_K = 3; // gym-failure-tasks WRITE_TEST_MUTANTS: what production graded with
export const FRESH_K = 6; // fresh mutants per target beyond the production 3
export const SHOWN_K = 3;
export const HELD_K = 3;
export const MAKER_MAX_STEPS = 40; // the gym's write_test budget (scripts/gym-worker.mjs)
export const MAKER_TIMEOUT_MS = 900_000; // GYM_MAKER_TIMEOUT_MS default
export const DESC_MAX = 240;
export const N_PERM = 10_000;
export const N_BOOT = 10_000;
export const DELTA_MIN = 0.15;
export const RED_MARGIN = 0.05;
export const MIN_PER_ARM = 30;
export const ARMS = Object.freeze(['feedback', 'control']);

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** Small deterministic PRNG (mulberry32, the same generator as gym-mutants.ts rng). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const seedOf = (s) => parseInt(sha256(s).slice(0, 8), 16);

/** Arm by sha256(item id) parity: an even last hex digit = feedback. In the paired design it is the arm that runs first. */
export const armOf = (itemId) => (parseInt(sha256(String(itemId)).slice(-1), 16) % 2 === 0 ? 'feedback' : 'control');
export const armOrder = (itemId) => (armOf(itemId) === 'feedback' ? ['feedback', 'control'] : ['control', 'feedback']);
/** Blind, seeded item order (never the prod order, never by score). */
export const itemOrder = (ids) => [...ids].sort((a, b) => (sha256(`${ORDER_SEED}/${a}`) < sha256(`${ORDER_SEED}/${b}`) ? -1 : 1));

/** The one line a single-operator mutant changed: { line (1-based), before, after }, or null when not exactly one line differs. */
export function describeMutant(original, content) {
  const a = String(original).split('\n'); const b = String(content).split('\n');
  if (a.length !== b.length) return null;
  const diff = a.map((l, i) => (l === b[i] ? -1 : i)).filter((i) => i >= 0);
  return diff.length === 1 ? { line: diff[0] + 1, before: a[diff[0]], after: b[diff[0]] } : null;
}
/** The mutant content back from its descriptor; null when the descriptor does not fit the original. */
export function applyDescriptor(original, d) {
  const lines = String(original).split('\n');
  if (!d || d.line < 1 || d.line > lines.length || lines[d.line - 1] !== d.before || d.before === d.after) return null;
  lines[d.line - 1] = d.after;
  return lines.join('\n');
}

/**
 * The production mutants are the first PROD_K of targetMutants(original, runId, target, k) for any k >= PROD_K (the seed
 * loop is the same prefix). `all` = targetMutants(original, runId, target, PROD_K + FRESH_K + 3); fresh = the first
 * FRESH_K whose content differs from every production mutant. null when the target has too few mutants.
 */
export function freshMutants(all, prod) {
  const prodContent = new Set(prod.map((m) => m.content));
  if (prod.length !== PROD_K || all.slice(0, PROD_K).some((m, i) => m.content !== prod[i].content)) throw new Error('production mutants are not the prefix of the k-mutant list');
  const fresh = all.slice(PROD_K).filter((m) => !prodContent.has(m.content));
  return fresh.length >= FRESH_K ? fresh.slice(0, FRESH_K) : null;
}

/** Seeded split of the fresh mutants into shown (S) and held out (H), per item; disjoint by construction and asserted. */
export function splitMutants(fresh, itemId) {
  if (!Array.isArray(fresh) || fresh.length !== SHOWN_K + HELD_K) throw new Error(`split needs exactly ${SHOWN_K + HELD_K} fresh mutants`);
  const r = rng(seedOf(`${SPLIT_SEED}/${itemId}`)); const a = [...fresh];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  const shown = a.slice(0, SHOWN_K); const held = a.slice(SHOWN_K);
  assertDisjoint(shown, held, []);
  return { shown, held };
}
/** H is disjoint from S and from the production mutants, by key and by content. */
export function assertDisjoint(shown, held, prod) {
  const k = (m) => m.key; const c = (m) => m.content ?? `${m.line}\u0000${m.after}`;
  for (const h of held) {
    if (shown.some((s) => k(s) === k(h) || c(s) === c(h))) throw new Error(`held-out mutant ${h.key} is also shown`);
    if (prod.some((p) => k(p) === k(h) || c(p) === c(h))) throw new Error(`held-out mutant ${h.key} is a production mutant`);
  }
  return true;
}

const clip = (s) => { const t = String(s).trim().replace(/\s+/g, ' '); return t.length > DESC_MAX ? `${t.slice(0, DESC_MAX)}...` : t; };
/** How a shown mutant is described to the maker: file, line, mutation. */
export const renderMutant = (target, d) => `${target} line ${d.line}: \`${clip(d.before)}\` was changed to \`${clip(d.after)}\``;
export const oneLine = (text) => String(text).replace(/\s*\n+\s*/g, ' ').replace(/[ \t]{2,}/g, ' ').trim();

/** The control prompt; feedback = the same text plus the surviving shown mutants (so the only difference is the mutant list). */
export function buildPrompt({ test, target, arm, survivors = [] }) {
  if (!ARMS.includes(arm)) throw new Error(`unknown arm ${arm}`);
  const rel = String(test).replace(/^packages\/server\//, '');
  const base = `Retry of a test-writing task: the vitest test file ${test} already exists and covers ${target}, but it is too weak: a subtly broken ${target} can still pass it. `
    + `Edit ${test} so that it still passes against the real ${target} and fails when ${target} is subtly broken. Keep importing ${target} with a relative import, do not mock it, skip nothing, `
    + `and make it pass with: cd packages/server && npx vitest run ${rel}. Change only ${test}; do not edit ${target} or any other file. Strengthen the assertions of this test.`;
  if (arm === 'control' || !survivors.length) return oneLine(base);
  const list = survivors.map((d, i) => `(${i + 1}) ${renderMutant(target, d)}`).join('; ');
  return oneLine(`${base} These seeded mutants of ${target} were NOT caught: the current test still passes with each of them in place. Add assertions so that the test fails for each of them: ${list}.`);
}

/**
 * Leak check (protocol: abort on any hit). A held-out mutant leaks when the exact maker input carries its key, its rendered
 * description, or its mutated line text outside the shown descriptions (identical lines elsewhere in the target can make
 * a shown mutation read the same; that text is then the shown mutant's, not the held-out one's).
 */
export function findLeaks(prompt, held, { target, shown = [] } = {}) {
  let residual = String(prompt);
  for (const s of shown) residual = residual.split(renderMutant(target, s)).join(' ');
  const hits = [];
  for (const h of held) {
    if (h.key && String(prompt).includes(h.key)) hits.push({ key: h.key, via: 'key' });
    else if (String(prompt).includes(renderMutant(target, h))) hits.push({ key: h.key, via: 'description' });
    else if (clip(h.after).length >= 3 && residual.includes(clip(h.after))) hits.push({ key: h.key, via: 'mutated_line' });
  }
  return hits;
}
export function assertNoLeak(prompt, held, opts) {
  const hits = findLeaks(prompt, held, opts);
  if (hits.length) { const e = new Error(`MFR-001 LEAK: held-out mutant(s) in the maker prompt: ${hits.map((h) => `${h.key} (${h.via})`).join(', ')}`); e.code = 'MFR_LEAK'; throw e; }
  return true;
}

/** Files a maker changed, with the gym worker's exclusions (scripts/gym-worker.mjs changedFrom). */
export const changedFrom = (diffNames, untracked) => [...String(diffNames).split('\n'), ...String(untracked).split('\n')]
  .filter((f) => f && !f.startsWith('.djimitflo/') && f !== 'package-lock.json' && !f.startsWith('.atomic'));

/**
 * Outcome class of one retry, in precedence order. Only `ok` is scored by its held-out kills; every other class scores 0
 * (never a pass) except `infra`, which is excluded and counted for the abort rule.
 *   infra | timeout (maker timed out, no change) | no_change | out_of_scope | baseline_red (retried test red or hung on the
 *   real target) | ok
 */
export function classify({ infra = false, termination = null, changed = [], test, baseline = null }) {
  if (infra) return 'infra';
  if (!changed.length) return termination === 'timeout' ? 'timeout' : 'no_change';
  if (!changed.every((f) => f === test)) return 'out_of_scope';
  if (baseline !== 'pass') return 'baseline_red';
  return 'ok';
}
/** Held-out kill share of one retry (the primary per-run value). */
export function heldScore(cls, heldRuns) {
  if (cls !== 'ok') return 0;
  if (!Array.isArray(heldRuns) || heldRuns.length !== HELD_K) throw new Error('ok needs one run per held-out mutant');
  return heldRuns.filter((r) => r !== 'pass').length / HELD_K; // red or hung on a mutant = killed (graded-fitness counts fail)
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const round = (x, d = 4) => (Number.isFinite(x) ? +x.toFixed(d) : null);
const quantile = (sorted, q) => { const i = (sorted.length - 1) * q; const lo = Math.floor(i); const hi = Math.ceil(i); return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo); };

/** Paired: d_i = F_i - C_i. One-sided sign-flip permutation p (H1: mean d > 0) and a seeded percentile bootstrap 95 % CI. */
export function pairedStats(pairs, { nPerm = N_PERM, nBoot = N_BOOT, seed = STATS_SEED } = {}) {
  const d = pairs.map((p) => p.feedback - p.control); const n = d.length;
  if (!n) return { n: 0, delta: null, ci: [null, null], p: null };
  const obs = mean(d); const r = rng(seed); let ge = 0;
  for (let k = 0; k < nPerm; k++) { let s = 0; for (const x of d) s += r() < 0.5 ? -x : x; if (s / n >= obs - 1e-12) ge++; }
  const r2 = rng(seed + 1); const boots = [];
  for (let k = 0; k < nBoot; k++) { let s = 0; for (let i = 0; i < n; i++) s += d[Math.floor(r2() * n)]; boots.push(s / n); }
  boots.sort((a, b) => a - b);
  return { n, delta: round(obs), ci: [round(quantile(boots, 0.025)), round(quantile(boots, 0.975))], p: round((ge + 1) / (nPerm + 1)) };
}
/** Between-item (the operator's parity design, secondary): label permutation p (one-sided) and a stratified bootstrap CI. */
export function unpairedStats(f, c, { nPerm = N_PERM, nBoot = N_BOOT, seed = STATS_SEED } = {}) {
  if (!f.length || !c.length) return { n_feedback: f.length, n_control: c.length, delta: null, ci: [null, null], p: null };
  const obs = mean(f) - mean(c); const all = [...f, ...c]; const r = rng(seed + 2); let ge = 0;
  for (let k = 0; k < nPerm; k++) {
    const a = [...all]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    if (mean(a.slice(0, f.length)) - mean(a.slice(f.length)) >= obs - 1e-12) ge++;
  }
  const r2 = rng(seed + 3); const boots = []; const pick = (xs) => xs[Math.floor(r2() * xs.length)];
  for (let k = 0; k < nBoot; k++) boots.push(mean(f.map(() => pick(f))) - mean(c.map(() => pick(c))));
  boots.sort((a, b) => a - b);
  return { n_feedback: f.length, n_control: c.length, delta: round(obs), ci: [round(quantile(boots, 0.025)), round(quantile(boots, 0.975))], p: round((ge + 1) / (nPerm + 1)) };
}

/** Pre-registered decision rule. */
export function decide({ delta, ci, redFeedback, redControl, nFeedback, nControl }) {
  const acceptance = nFeedback >= MIN_PER_ARM && nControl >= MIN_PER_ARM;
  if (delta === null || !ci || ci[0] === null) return { verdict: 'INCONCLUSIVE', acceptance, reason: 'no scored pairs' };
  if (delta >= DELTA_MIN && ci[0] > 0 && redFeedback <= redControl + RED_MARGIN) return { verdict: 'SUPPORTED', acceptance, reason: `delta ${delta} >= ${DELTA_MIN}, CI lower ${ci[0]} > 0, baseline-red ${redFeedback} <= ${redControl} + ${RED_MARGIN}` };
  if (ci[1] < DELTA_MIN) return { verdict: 'FALSIFIED', acceptance, reason: `CI upper ${ci[1]} < ${DELTA_MIN}` };
  return { verdict: 'INCONCLUSIVE', acceptance, reason: `neither rule holds (delta ${delta}, CI [${ci[0]}, ${ci[1]}], baseline-red F ${redFeedback} vs C ${redControl})` };
}

/** Aggregate per-item results into the registered endpoint, secondaries and the verdict. */
export function summarize(results, opts = {}) {
  const scored = results.filter((r) => r.eligible && r.runs && ARMS.every((a) => r.runs[a] && r.runs[a].class !== 'infra'));
  const classes = Object.fromEntries(ARMS.map((a) => [a, {}]));
  for (const r of scored) for (const a of ARMS) classes[a][r.runs[a].class] = (classes[a][r.runs[a].class] ?? 0) + 1;
  const red = (a) => (scored.length ? round(scored.filter((r) => r.runs[a].class === 'baseline_red').length / scored.length) : null);
  const pairs = scored.map((r) => ({ feedback: r.runs.feedback.held_score, control: r.runs.control.held_score }));
  const paired = pairedStats(pairs, opts);
  const meanArm = (a) => round(mean(scored.map((r) => r.runs[a].held_score)));
  const parityF = scored.filter((r) => armOf(r.id) === 'feedback').map((r) => r.runs.feedback.held_score);
  const parityC = scored.filter((r) => armOf(r.id) === 'control').map((r) => r.runs.control.held_score);
  const decision = decide({ delta: paired.delta, ci: paired.ci, redFeedback: red('feedback'), redControl: red('control'), nFeedback: scored.length, nControl: scored.length });
  return {
    n_items: results.length, n_eligible: results.filter((r) => r.eligible).length, n_scored_pairs: scored.length,
    excluded: results.filter((r) => !r.eligible).reduce((o, r) => ({ ...o, [r.exclusion ?? 'unknown']: (o[r.exclusion ?? 'unknown'] ?? 0) + 1 }), {}),
    infra_runs: results.reduce((n, r) => n + ARMS.filter((a) => r.runs?.[a]?.class === 'infra').length, 0),
    classes, mean_held: { feedback: meanArm('feedback'), control: meanArm('control') },
    baseline_red_rate: { feedback: red('feedback'), control: red('control') },
    paired, parity_between_items: unpairedStats(parityF, parityC, opts), decision,
  };
}
