// DI-001 shared extraction, label and cluster rules (docs/research/di-001/PREREG.md §1–§6). Read-only; zero writes.
// Runs where better-sqlite3 resolves (prod: `docker exec -e NODE_PATH=/app/node_modules djimitflo-live node ...`).
import { createRequire } from 'module';
import { createHash } from 'crypto';

export const PREREG_SHA256 = '4696b134a6fb30b3750e973c78c936a2b8a268fe346026454ee81bae84e57846';
export const LOST_WINDOW = ['2026-10-11T04:16:22Z', '2026-10-12T16:43:39Z'];
export const SPLITS = [['development', null, '2026-10-04T00:00:00Z'], ['calibration', '2026-10-04T00:00:00Z', '2026-10-08T00:00:00Z'], ['holdout', '2026-10-08T00:00:00Z', null]];
export const POSITIVE = new Set(['ORACLE_PASS_VERIFIED']);
export const NEGATIVE = new Set(['ORACLE_FAIL', 'POLICY_FAIL']);
const CHECKS = new Set(['test:changed', 'lint', 'type-check', 'test:mutation:grounded', 'test:assertion-strength']);
const REJECTING = new Set(['rejected', 'needs_revision']);
const SECURITY = /secur|secret|auth|telegram|safety|ransom|polic|approval|permission|token/i;

export function openDb(path) {
  const require = createRequire(import.meta.url);
  const Database = require('better-sqlite3');
  return new Database(path, { readonly: true, fileMustExist: true });
}
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
/** SQLite `datetime('now')` text and ISO strings → epoch ms (UTC). */
export const ms = (s) => (s ? Date.parse(String(s).includes('T') ? String(s) : String(s).replace(' ', 'T') + 'Z') : NaN);
const parse = (s, d = {}) => { try { return JSON.parse(s || ''); } catch { return d; } };

export function splitOf(createdAt) {
  const t = ms(createdAt);
  for (const [name, a, b] of SPLITS) if ((a === null || t >= ms(a)) && (b === null || t < ms(b))) return name;
  return 'unknown';
}

/** Everything the label, cluster and predictor rules read, for proposals selected by `where` (rows ≤ snapshot only). */
export function extract(db, snapshotAt, ids = null) {
  const snap = ms(snapshotAt);
  const props = ids
    ? ids.map((id) => db.prepare('SELECT * FROM self_improvements WHERE id = ?').get(id)).filter(Boolean)
    : db.prepare("SELECT * FROM self_improvements WHERE status IN ('verified','regressed') ORDER BY id").all().filter((p) => ms(p.created_at) <= snap);
  const goalQ = db.prepare('SELECT id, created_at FROM goals WHERE improvement_id = ? ORDER BY created_at');
  const runQ = db.prepare('SELECT r.* FROM loop_runs r JOIN goals g ON g.id = r.goal_id WHERE g.improvement_id = ? ORDER BY r.created_at, r.rowid');
  const leaseQ = db.prepare('SELECT id, role, status, metadata FROM worker_leases WHERE loop_run_id = ? ORDER BY rowid');
  const judgQ = db.prepare(`SELECT judgment, mode, decision, answers_json, created_at, input_tokens, output_tokens, latency_ms, model
    FROM judgments WHERE subject_id = ? ORDER BY created_at, rowid`);
  return props.map((p) => {
    const goals = goalQ.all(p.id).filter((g) => ms(g.created_at) <= snap);
    const runs = runQ.all(p.id).filter((r) => ms(r.created_at) <= snap);
    const run = runs[runs.length - 1] ?? null;
    const runRow = run ? { ...run, gates: parse(run.gates_json, []), meta: parse(run.metadata) } : null;
    const leases = run ? leaseQ.all(run.id).map((l) => ({ ...l, meta: parse(l.metadata) })) : [];
    const judgments = judgQ.all(p.id).filter((j) => ms(j.created_at) <= snap);
    const runJudg = run ? judgQ.all(run.id).filter((j) => ms(j.created_at) <= snap) : [];
    return { p, refs: parse(p.evidence_refs_json, []), goals, run: runRow, nRuns: runs.length, leases, judgments, runJudg };
  });
}

