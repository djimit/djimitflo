#!/usr/bin/env node
// MFR-001 item builder (protocol "Items" and "Mutants"). Deterministic, no model, no prod access: reads the read-only prod
// export (prod-export.cjs output) and a local clone of djimit/djimitflo with the maker PR heads fetched, and writes the item
// manifest. Mutants come from the production generator itself, so it runs under tsx:
//   npx tsx scripts/mfr-001/build-items.mjs --prod <prod-items.json> --repo <clone> --out docs/research/eco/mfr-001/items.json
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { targetMutants } from '../../packages/server/src/services/gym-failure-tasks.ts';
import { PROD_K, FRESH_K, assertDisjoint, describeMutant, freshMutants, itemOrder, sha256, splitMutants } from './lib.mjs';

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const TEST = /^packages\/server\/src\/__tests__\/[\w.-]+\.test\.ts$/;
const TARGET = /^packages\/server\/src\/services\/[\w-]+\.ts$/;

/** Added lines of a unified diff that creates exactly one new file `file`; null otherwise. */
export function newFileFromDiff(diff, file) {
  const files = [...String(diff).matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)].map((m) => m[2]);
  if (files.length !== 1 || files[0] !== file || !/^new file mode/m.test(diff)) return null;
  const body = String(diff).split('\n'); const start = body.findIndex((l) => l.startsWith('@@'));
  if (start < 0) return null;
  const lines = body.slice(start + 1).filter((l) => !l.startsWith('\\ No newline'));
  if (lines.some((l) => l && !l.startsWith('+'))) return null;
  const text = lines.filter((l) => l.startsWith('+')).map((l) => l.slice(1)).join('\n');
  return /\\ No newline at end of file/.test(diff) ? text : `${text}\n`;
}

function build(prodItems, repo) {
  const git = (args) => { try { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }); } catch { return null; } };
  const items = []; const excluded = [];
  for (const p of prodItems) {
    const id = p.lease_id; const ex = (reason, extra = {}) => excluded.push({ id, reason, ...extra });
    if (!(p.graded?.score < 1) || p.graded?.kind !== 'mutant_kill' || p.graded?.lane !== 'exports' || p.graded?.total !== PROD_K) { ex('not a graded exports item with score < 1 and 3 mutants'); continue; }
    const test = p.artifact; const target = p.target;
    if (!TEST.test(test ?? '') || !TARGET.test(target ?? '')) { ex('artifact / target outside the lane pattern'); continue; }
    // source 1: the loop's own commit for this lease (draft PR), earliest committer date = the maker's commit
    const commits = (git(['log', '--all', '--format=%H %P %ct', '--grep', `maker lease ${id}`]) ?? '').trim().split('\n').filter(Boolean)
      .map((l) => l.split(' ')).map(([h, parent, ct]) => ({ h, parent, ct: Number(ct) })).sort((a, b) => a.ct - b.ct);
    let base = null; let testContent = null; let pin = null; let source = null;
    if (commits.length) {
      const c = commits[0];
      const names = (git(['diff', '--name-only', c.parent, c.h]) ?? '').trim().split('\n').filter(Boolean);
      if (names.length !== 1 || names[0] !== test) { ex('maker commit changes more than the test file', { files: names }); continue; }
      base = c.parent; testContent = git(['show', `${c.h}:${test}`]);
      const rebuilt = git(['diff', c.parent, c.h, '--', test]) ?? '';
      pin = { sha256: sha256(rebuilt), source: `git diff ${c.parent.slice(0, 12)} ${c.h.slice(0, 12)} -- ${test}`, commit: c.h, pr_url: p.pr_url ?? null };
      source = 'maker_commit';
      if (p.diff) {
        const fromMeta = newFileFromDiff(p.diff, test);
        pin.metadata_diff_sha256 = p.diff_sha256; pin.metadata_diff_matches = fromMeta !== null && fromMeta === testContent;
      }
    } else if (p.diff && !p.diff_truncated) {
      // source 2: lease metadata.diff (MAKER_DIFF_CAPTURE), base = the newest main commit at or before the lease
      testContent = newFileFromDiff(p.diff, test);
      if (testContent === null) { ex('metadata.diff is not a single new test file'); continue; }
      base = (git(['rev-list', '-1', '--first-parent', `--before=${p.created_at}`, 'refs/heads/main']) ?? '').trim() || null;
      pin = { sha256: p.diff_sha256, source: 'lease metadata.diff', recomputed_sha256: sha256(p.diff) };
      source = 'metadata_diff';
    } else { ex('no stored diff and no maker commit'); continue; }
    if (!base || testContent === null) { ex('base commit or test content not found'); continue; }
    const original = git(['show', `${base}:${target}`]);
    if (original === null) { ex('target missing at base'); continue; }
    // production graded with targetMutants(<target in the maker worktree>, runId, target) (graded-fitness.ts)
    const prod = targetMutants(original, p.run_id, target, PROD_K);
    const fresh = freshMutants(targetMutants(original, p.run_id, target, PROD_K + FRESH_K + 3), prod);
    if (!fresh) { ex(`fewer than ${FRESH_K} fresh mutants`); continue; }
    const { shown, held } = splitMutants(fresh, id);
    assertDisjoint(shown, held, prod);
    const desc = (m) => { const d = describeMutant(original, m.content); if (!d) throw new Error(`${m.key}: not a single-line mutant`); return { key: m.key, ...d, sha256: sha256(m.content) }; };
    items.push({
      id, run_id: p.run_id, created_at: p.created_at, runtime: p.runtime, model: p.model ?? null,
      prod_graded: p.graded, source, pin, base, test, target, target_sha256: sha256(original),
      original_test: testContent, original_test_sha256: sha256(testContent),
      mutants: { prod: prod.map(desc), shown: shown.map(desc), held_out: held.map(desc) },
    });
  }
  const order = itemOrder(items.map((i) => i.id));
  items.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  return { items, excluded };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const prodItems = JSON.parse(fs.readFileSync(arg('--prod'), 'utf8'));
  const { items, excluded } = build(prodItems, arg('--repo'));
  const out = { protocol: 'MFR-001', built_from: { prod_export_sha256: sha256(fs.readFileSync(arg('--prod'), 'utf8')), prod_rows: prodItems.length }, n_items: items.length, excluded, items };
  fs.mkdirSync(path.dirname(arg('--out')), { recursive: true });
  fs.writeFileSync(arg('--out'), `${JSON.stringify(out, null, 1)}\n`);
  console.log(`items ${items.length}, excluded ${excluded.length}: ${JSON.stringify(excluded.reduce((o, e) => ({ ...o, [e.reason]: (o[e.reason] ?? 0) + 1 }), {}))}`);
}
