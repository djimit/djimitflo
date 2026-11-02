#!/usr/bin/env node
// STR-001 Stage A manifest builder (protocol "Units" and "Mutant families"). Deterministic, no model, no prod access.
// Reads the MFR-001 item manifest and per-item raw results (exp/mfr-001), rebuilds each item's strengthen-retried test
// (the MFR CONTROL arm) by applying its stored diff to the original test, checks it against the stored sha256, and adds
// family (a): fresh gym-generator mutants under a new seed, disjoint from every MFR-001 mutant. It runs under tsx because
// family (a) uses the gym generator itself:
//   npx tsx scripts/str-001/build-manifest.mjs --items <mfr items.json> --raw <dir of raw MFR results> --repo <clone>
//     --out docs/research/eco/str-001/manifest.json --local <unredacted copy for the runner, never committed>
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mutate, rng as gymRng } from '../../packages/server/src/services/gym-mutants.ts';
import { K_A, MIN_A, PROTOCOL_ID, applyDescriptor, assertDisjoint, diffSize, familyA, itemOrder, redact, sha256 } from './lib.mjs';

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };

/** original + unified diff (git diff HEAD -- test) -> retried text, via git apply in a scratch directory. */
function applyDiff(original, diff, file) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'str-001-apply-'));
  try {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), original);
    fs.writeFileSync(path.join(dir, 'p.diff'), diff.endsWith('\n') ? diff : `${diff}\n`);
    execFileSync('git', ['apply', '--whitespace=nowarn', 'p.diff'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    return fs.readFileSync(path.join(dir, file), 'utf8');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

export function build(mfrItems, rawById, repo) {
  const git = (args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 });
  const units = []; const notUnits = [];
  for (const it of mfrItems) {
    const raw = rawById[it.id];
    if (!raw) throw new Error(`no raw MFR result for ${it.id}`);
    if (!raw.eligible) { notUnits.push({ id: it.id, reason: `MFR-001 pre-treatment exclusion: ${raw.exclusion}` }); continue; }
    const c = raw.runs?.control;
    if (!c || c.class === 'infra') { notUnits.push({ id: it.id, reason: 'no scored MFR-001 control run' }); continue; }
    const original = git(['show', `${it.base}:${it.target}`]);
    if (sha256(original) !== it.target_sha256) throw new Error(`${it.id}: target at base differs from the MFR manifest`);
    if (sha256(it.original_test) !== it.original_test_sha256) throw new Error(`${it.id}: original test sha256`);
    // the strengthen-retried test: only when the control retry changed exactly the test file
    let retried = null;
    const scoped = Array.isArray(c.changed) && c.changed.length > 0 && c.changed.every((f) => f === it.test);
    if (scoped && c.retried_test_diff) {
      if (c.retried_test_diff.length >= 50_000) throw new Error(`${it.id}: stored diff may be truncated`);
      retried = applyDiff(it.original_test, c.retried_test_diff, it.test);
      if (sha256(retried) !== c.retried_test_sha256) throw new Error(`${it.id}: rebuilt retried test sha256 differs from MFR-001`);
    }
    // every MFR-001 mutant of the item, rebuilt and checked
    const mfr = [];
    for (const role of ['prod', 'shown', 'held_out']) {
      for (const d of it.mutants[role]) {
        const content = applyDescriptor(original, d);
        if (content === null || sha256(content) !== d.sha256) throw new Error(`${it.id}: MFR mutant ${d.key} does not rebuild`);
        mfr.push({ role, ...d, content });
      }
    }
    const fa = familyA({ original, itemId: it.id, mutate, rngFn: gymRng, exclude: mfr.map((m) => m.content) });
    assertDisjoint(fa, mfr);
    const strip = (m) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'content'));
    units.push({
      id: it.id, base: it.base, test: it.test, target: it.target, target_sha256: it.target_sha256,
      original_test: it.original_test, original_test_sha256: it.original_test_sha256,
      mfr_control: { class: c.class, termination: c.termination, changed: c.changed, held_score: c.held_score, mfr_original_held_kill: raw.original?.held_kill ?? null },
      retried_test: retried, retried_test_sha256: retried === null ? null : sha256(retried),
      size: retried === null ? { added: 0, removed: 0, added_expects: 0 } : diffSize(c.retried_test_diff),
      mfr_mutants: mfr.map(strip),
      family_a: fa.map(strip), family_a_n: fa.length, family_a_eligible: fa.length >= MIN_A,
    });
  }
  const order = itemOrder(units.map((u) => u.id));
  units.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  return { units, notUnits };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const itemsFile = arg('--items'); const rawDir = arg('--raw');
  const mfr = JSON.parse(fs.readFileSync(itemsFile, 'utf8'));
  const rawFiles = fs.readdirSync(rawDir).filter((f) => f.endsWith('.json')).sort();
  const rawById = {}; const rawPins = {};
  for (const f of rawFiles) { const txt = fs.readFileSync(path.join(rawDir, f), 'utf8'); const r = JSON.parse(txt); rawById[r.id] = r; rawPins[r.id] = sha256(txt); }
  const { units, notUnits } = build(mfr.items, rawById, arg('--repo'));
  const head = {
    protocol: PROTOCOL_ID, k_a: K_A, min_a: MIN_A,
    built_from: { mfr_items_sha256: sha256(fs.readFileSync(itemsFile, 'utf8')), mfr_raw_result_sha256: rawPins, mfr_branch: 'exp/mfr-001' },
    n_units: units.length, not_units: notUnits,
  };
  const local = { ...head, units };
  let nRedacted = 0;
  const committed = {
    ...head,
    units: units.map((u) => {
      const o = redact(u.original_test); const r = redact(u.retried_test); nRedacted += o.n + r.n;
      return { ...u, original_test: o.text, retried_test: r.text, redacted: { original_test: o.n, retried_test: r.n } };
    }),
  };
  committed.redacted_total = nRedacted;
  fs.mkdirSync(path.dirname(arg('--out')), { recursive: true });
  fs.writeFileSync(arg('--out'), `${JSON.stringify(committed, null, 1)}\n`);
  fs.writeFileSync(arg('--local'), `${JSON.stringify(local, null, 1)}\n`);
  const fa = units.map((u) => u.family_a_n);
  console.log(`units ${units.length}, not units ${notUnits.length}, retried tests ${units.filter((u) => u.retried_test).length}, family (a) per unit min ${Math.min(...fa)} max ${Math.max(...fa)}, family (a) eligible ${units.filter((u) => u.family_a_eligible).length}, redactions ${nRedacted}`);
}
