#!/usr/bin/env node
// STR-001 Stage A driver, WORKSTATION ONLY. Runs every unit of the (unredacted, local) manifest in manifest order, one at a
// time, each in its own niced child process; a unit with a result file is skipped, so the driver can be restarted.
//   setsid nohup nice -n 10 node run-all.mjs <manifest.local.json> <results dir> > run-all.log 2>&1 &
// Stop rule (protocol): abort when >= 3 of the first 10 units end as infra. No prod, no VPS, no model endpoint.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const [manifestFile, outDir] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
fs.mkdirSync(outDir, { recursive: true });
const log = (s) => console.log(`${new Date().toISOString()} ${s}`);
let infra = 0;
for (const [i, u] of manifest.units.entries()) {
  const out = path.join(outDir, `${u.id}.json`);
  if (fs.existsSync(out)) { log(`unit ${i + 1}/${manifest.units.length} ${u.id.slice(0, 8)} done already`); continue; }
  log(`unit ${i + 1}/${manifest.units.length} ${u.id.slice(0, 8)} start`);
  const r = spawnSync('nice', ['-n', '10', process.execPath, path.join(here, 'run-item.mjs'), manifestFile, u.id, out], { stdio: 'inherit', timeout: 6 * 3600_000 });
  const res = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : { exclusion: 'infra' };
  if (res.exclusion === 'infra') infra++;
  log(`unit ${i + 1} ${u.id.slice(0, 8)} end: exit ${r.status}, ${res.eligible ? `eligible, strengthen ${res.strengthen?.class}` : `excluded ${res.exclusion}`}, ${Math.round((res.timings?.total_ms ?? 0) / 1000)} s`);
  if (i < 10 && infra >= 3) { log('STOP: >= 3 infra units among the first 10 (protocol stop rule)'); process.exit(2); }
}
log('all units done');
