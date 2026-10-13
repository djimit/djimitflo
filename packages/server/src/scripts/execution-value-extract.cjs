/* DI-001 execution value: read-only snapshot extractor (docs/research/di-001/EXECUTION_VALUE_PREREG.md §2).
 * Runs inside the prod container with plain node:
 *   docker exec -e NODE_PATH=/app/node_modules djimitflo-live node /tmp/x.js > snapshot.json
 * Opens the database { readonly: true } and issues SELECTs only. It emits features, lease fields needed by
 * attributeOutcome(), pr_outcome and experiment-arm tags. No titles, descriptions, prompts or diffs leave the database. */
// eslint-disable-next-line @typescript-eslint/no-require-imports -- runs as plain node inside the container
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || '/data/djimitflo.sqlite', { readonly: true });
const parse = (t) => { try { return JSON.parse(t || '{}'); } catch { return {}; } };
const LOOPS = ['doc-drift-and-small-fix-loop', 'repo-maintenance-loop', 'research-loop'];
const TERMINAL = ['completed', 'failed', 'blocked', 'ready_for_human_merge', 'escalated', 'cancelled', 'interrupted'];

const runs = db.prepare(`SELECT r.id, r.loop_name, r.status, r.created_at, r.completed_at, r.updated_at, r.metadata, r.gates_json, r.findings_json,
    g.id AS goal_id, g.improvement_id, g.metadata AS goal_meta
  FROM loop_runs r JOIN goals g ON g.id = r.goal_id
  WHERE r.loop_name IN (${LOOPS.map(() => '?').join(',')}) AND g.improvement_id IS NOT NULL ORDER BY r.created_at, r.id`).all(...LOOPS);
const leaseQ = db.prepare('SELECT id, role, status, runtime, created_at, metadata FROM worker_leases WHERE loop_run_id = ? ORDER BY rowid');
const propQ = db.prepare('SELECT id, type, source, status, priority, created_at, evidence_refs_json, grounding_json FROM self_improvements WHERE id = ?');
const annQ = db.prepare(`SELECT decision, created_at FROM judgments WHERE judgment = 'outcome_attribution'
  AND ((subject_type = 'loop_run' AND subject_id = ?) OR (subject_type = 'self_improvement' AND subject_id = ? AND created_at >= ?))`);
const evQ = db.prepare(`SELECT event_type, message, metadata FROM loop_events WHERE loop_run_id = ?
  AND event_type IN ('checker_dispatch_failed', 'bandit_selected', 'effort_arm', 'checker_family_arm', 'assignment_context') ORDER BY created_at`);

const tokensOf = (m) => { const t = Number(m?.runtime_usage?.total_tokens); return Number.isFinite(t) && t > 0 ? t : null; };
const out = { snapshot_at: new Date().toISOString(), runs: [], unexecuted_proposals: [], excluded: { not_terminal: 0, no_maker: 0, pr_review: 0 } };
const executed = new Set();
for (const r of runs) {
  const gates = parse(r.gates_json);
  const prReview = Array.isArray(gates) && gates.some((g) => /pull-request review/i.test(String(g?.evidence ?? '')));
  const leases = leaseQ.all(r.id).map((l) => {
    const m = parse(l.metadata);
    return { id: l.id, role: l.role, status: l.status, runtime: l.runtime, model: m.model ?? null, tokens: tokensOf(m),
      metadata: { failure_reason: m.failure_reason, timed_out: m.timed_out, runtime_timed_out: m.runtime_timed_out, exit_status: m.exit_status,
        completed_at: m.completed_at, changed_files: Array.isArray(m.changed_files) ? m.changed_files.map(String) : m.changed_files,
        deterministic_checks: Array.isArray(m.deterministic_checks) ? m.deterministic_checks.map((c) => ({ exit_status: c?.exit_status ?? null })) : undefined,
        verdict: m.verdict, maker_lease_id: m.maker_lease_id, read_only_contract_passed: m.read_only_contract_passed } };
  });
  if (!leases.some((l) => l.role === 'maker')) { out.excluded.no_maker++; continue; }
  if (prReview) { out.excluded.pr_review++; continue; }
  if (!TERMINAL.includes(r.status)) { out.excluded.not_terminal++; continue; }
  executed.add(r.improvement_id);
  const meta = parse(r.metadata); const gm = parse(r.goal_meta); const p = propQ.get(r.improvement_id) || {};
  const refs = parse(p.evidence_refs_json); const grounding = parse(p.grounding_json); const findings = parse(r.findings_json);
  const events = evQ.all(r.id).map((e) => ({ type: e.event_type, message: e.message, meta: parse(e.metadata) }));
  const ac = events.find((e) => e.type === 'assignment_context')?.meta ?? {};
  const bandit = events.find((e) => e.type === 'bandit_selected')?.meta ?? null;
  out.runs.push({
    id: r.id, lane: r.loop_name, status: r.status, created_at: r.created_at, completed_at: r.completed_at || null, updated_at: r.updated_at,
    task_id: r.improvement_id, proposal: { type: p.type ?? null, source: p.source ?? null, status: p.status ?? null, priority: p.priority ?? null, created_at: p.created_at ?? null,
      first_ref: Array.isArray(refs) && refs.length ? String(refs[0]) : null, target: grounding?.target ?? null },
    finding_file: Array.isArray(findings) && findings[0]?.file ? String(findings[0].file) : null,
    failed_gates: Array.isArray(meta.failed_gates) ? meta.failed_gates.map(String) : [],
    pr_url: meta.pr_url ?? null, pr_outcome: meta.pr_outcome ?? null,
    leases, annotations: annQ.all(r.id, r.improvement_id, r.created_at),
    dispatch_failed_roles: events.filter((e) => e.type === 'checker_dispatch_failed').map((e) => /^Automated (checker|security_checker) dispatch failed/.exec(e.message)?.[1]).filter(Boolean),
    arms: { effort_arm: gm.effort_arm ?? null, checker_family_arm: gm.checker_family_arm ?? null,
      memory_holdout: ac.memory_holdout === true ? true : (events.some((e) => e.type === "assignment_context") ? false : null), ace_arm: ac.ace_001?.arm ?? null, ste_arm: ac.ste_001?.arm ?? null },
    bandit: bandit ? { chosen: bandit.chosen ?? null, max_share: bandit.max_share ?? null, posterior: (bandit.posterior ?? []).map((a) => ({ species: a.species, runs: a.runs, ok: a.ok })) } : null,
  });
}
const first = out.runs[0]?.created_at ?? '9999';
for (const p of db.prepare('SELECT id, type, source, status, priority, created_at, evidence_refs_json FROM self_improvements WHERE created_at >= ?').all(first)) {
  if (executed.has(p.id)) continue;
  const refs = parse(p.evidence_refs_json);
  out.unexecuted_proposals.push({ id: p.id, type: p.type, source: p.source, status: p.status, priority: p.priority, created_at: p.created_at,
    first_ref: Array.isArray(refs) && refs.length ? String(refs[0]) : null });
}
process.stdout.write(JSON.stringify(out));
