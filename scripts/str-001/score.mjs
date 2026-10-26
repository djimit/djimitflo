#!/usr/bin/env node
// STR-001 Stage A scorer: aggregates the per-unit workstation results into docs/research/eco/str-001/results.json (raw
// per-unit results, secret-shaped strings redacted, plus the registered summary and verdict from lib.mjs summarize).
//   node scripts/str-001/score.mjs <results dir> <protocol.md> > docs/research/eco/str-001/results.json
import fs from 'node:fs';
import path from 'node:path';
import { PROTOCOL_ID, redact, sha256, summarize } from './lib.mjs';

const [dir, protocolFile] = process.argv.slice(2);
const results = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
  .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
const summary = summarize(results);
const startedAt = results.map((r) => r.started_at).filter(Boolean).sort();
const cpuMs = results.reduce((a, r) => a + (r.timings?.total_ms ?? 0), 0);
const out = {
  protocol: PROTOCOL_ID, protocol_sha256: sha256(fs.readFileSync(protocolFile, 'utf8')),
  first_unit_started_at: startedAt[0] ?? null, last_unit_started_at: startedAt.at(-1) ?? null,
  wall_hours_units: +(cpuMs / 3_600_000).toFixed(2),
  summary, units: results,
};
const { text, n } = redact(JSON.stringify(out, null, 1));
process.stdout.write(`${text}\n`);
if (n) console.error(`redacted ${n} secret-shaped strings`);
