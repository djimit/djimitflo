#!/usr/bin/env node
// UX-28 dashboard bundle budget (local / pre-release check, not wired into CI).
// Reads the Vite build output, finds the entry chunk that dist/index.html loads, and fails when it is larger than the
// recorded baseline + 10 %. Page code belongs in lazy route chunks (App.tsx), so the entry chunk should stay flat.
//
// Run:
//   npm run build --workspace=@djimitflo/shared && npm run build:dashboard
//   npm run budget:dashboard        (or: node scripts/dashboard-bundle-budget.mjs [--dist packages/dashboard/dist])
// Exit 0 = within budget, 1 = over budget, 2 = no build output.
// A deliberate growth: rebuild, then set BASELINE_BYTES to the printed size in the same PR and say why.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// Entry chunk after UX-28 (all pages lazy), vite build of origin/main + UX-28, 2026-10-31. Before UX-28: 363692 bytes.
const BASELINE_BYTES = 318619;
const TOLERANCE = 0.10;

const args = process.argv.slice(2);
const distArg = args.indexOf('--dist');
const dist = path.resolve(distArg >= 0 ? args[distArg + 1] : path.join(import.meta.dirname, '..', 'packages', 'dashboard', 'dist'));
const indexHtml = path.join(dist, 'index.html');
if (!fs.existsSync(indexHtml)) {
  console.error(`dashboard-bundle-budget: ${indexHtml} not found; build the dashboard first (see the header of this script).`);
  process.exit(2);
}
const entry = fs.readFileSync(indexHtml, 'utf8').match(/<script[^>]*type="module"[^>]*src="\/?([^"]+\.js)"/)?.[1];
if (!entry || !fs.existsSync(path.join(dist, entry))) {
  console.error(`dashboard-bundle-budget: no module entry script found in ${indexHtml}.`);
  process.exit(2);
}
const bytes = fs.statSync(path.join(dist, entry)).size;
const limit = Math.floor(BASELINE_BYTES * (1 + TOLERANCE));
const gzip = zlib.gzipSync(fs.readFileSync(path.join(dist, entry))).length;
const delta = (((bytes - BASELINE_BYTES) / BASELINE_BYTES) * 100).toFixed(1);
console.log(`dashboard-bundle-budget: ${entry} ${bytes} bytes (gzip ${gzip}), baseline ${BASELINE_BYTES}, limit ${limit} (+${TOLERANCE * 100} %), delta ${delta} %`);
if (bytes > limit) {
  console.error('dashboard-bundle-budget: FAIL, the entry chunk grew past the budget. Lazy-load the new page or dependency, or raise BASELINE_BYTES with a reason.');
  process.exit(1);
}
console.log('dashboard-bundle-budget: OK');