/** PREREG §2: one label class per proposal, first matching rule wins. */
export function labelOf(x) {
  const r = x.run;
  if (!r) return { cls: 'UNCLASSIFIED', why: 'no loop run' };
  const g = Object.fromEntries((Array.isArray(r.gates) ? r.gates : []).map((q) => [q.name, q.status]));
  const makers = x.leases.filter((l) => l.role === 'maker' && !l.meta.superseded_by_maker_lease_id);
  const maker = makers[makers.length - 1] ?? null;
  const checks = (maker?.meta.deterministic_checks ?? []).filter((c) => CHECKS.has(c?.name ?? c?.command));
  const cf = maker?.meta.changed_files;
  if (g.maker_completion !== 'pass') return { cls: 'ENV', why: `maker_completion=${g.maker_completion ?? 'missing'}` };
  for (const k of ['worktree_isolation', 'assignment_file_present', 'run_not_cancelled']) if (g[k] === 'fail') return { cls: 'ENV', why: `${k}=fail` };
  if (checks.some((c) => c.exit_status === 127)) return { cls: 'ENV', why: 'check exit 127' };
  if (Array.isArray(cf) && cf.length === 0) return { cls: 'ENV', why: 'no changed files' };
  const failed = checks.filter((c) => c.exit_status !== null && c.exit_status !== undefined && c.exit_status !== 0);
  if (g.tests_lint_typecheck === 'fail' || failed.length) {
    return { cls: 'ORACLE_FAIL', why: failed.length ? `check ${failed.map((c) => c.name ?? c.command).join('+')} exit≠0` : 'tests_lint_typecheck=fail', oracles: checks.map((c) => c.name ?? c.command) };
  }
  for (const k of ['diff_threshold_all_makers', 'auto_approved_scope']) if (g[k] === 'fail') return { cls: 'POLICY_FAIL', why: `${k}=fail` };
  if (x.p.status === 'verified') return { cls: 'ORACLE_PASS_VERIFIED', why: 'all gates passed', oracles: checks.map((c) => c.name ?? c.command) };
  const reviewFail = ['checker_verdict', 'security_checker_verdict', 'maker_checker_separation'].filter((k) => g[k] === 'fail');
  if (reviewFail.length) {
    const rej = x.leases.find((l) => (l.role === 'checker' || l.role === 'security_checker') && l.status === 'completed' && REJECTING.has(String(l.meta.verdict)));
    return rej ? { cls: 'CHECKER_REJECT', why: `${rej.role} ${rej.meta.verdict}` } : { cls: 'NO_VERDICT', why: `${reviewFail.join('+')} failed without a completed rejecting verdict` };
  }
  return { cls: 'UNCLASSIFIED', why: `status=${x.p.status}; gates ${JSON.stringify(g)}` };
}

export const outcomeAt = (x) => x.run?.completed_at || x.run?.updated_at || x.p.updated_at;
const targetsOf = (refs) => refs.filter((v) => /^(test-gap|mutation-gap):/.test(v)).map((v) => v.replace(/#exports$/, ''));
export function templateOf(refs) {
  const r = refs.find((v) => /^(test-gap|mutation-gap):/.test(v));
  if (!r) return 'other';
  return r.startsWith('mutation-gap:') ? 'mutation-gap' : r.endsWith('#exports') ? 'test-gap#exports' : 'test-gap';
}
export function riskOf(p, refs) {
  const text = `${p.title} ${targetsOf(refs).join(' ')}`;
  if (SECURITY.test(text)) return 'security';
  if (p.type === 'bug_fix' || /^(Fix|Investigate)/.test(p.title)) return 'production';
  return 'low';
}
export const testOnly = (p, refs) => targetsOf(refs).length > 0 || /^Add (one )?unit test/i.test(p.title);
export function lostWindow(x) {
  const a = ms(x.p.created_at); const b = ms(outcomeAt(x));
  return a <= ms(LOST_WINDOW[1]) && b >= ms(LOST_WINDOW[0]);
}

/** PREREG §5: union-find; cluster id = lowest member id. */
export function clusters(xs) {
  const ids = xs.map((x) => x.p.id); const parent = new Map(ids.map((i) => [i, i]));
  const find = (i) => { while (parent.get(i) !== i) { parent.set(i, parent.get(parent.get(i))); i = parent.get(i); } return i; };
  const union = (a, b) => { if (!parent.has(a) || !parent.has(b)) return; const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb); };
  const byKey = new Map();
  for (const x of xs) {
    for (const v of x.refs) { const m = /^(requeue-of|refinement-of):(.+)$/.exec(v); if (m) union(x.p.id, m[2]); }
    if (x.p.refined_from_id) union(x.p.id, x.p.refined_from_id);
    for (const k of [x.p.fingerprint ? `fp:${x.p.fingerprint}` : null, ...targetsOf(x.refs).map((t) => `t:${t}`)].filter(Boolean)) {
      if (byKey.has(k)) union(x.p.id, byKey.get(k)); else byKey.set(k, x.p.id);
    }
  }
  return new Map(ids.map((i) => [i, find(i)]));
}
