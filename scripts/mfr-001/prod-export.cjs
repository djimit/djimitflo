/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS: runs as a bare `node` probe in the prod container */
// MFR-001 read-only prod export (protocol "Items"): every 30-d exports-lane maker lease with a graded score < 1.
// Runs as `node` in the prod container against a READONLY better-sqlite3 handle (no write is possible); prints JSON.
const D = require('better-sqlite3'); const d = new D('/data/djimitflo.sqlite', { readonly: true });
const rows = d.prepare(`select w.id lease_id, w.loop_run_id run_id, w.created_at, coalesce(json_extract(w.metadata,'$.effective_runtime'), w.runtime) runtime,
  json_extract(w.metadata,'$.model_id') model, json_extract(w.metadata,'$.graded') graded, json_extract(w.metadata,'$.diff') diff, json_extract(w.metadata,'$.diff_sha256') diff_sha256,
  json_extract(w.metadata,'$.diff_truncated') diff_truncated, json_extract(w.metadata,'$.diff_redacted') diff_redacted, json_extract(w.metadata,'$.changed_files') changed_files,
  json_extract(r.metadata,'$.pr_url') pr_url, json_extract(r.metadata,'$.verified_head_sha') verified_head_sha, r.status run_status,
  json_extract(s.grounding_json,'$.artifactPath') artifact, json_extract(s.grounding_json,'$.target') target, s.id proposal_id
  from worker_leases w join loop_runs r on r.id = w.loop_run_id left join goals g on g.id = r.goal_id left join self_improvements s on s.id = g.improvement_id
  where w.role = 'maker' and json_extract(w.metadata,'$.graded.lane') = 'exports' and json_extract(w.metadata,'$.graded.score') < 1
    and w.created_at > datetime('now','-30 days') order by w.created_at`).all();
for (const r of rows) { r.graded = JSON.parse(r.graded); try { r.changed_files = JSON.parse(r.changed_files); } catch { /* keep text */ } }
console.log(JSON.stringify(rows));
