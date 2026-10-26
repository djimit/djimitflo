#!/usr/bin/env node
// STR-001 Stage A post-hoc analyses. They are NOT registered; they were added after scoring had started, and they do not
// change the verdict. There are two:
//   1. timeout sensitivity;
//   2. a coverage-vs-assertion decomposition of the Stryker gain.
//
// 1. Timeout sensitivity.
// Why: the registered rule counts a hung mutant run as killed. That is the MFR-001 convention, and Stryker's Timeout
// counts as detected, as in scripts/mutation-gain.mjs. Production graded-fitness.ts (mutantKill) works differently: there
// a timeout is a skip reason and never a score.
//
// The primary rule stays as registered. This script reports three variants:
//   V1 per-mutant exclusion: a mutant that timed out under either test of the pair is left out of that unit's denominator;
//   V2 prod-like (family (a) only): a unit with any timed-out gym run, original or retried, is left out;
//   plus the timeout counts per arm and family.
//
// 2. Stryker status transitions, original -> strengthen, over the `ok` units. Each newly killed mutant was either
//    NoCoverage before (the retry now runs code the original test never reached: more coverage) or Survived before (the
//    code was already covered and the new assertions now catch it: stronger assertions). Lost kills are counted too.
//
//   node scripts/str-001/posthoc.mjs <results dir>   (JSON on stdout)
import fs from 'node:fs';
import path from 'node:path';
import { holm, pairedSummary, round } from './lib.mjs';

const dir = process.argv[2];
const results = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
const elig = results.filter((r) => r.eligible);
const isT = { gym: (s) => s === 'timeout', stryker: (s) => s === 'Timeout' };
const isKill = { gym: (s) => s !== 'pass', stryker: (s) => s === 'Killed' || s === 'Timeout' };

/** Per-unit [original, retried|null] outcome pairs of one family (ITT units only; family exclusions skipped). */
function pairs(r, fam) {
  if (fam === 'gym') {
    if (!r.families.gym || r.families.gym.excluded) return null;
    const o = r.original.gym_runs; const s = r.strengthen.class === 'ok' ? r.strengthen.gym_runs : null;
    return o.map((x, i) => [x, s ? s[i] : null]);
  }
  const f = r.families.stryker;
  if (!f || f.excluded || !f.statuses) return null;
  if (r.strengthen.class === 'ok' && f.strengthen === null) return null; // infra on the retried run: dropped, as registered
  return Object.values(f.statuses);
}

const counts = {}; const variants = {};
for (const fam of ['stryker', 'gym']) {
  let tO = 0; let tS = 0; let nO = 0; let nS = 0; const v1 = []; const v2 = [];
  for (const r of elig) {
    const p = pairs(r, fam); if (!p) continue;
    for (const [o, s] of p) { nO++; if (isT[fam](o)) tO++; if (s !== null) { nS++; if (isT[fam](s)) tS++; } }
    const ok = r.strengthen.class === 'ok';
    const keep = p.filter(([o, s]) => !isT[fam](o) && !(s !== null && isT[fam](s)));
    if (keep.length) {
      v1.push({ original: keep.filter(([o]) => isKill[fam](o)).length / keep.length, strengthen: ok ? keep.filter(([, s]) => isKill[fam](s)).length / keep.length : 0 });
    }
    if (fam === 'gym' && !p.some(([o, s]) => isT.gym(o) || (s !== null && isT.gym(s)))) {
      v2.push({ original: p.filter(([o]) => isKill.gym(o)).length / p.length, strengthen: ok ? p.filter(([, s]) => isKill.gym(s)).length / p.length : 0 });
    }
  }
  counts[fam] = { mutant_runs_original: nO, timeouts_original: tO, mutant_runs_strengthen: nS, timeouts_strengthen: tS, timeout_share_original: nO ? round(tO / nO) : null, timeout_share_strengthen: nS ? round(tS / nS) : null };
  variants[fam] = { v1_per_mutant_exclusion: pairedSummary(v1, { seed: 20261031 }) };
  if (fam === 'gym') variants[fam].v2_prod_like_unit_skip = pairedSummary(v2, { seed: 20261032 });
}
const [pb, pa] = holm([variants.stryker.v1_per_mutant_exclusion.sign.p, variants.gym.v1_per_mutant_exclusion.sign.p]);
variants.stryker.v1_per_mutant_exclusion.p_holm = pb; variants.gym.v1_per_mutant_exclusion.p_holm = pa;
const baselineTimeouts = {
  original: results.filter((r) => r.original?.baseline === 'timeout').length,
  strengthen: elig.filter((r) => r.strengthen?.baseline === 'timeout').length,
};
const tr = {}; let killedBefore = 0; let validMutants = 0;
for (const r of elig) {
  const f = r.families.stryker;
  if (r.strengthen.class !== 'ok' || !f?.statuses || f.strengthen === null) continue;
  for (const [o, s] of Object.values(f.statuses)) {
    validMutants++; if (isKill.stryker(o)) killedBefore++;
    const k = `${o}->${s}`; tr[k] = (tr[k] ?? 0) + 1;
  }
}
const sum = (pred) => Object.entries(tr).filter(([k]) => pred(...k.split('->'))).reduce((a, [, v]) => a + v, 0);
const gainedFromNoCoverage = sum((o, s) => o === 'NoCoverage' && isKill.stryker(s));
const gainedFromSurvived = sum((o, s) => o === 'Survived' && isKill.stryker(s));
const lost = sum((o, s) => isKill.stryker(o) && !isKill.stryker(s));
const transitions = {
  units: elig.filter((r) => r.strengthen.class === 'ok').length, mutants: validMutants, killed_by_original: killedBefore,
  gained_from_nocoverage: gainedFromNoCoverage, gained_from_survived: gainedFromSurvived, lost,
  share_of_gain_from_new_coverage: gainedFromNoCoverage + gainedFromSurvived ? round(gainedFromNoCoverage / (gainedFromNoCoverage + gainedFromSurvived)) : null,
  table: tr,
};
process.stdout.write(`${JSON.stringify({ registered: false, added_after_scoring_started: true, timeout_counts: counts, baseline_timeouts: baselineTimeouts, variants, stryker_transitions_ok_units: transitions }, null, 1)}\n`);
