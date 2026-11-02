/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS: runs as a bare `node` probe in the prod container */
// MFR-001 zero-prod-write evidence (READONLY handle): the rows this experiment could have touched, before and after.
// /tmp/mfr-001-ids.json = { leases: [...], runs: [...] } (copied next to this script by the orchestrator).
const D = require('better-sqlite3'); const crypto = require('crypto'); const fs = require('fs');
const d = new D('/data/djimitflo.sqlite', { readonly: true });
const { leases, runs } = JSON.parse(fs.readFileSync('/tmp/mfr-001-ids.json', 'utf8'));
const ids = [...leases, ...runs]; const ph = ids.map(() => '?').join(',');
const fp = (rows) => ({ n: rows.length, sha256: crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex') });
console.log(JSON.stringify({
  at: new Date().toISOString(),
  worker_leases: fp(d.prepare(`select id, status, updated_at, metadata from worker_leases where id in (${leases.map(() => '?').join(',')}) order by id`).all(...leases)),
  skill_outcomes: fp(d.prepare(`select id, success, created_at, evidence_refs_json from skill_outcomes where task_id in (${ph}) or ${leases.map(() => 'evidence_refs_json like ?').join(' or ')} order by id`).all(...ids, ...leases.map((l) => `%${l}%`))),
  judgments: fp(d.prepare(`select id, decision, created_at from judgments where subject_id in (${ph}) order by id`).all(...ids)),
  totals: Object.fromEntries(['worker_leases', 'skill_outcomes', 'judgments', 'remote_maker_jobs'].map((t) => [t, d.prepare(`select count(*) n from ${t}`).get().n])),
}));
