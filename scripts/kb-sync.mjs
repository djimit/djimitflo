#!/usr/bin/env node
// Plan L2: push changed DjimitKBWiki pages to Djimitflo (POST /api/gym-worker/kb, same host token as the gym worker).
// Only pages the server accepted are remembered, so rejected/failed ones are retried next run. A page the server stored
// without a safety verdict (NVIDIA 429/timeout: 'pending') is remembered as pending and re-sent, and so is every page the
// server still lists as unverdicted (GET /kb/pending, also the backfill for pages marked done before 'pending' existed);
// at most --pending-max re-sends per run, so the daily sync does not burst NVIDIA's free tier.
//   node kb-sync.mjs [--dry-run] [--max 300] [--pending-max 50]
// env: DJIMITFLO_URL (http://100.86.47.122:3001), GYM_HOST (workstation), GYM_WORKER_TOKEN_FILE (~/.djimit/gym-worker.token),
//      KB_ROOT (~/djimit/DjimitKBWiki/wiki), KB_DIRS (concepts,entities,summaries)
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const num = (name, fallback) => (args.includes(name) ? Number(args[args.indexOf(name) + 1]) : NaN) || fallback;
const max = num('--max', 300);
const pendingMax = Math.min(num('--pending-max', 50), 200);
const home = homedir();
const url = (process.env.DJIMITFLO_URL || 'http://100.86.47.122:3001').replace(/\/$/, '');
const host = process.env.GYM_HOST || 'workstation';
const root = process.env.KB_ROOT || join(home, 'djimit/DjimitKBWiki/wiki');
const dirs = (process.env.KB_DIRS || 'concepts,entities,summaries').split(',');
const stateFile = join(home, '.djimit/kb-sync.state.json');
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};

const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : n.endsWith('.md') ? [p] : []; });
const changed = []; const recheck = []; const done = new Map();
for (const d of dirs) {
  if (!existsSync(join(root, d))) continue;
  for (const file of walk(join(root, d))) {
    const body = readFileSync(file, 'utf8');
    const sha = createHash('sha256').update(body.slice(0, 20_000)).digest('hex');
    const path = relative(root, file);
    const page = () => ({ path, title: (body.match(/^#\s+(.+)$/m)?.[1] || path).trim(), body: body.slice(0, 20_000), sha });
    if (state[path] === sha) done.set(path, page);
    else if (state[path] === `pending:${sha}`) recheck.push(page());
    else changed.push(page());
  }
}
console.log(`${changed.length} changed page(s), sending up to ${max}; ${recheck.length} pending safety re-check(s) known locally${dry ? ' (dry run)' : ''}`);
if (dry) process.exit(0);

const token = readFileSync(process.env.GYM_WORKER_TOKEN_FILE || join(home, '.djimit/gym-worker.token'), 'utf8').trim();
const headers = { 'Content-Type': 'application/json', 'X-Gym-Host': host, 'X-Gym-Worker-Token': token };
try {
  const res = await fetch(`${url}/api/gym-worker/kb/pending?limit=${pendingMax}`, { headers, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const r = await res.json();
  for (const p of r.pending ?? []) if (done.has(p) && !recheck.some((x) => x.path === p)) recheck.push(done.get(p)());
  console.log(`server: ${r.total ?? 'unknown'} page(s) without a safety verdict`);
} catch (error) { console.error(`pending list unavailable (${error.message}); re-sending only locally pending pages`); }
const pending = [...changed.slice(0, max), ...recheck.slice(0, pendingMax)];
let sent = 0; let failedBatches = 0; const totals = { accepted: 0, pending: 0, unsafe: 0, failed: 0 };
for (let i = 0; i < pending.length && failedBatches < 3; i += 10) {
  const batch = pending.slice(i, i + 10);
  try {
    const res = await fetch(`${url}/api/gym-worker/kb`, {
      method: 'POST', signal: AbortSignal.timeout(600_000), // server-side 429 backoff can take minutes per batch
      headers,
      body: JSON.stringify({ pages: batch.map(({ path, title, body }) => ({ path, title, body })) }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const r = await res.json();
    const stored = r.pending ?? []; // stored without a safety verdict: not done, re-sent next run
    for (const p of batch) if (r.accepted.includes(p.path)) state[p.path] = p.sha; else if (stored.includes(p.path)) state[p.path] = `pending:${p.sha}`;
    totals.accepted += r.accepted.length; totals.pending += stored.length; totals.unsafe += r.unsafe.length; totals.failed += r.failed.length;
    sent += batch.length; failedBatches = r.accepted.length || stored.length ? 0 : failedBatches + 1;
  } catch (error) { failedBatches += 1; console.error(`batch at ${i} failed: ${error.message}`); }
  writeFileSync(stateFile, JSON.stringify(state));
}
console.log(`sent ${sent}: ${JSON.stringify(totals)}`);
