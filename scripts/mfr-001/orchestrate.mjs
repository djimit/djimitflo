#!/usr/bin/env node
// MFR-001 orchestrator, runs on the operator Mac (protocol "Procedure"). The Mac talks to both hosts; the VPS never calls
// the workstation. Per item, in the manifest's blind order and strictly one at a time:
//   1. read-only prod check: pause while any remote_maker_jobs row is queued / claimed (the GPU belongs to prod first);
//   2. copy the item to the workstation and run it there (run-item.mjs, nice 10);
//   3. copy the result back; abort on a held-out leak (exit 3) or on > 20 % infra failures among the first 10 items.
//   node scripts/mfr-001/orchestrate.mjs --items docs/research/eco/mfr-001/items.json --out <results dir> [--limit n]
// Prod reads use the established read-only probe path: a READONLY better-sqlite3 handle via `docker exec node` (the
// probe is copied in, run, removed). No experiment code runs in the prod container and nothing is written to prod.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WS = process.env.MFR_WS || 'djimit@100.81.133.48';
const VPS = process.env.MFR_VPS || 'vps-agentical';
const QUEUE_POLL_MS = 300_000;
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20, ...opts });
const log = (msg) => { const line = `${new Date().toISOString()} ${msg}`; console.log(line); if (LOG) fs.appendFileSync(LOG, `${line}\n`); };
let LOG = null;

/** One read-only probe in the prod container (same path as the L3 probes). Extra files land next to it in /tmp. */
export function prodProbe(script, extra = []) {
  const tag = `mfr001_${process.pid}_${Date.now()}`; const files = [[script, `${tag}.cjs`], ...extra.map(([src, dst]) => [src, dst])];
  for (const [src, dst] of files) if (run('scp', ['-q', src, `${VPS}:/tmp/${dst}`]).status !== 0) throw new Error(`scp ${src} failed`);
  const cp = files.map(([, dst]) => `docker cp /tmp/${dst} djimitflo-live:/tmp/${dst}`).join(' && ');
  const rm = files.map(([, dst]) => `/tmp/${dst}`).join(' ');
  const r = run('ssh', [VPS, `${cp} && docker exec -e NODE_PATH=/app/node_modules djimitflo-live node /tmp/${tag}.cjs; rc=$?; docker exec -u root djimitflo-live rm -f ${rm}; rm -f ${rm}; exit $rc`]);
  if (r.status !== 0) throw new Error(`prod probe ${path.basename(script)} failed: ${(r.stderr || '').slice(-200)}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

/** Abort rule: more than 20 % of the first 10 items failed on infrastructure (3 of 10 is already decisive). */
export const infraAbort = (results) => {
  const infra = results.slice(0, 10).filter((r) => r.exclusion === 'infra' || Object.values(r.runs ?? {}).some((x) => x?.class === 'infra')).length;
  return infra > 2 ? `${infra} of the first ${Math.min(results.length, 10)} items failed on infrastructure` : null;
};

async function main() {
  const manifest = JSON.parse(fs.readFileSync(arg('--items'), 'utf8'));
  const out = arg('--out'); fs.mkdirSync(out, { recursive: true }); LOG = path.join(out, 'orchestrator.log');
  const limit = Number(arg('--limit')) || Infinity;
  if (run('ssh', [WS, 'mkdir -p ~/mfr-001/bin ~/mfr-001/items ~/mfr-001/results']).status !== 0) throw new Error('workstation unreachable');
  for (const f of ['lib.mjs', 'run-item.mjs']) if (run('scp', ['-q', path.join(HERE, f), `${WS}:mfr-001/bin/${f}`]).status !== 0) throw new Error(`scp ${f} failed`);
  const results = []; let done = 0;
  for (const item of manifest.items) {
    if (done >= limit) break;
    const resFile = path.join(out, `${item.id}.json`);
    if (fs.existsSync(resFile)) { results.push(JSON.parse(fs.readFileSync(resFile, 'utf8'))); continue; }
    for (;;) { // yield the GPU to the production remote maker queue
      const q = prodProbe(path.join(HERE, 'prod-queue.cjs'));
      if (!q.n) break;
      log(`prod remote_maker_jobs queued/claimed = ${q.n}: pausing ${QUEUE_POLL_MS / 1000} s`);
      await new Promise((r) => setTimeout(r, QUEUE_POLL_MS));
    }
    const tmp = path.join(os.tmpdir(), `mfr-001-${item.id}.json`); fs.writeFileSync(tmp, JSON.stringify(item));
    if (run('scp', ['-q', tmp, `${WS}:mfr-001/items/${item.id}.json`]).status !== 0) throw new Error('scp item failed');
    fs.rmSync(tmp, { force: true });
    const t = Date.now(); log(`item ${results.length + 1}/${manifest.items.length} ${item.id.slice(0, 8)} start`);
    const r = run('ssh', [WS, `cd ~/mfr-001 && nice -n 10 node bin/run-item.mjs items/${item.id}.json results/${item.id}.json`], { timeout: 4 * 3600_000 });
    if (r.stdout) for (const l of r.stdout.trim().split('\n')) log(`  ${l}`);
    if (run('scp', ['-q', `${WS}:mfr-001/results/${item.id}.json`, resFile]).status !== 0) throw new Error(`no result for ${item.id}: ${(r.stderr || '').slice(-300)}`);
    const res = JSON.parse(fs.readFileSync(resFile, 'utf8')); results.push(res); done++;
    log(`item ${item.id.slice(0, 8)} done in ${Math.round((Date.now() - t) / 1000)} s: ${res.eligible ? 'scored' : `excluded (${res.exclusion})`}`);
    if (r.status === 3 || res.exclusion === 'LEAK') { log(`ABORT: held-out leak in ${item.id}`); process.exit(3); }
    if (results.length <= 10) { const why = infraAbort(results); if (why) { log(`ABORT: ${why}`); process.exit(4); } }
  }
  log(`finished: ${results.length} results`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain && process.argv.includes('--fingerprint')) {
  // zero-prod-write evidence: node orchestrate.mjs --fingerprint --items <items.json> > fingerprint-<before|after>.json
  const manifest = JSON.parse(fs.readFileSync(arg('--items'), 'utf8'));
  const ids = path.join(os.tmpdir(), `mfr-001-ids-${process.pid}.json`);
  const all = [...manifest.items, ...manifest.excluded];
  fs.writeFileSync(ids, JSON.stringify({ leases: all.map((i) => i.id), runs: manifest.items.map((i) => i.run_id) }));
  try { console.log(JSON.stringify(prodProbe(path.join(HERE, 'prod-fingerprint.cjs'), [[ids, 'mfr-001-ids.json']]))); } finally { fs.rmSync(ids, { force: true }); }
} else if (isMain) main().catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
