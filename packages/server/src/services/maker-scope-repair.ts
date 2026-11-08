import type { Database } from 'better-sqlite3';
import { aceLane } from './ace-001';
import { TG_LOOP } from './tg-001';
import type { LoopRunRecord, WorkerLeaseRecord } from './loop-types';

/**
 * MAKER_SCOPE_REPAIR=on (default off: the executor never calls this). Prod 7 d: 5 of 15 failed oracle-lane makers wrote a
 * correct test and also rewrote package.json (the runtime ran `npm install-scripts approve` / `npm pkg`), so the scope gate
 * (auto_approved_scope / objective_scope) refused the run. Only for maker leases of the oracle test lanes (test-gap incl.
 * #exports, mutation-gap; never TG-001 or the gym), after the runtime returned and before changed_files, the maker gates
 * and the deterministic checks are computed: when every changed file outside the lane's one allowed file is a
 * `package.json` / `package-lock.json` (any workspace) tracked at the base commit, exactly those files are restored to it
 * (`git checkout <base> -- <files>`). Anything else outside the scope, an untracked manifest, or no known scope: nothing
 * is touched and the gates decide as today. The gates, their thresholds and the checks are unchanged.
 */
export const makerScopeRepairOn = (env: NodeJS.ProcessEnv = process.env): boolean => env.MAKER_SCOPE_REPAIR === 'on';

const MANIFEST = /(^|\/)package(-lock)?\.json$/;

export interface ScopeRepair { restored: string[]; base: string; scope: string; lane: string; at: string }

/** Pure: the manifests to restore, or null when the out-of-scope set is empty, holds anything else, or a new (untracked) manifest. */
export function scopeRepairPlan(scope: string | null, tracked: string[], untracked: string[]): string[] | null {
  if (!scope) return null;
  const outside = [...new Set([...tracked, ...untracked])].filter((f) => f !== scope && !f.startsWith('.djimitflo/'));
  if (outside.length === 0 || !outside.every((f) => MANIFEST.test(f))) return null;
  if (outside.some((f) => untracked.includes(f))) return null; // no base version to restore
  return outside;
}

/** The one file the scope gates hold this maker to: its approved file, else its objective finding file, else the lane's test artifact. */
function allowedScope(db: Database, run: LoopRunRecord, lease: WorkerLeaseRecord): string | null {
  if (typeof lease.metadata?.auto_approved_scope === 'string' && lease.metadata.auto_approved_scope) return lease.metadata.auto_approved_scope;
  const finding = run.findings.find((f) => f.id === lease.finding_id);
  if (finding?.metadata?.objective_mode && finding.file && !finding.file.startsWith('(')) return finding.file;
  try {
    const row = db.prepare("SELECT json_extract(s.grounding_json, '$.artifactPath') AS a FROM goals g JOIN self_improvements s ON s.id = g.improvement_id WHERE g.id = ?")
      .get(run.goal_id) as { a: unknown } | undefined;
    return typeof row?.a === 'string' && row.a ? row.a : null;
  } catch { return null; }
}

/** Restores the out-of-scope manifests of an oracle-lane maker; null = not applicable or nothing restored (the tree is unchanged). */
export function repairMakerScope(db: Database, run: LoopRunRecord, lease: WorkerLeaseRecord, git: (cwd: string, args: string[]) => string,
  now: Date = new Date()): ScopeRepair | null {
  if (lease.role !== 'maker' || !lease.worktree_path || run.loop_name === TG_LOOP || run.loop_name === 'evolution-gym') return null;
  const lane = (() => { try { return aceLane(db, run.goal_id); } catch { return null; } })();
  if (!lane) return null;
  const cwd = lease.worktree_path;
  try {
    const lines = (out: string) => out.split('\n').filter(Boolean);
    const scope = allowedScope(db, run, lease);
    const files = scopeRepairPlan(scope, lines(git(cwd, ['diff', '--name-only', '--', '.'])), lines(git(cwd, ['ls-files', '--others', '--exclude-standard'])));
    if (!scope || !files) return null;
    const base = git(cwd, ['rev-parse', 'HEAD']);
    git(cwd, ['checkout', base, '--', ...files]);
    return { restored: files, base, scope, lane: lane.lane, at: now.toISOString() };
  } catch { return null; } // a git failure leaves the gates to decide as today
}
