// ASG-001 macro-frequency evidence (NOT RUN in the ASG-001 session: prod reads were not authorised).
// Operator run (read-only, aggregate counts only, no tool input text is printed):
//   scp docs/research/asg-001/trace-mine.js vps-agentical:/tmp/ && ssh vps-agentical 'docker cp /tmp/trace-mine.js djimitflo-live:/tmp/ && docker exec -e NODE_PATH=/app/node_modules djimitflo-live node /tmp/trace-mine.js 2026-09-24T00:00:00Z'
// It reports, per oracle lane, how often each classified maker action and each 2-/3-step procedure occurs (support = leases).
const Database = require('better-sqlite3');
const db = new Database('/data/djimitflo.sqlite', { readonly: true, fileMustExist: true });
const since = process.argv[2] || '2026-09-24T00:00:00Z';
const rows = db.prepare(`SELECT l.id AS lease, l.status AS lease_status, l.runtime AS runtime, e.tool_name AS tool, e.tool_input AS input, e.created_at AS at,
    CASE WHEN s.evidence_refs_json LIKE '%"mutation-gap:%' THEN 'mutation' WHEN s.evidence_refs_json LIKE '%"test-gap:%' THEN 'test-gap' ELSE NULL END AS lane
  FROM execution_events e JOIN tasks t ON t.id = e.task_id
  JOIN worker_leases l ON l.id = json_extract(t.metadata, '$.lease_id')
  JOIN loop_runs r ON r.id = l.loop_run_id
  LEFT JOIN goals g ON g.id = r.goal_id LEFT JOIN self_improvements s ON s.id = g.improvement_id
  WHERE e.event_type = 'tool.call' AND l.role = 'maker' AND e.created_at >= ?
  ORDER BY l.id, e.created_at, e.rowid`).all(since);
function cls(tool, input) {
  let i = {}; try { i = typeof input === 'string' ? JSON.parse(input || '{}') : (input || {}); } catch { i = {}; }
  const t = String(tool || '').toLowerCase();
  if (t !== 'bash') {
    const p = String(i.filePath || i.path || i.file_path || '');
    const isTest = /(__tests__\/|\.test\.|\.spec\.)/.test(p);
    if (t === 'read') return isTest ? 'read:test' : 'read:src';
    if (t === 'write') return isTest ? 'write:test' : 'write:other';
    if (t === 'edit') return isTest ? 'edit:test' : 'edit:other';
    return t || 'unknown';
  }
  const c = String(i.command || '');
  if (/stryker|test:mutation/.test(c)) return 'bash:mutation';
  if (/npm (ci|install|rebuild|install-scripts)|apt-get|which make|node-gyp/.test(c)) return 'bash:env';
  if (/(build:shared|packages\/shared && npm run build|--workspace=@djimitflo\/shared)/.test(c)) return 'bash:shared_build';
  if (/vitest|npm (run )?test|test:changed/.test(c)) return /\.test\.|__tests__/.test(c) ? 'bash:test_targeted' : 'bash:test_broad';
  if (/\btsc\b|type-check/.test(c)) return 'bash:typecheck';
  if (/\beslint\b|\blint\b/.test(c)) return 'bash:lint';
  if (/^\s*git\b/.test(c)) return 'bash:git';
  if (/^\s*(cat|ls|head|tail|sed -n|grep|rg|find|wc)\b/.test(c)) return 'bash:inspect';
  return 'bash:other';
}
const byLease = new Map();
for (const r of rows) {
  if (!r.lane) continue;
  const k = r.lease; if (!byLease.has(k)) byLease.set(k, { lane: r.lane, status: r.lease_status, runtime: r.runtime, seq: [] });
  byLease.get(k).seq.push(cls(r.tool, r.input));
}
const out = { since, generated_at: new Date().toISOString(), leases: 0, by_lane: {}, by_status: {}, action_counts: {}, leases_with_action: {}, bigrams: {}, trigrams: {},
  targeted_test_runs_per_lease: [], targeted_test_after_last_edit_passes_unknown: 'pass/fail of tool results not read' };
for (const [, v] of byLease) {
  out.leases++; out.by_lane[v.lane] = (out.by_lane[v.lane] || 0) + 1; out.by_status[v.status] = (out.by_status[v.status] || 0) + 1;
  const seen = new Set();
  // collapse immediate repeats so n-grams measure procedure shape, not loops
  const s = v.seq.filter((a, i) => i === 0 || a !== v.seq[i - 1]);
  for (const a of v.seq) { out.action_counts[a] = (out.action_counts[a] || 0) + 1; seen.add(a); }
  for (const a of seen) out.leases_with_action[a] = (out.leases_with_action[a] || 0) + 1;
  const seenBi = new Set(); const seenTri = new Set();
  for (let i = 0; i + 1 < s.length; i++) seenBi.add(s[i] + ' > ' + s[i + 1]);
  for (let i = 0; i + 2 < s.length; i++) seenTri.add(s[i] + ' > ' + s[i + 1] + ' > ' + s[i + 2]);
  for (const b of seenBi) out.bigrams[b] = (out.bigrams[b] || 0) + 1;   // leases containing the bigram (support)
  for (const b of seenTri) out.trigrams[b] = (out.trigrams[b] || 0) + 1;
  out.targeted_test_runs_per_lease.push(v.seq.filter((a) => a === 'bash:test_targeted').length);
}
const top = (o, n) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n));
out.bigrams = top(out.bigrams, 15); out.trigrams = top(out.trigrams, 15); out.action_counts = top(out.action_counts, 30); out.leases_with_action = top(out.leases_with_action, 30);
const t = out.targeted_test_runs_per_lease.sort((a, b) => a - b);
out.targeted_test_runs_per_lease = { n: t.length, median: t.length ? t[Math.floor(t.length / 2)] : null, p90: t.length ? t[Math.floor(t.length * 0.9)] : null, max: t.length ? t[t.length - 1] : null };
console.log(JSON.stringify(out, null, 1));
