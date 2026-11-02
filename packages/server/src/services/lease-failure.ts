/**
 * Structured failure capture (L3 report v2, 21-10, §5 bottleneck 4; P2/P3/P7). About 44 % of non-verified outcomes were not
 * maker quality, yet the per-lease cause was UNKNOWN: `runtime_signal` was null on every failed maker (the engine path
 * hard-coded it), 50 of 56 maker cancels had no `cancellation_reason`, 24 failures read "unspecified". Every lease that
 * ends `failed` or `cancelled` now carries one `metadata.failure` object, completed by WorkerLeaseRepo from what the caller
 * knows (runtime exit, stderr class, stage) and what the metadata already says.
 *
 * Record-only: outcome attribution (outcome-attribution.ts) keeps its own rules and never reads this object.
 */

import fs from 'fs';

export const FAILURE_STAGES = ['prepare', 'deps', 'maker', 'checks', 'checker', 'verify', 'cancel'] as const;
export type FailureStage = typeof FAILURE_STAGES[number];

export const STDERR_CLASSES = ['missing_module', 'enoent', 'eacces', 'oom', 'network', 'rate_limit', 'auth', 'npm_ci', 'git', 'tool_loop', 'unknown'] as const;
export type StderrClass = typeof STDERR_CLASSES[number];

export interface LeaseFailure {
  stage: FailureStage;
  /** the runtime process's own exit code (for checks/deps: the first failed check's); null when not observed or killed by a signal */
  exit_code: number | null;
  signal: string | null;
  /** false = no process exit was observed (never spawned, remote host, raw cancel): exit_code/signal null mean UNKNOWN, not 0 */
  exit_observed: boolean;
  timed_out: boolean;
  token_budget_hit: boolean;
  stderr_class: StderrClass;
  /** what was classified: the runtime's stderr tail, only the recorded reason text, or nothing ('unknown' then means no evidence) */
  stderr_source: 'stderr' | 'reason' | 'none';
  /** every cancel names one; null on a failure */
  cancellation_reason: string | null;
}

export const STDERR_TAIL_CHARS = 4_000;

/**
 * Deterministic: the first rule (in this order) that matches the last 4 000 characters. The order puts causes before the
 * symptoms they produce (a registry reset makes npm fail; npm's own enoent is an npm failure, not a missing file).
 */
const RULES: Array<[Exclude<StderrClass, 'unknown'>, RegExp]> = [
  ['oom', /JavaScript heap out of memory|\bENOMEM\b|out of memory|OOM[- ]?kill|Allocation failed/i],
  ['rate_limit', /rate[ _-]?limit|too many requests|usage limit|quota exceeded|\b(?:status|code|http)[ :=]*429\b|\b429 too many/i],
  ['auth', /unauthori[sz]ed|\b(?:status|code|http)[ :=]*40[13]\b|invalid (?:api[ _-]?key|x-api-key|token)|authentication (?:failed|required|error)|not logged in|please run \/login|credentials? (?:missing|expired|invalid)|Permission denied \(publickey/i],
  ['network', /\bECONNREFUSED\b|\bECONNRESET\b|\bENOTFOUND\b|\bEAI_AGAIN\b|\bENETUNREACH\b|\bEHOSTUNREACH\b|socket hang up|fetch failed|network (?:error|unreachable)|getaddrinfo|(?<!spawnSync \S{1,64} )\bETIMEDOUT\b/i],
  ['npm_ci', /npm (?:ERR!|error)|npm ci can only install|\bERESOLVE\b|\bEINTEGRITY\b|\bETARGET\b|\bELIFECYCLE\b|gyp ERR!/i],
  ['missing_module', /Cannot find module|ERR_MODULE_NOT_FOUND|Module not found|Cannot find package|Failed to resolve import|Failed to load url/i],
  ['eacces', /\bEACCES\b|\bEPERM\b|permission denied|operation not permitted/i],
  ['enoent', /\bENOENT\b|no such file or directory|command not found|not found in PATH/i],
  ['git', /^fatal: |not a git repository|\bgit (?:apply|checkout|worktree|merge|rebase|fetch)\b.*(?:fail|error)|CONFLICT \(|index\.lock|patch does not apply|remote patch did not apply/im],
  ['tool_loop', /doom[ _-]?loop|tool[ _-]?loop|repeated (?:the same )?tool call|loop detected|max(?:imum)?[ _-]?(?:steps|turns|iterations)|step limit/i],
];

export function classifyStderr(text: string | null | undefined): StderrClass {
  const tail = (text ?? '').slice(-STDERR_TAIL_CHARS);
  if (!tail.trim()) return 'unknown';
  for (const [cls, re] of RULES) if (re.test(tail)) return cls;
  return 'unknown';
}

const TOKEN_BUDGET = /token[ _]budget(?: exceeded)?|OPENCODE_MAX_RUN_TOKENS|max[_-]budget/i;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The stage a lease ended in when the caller did not say: from role, status and the reason text only. */
export function inferFailureStage(role: string, status: string, meta: Record<string, unknown>): FailureStage {
  if (status === 'cancelled') return 'cancel';
  if (role === 'checker' || role === 'security_checker') return 'checker';
  const fr = str(meta.failure_reason) || str(meta.failed_reason);
  if (/^deterministic_checks_failed:/.test(fr)) return /(?:^|[:,])install\(/.test(fr) ? 'deps' : 'checks';
  if (meta.runtime_contract_failed_at || meta.execution_denied_reason !== undefined || meta.runtime_fallback_refused
    || /^MAKER_WORKTREE_NOT_FOUND|^MANUAL_MAKER|Worktree path does not exist|Manual runtime requires/.test(fr) || /^infra: subscription_auth/.test(fr)) return 'prepare';
  // a throw before the runtime was dispatched (no task row, no completion) is preparation; after that it is the maker's run
  if (/^maker_execution_error:/.test(fr) && !meta.execution_task_id && !meta.completed_at) return 'prepare';
  return 'maker';
}

/**
 * A cancel's reason: the stated one, else what the metadata shows, else (O2b) `cascade:run_<status>` — the lease was settled
 * with its run (471 reviewer cancels had no reason) — else the explicit unspecified marker (never null).
 */
export function cancellationReasonOf(meta: Record<string, unknown>, runStatus?: string | null): string {
  return str(meta.cancellation_reason) || (meta.stopped_by_runner ? 'operator_stop' : '')
    || (meta.superseded_by_maker_lease_id ? 'superseded' : '') || (runStatus ? `cascade:run_${runStatus}` : '') || 'unspecified: caller supplied no reason';
}

/**
 * Pure: the failure object of a lease that ends `status`, from the caller's hint (what it observed) and the merged
 * metadata. A cancel is always stage 'cancel' with a reason; timed_out / token_budget_hit are also read from the metadata
 * and reason text so a hint can never hide them.
 */
export function buildLeaseFailure(role: string, status: string, meta: Record<string, unknown>, hint: Partial<LeaseFailure> = {}): LeaseFailure {
  const reasonText = [str(meta.failure_reason), str(meta.failed_reason), str(meta.execution_denied_reason)].filter(Boolean).join('\n');
  const cancelled = status === 'cancelled';
  const stage: FailureStage = cancelled ? 'cancel'
    : hint.stage && (FAILURE_STAGES as readonly string[]).includes(hint.stage) ? hint.stage : inferFailureStage(role, status, meta);
  // the caller's stderr class wins; else the recorded reason text; else unknown, saying whether there was anything to read
  const hinted = hint.stderr_class && hint.stderr_class !== 'unknown' && (STDERR_CLASSES as readonly string[]).includes(hint.stderr_class) ? hint.stderr_class : null;
  const fromReason = hinted ? 'unknown' : classifyStderr(reasonText);
  const [stderr_class, stderr_source]: [StderrClass, LeaseFailure['stderr_source']] = hinted ? [hinted, hint.stderr_source ?? 'stderr']
    : fromReason !== 'unknown' ? [fromReason, 'reason']
      : ['unknown', hint.stderr_source ?? (reasonText.trim() ? 'reason' : 'none')];
  const exitObserved = hint.exit_observed === true;
  return {
    stage,
    exit_code: exitObserved && typeof hint.exit_code === 'number' ? hint.exit_code : null,
    signal: exitObserved && typeof hint.signal === 'string' && hint.signal ? hint.signal : null,
    exit_observed: exitObserved,
    timed_out: hint.timed_out === true || meta.timed_out === true || meta.runtime_timed_out === true
      || /timed_out=true|\btimed out\b|^stale_timeout$|^runtime_timed_out$/m.test(reasonText),
    token_budget_hit: hint.token_budget_hit === true || TOKEN_BUDGET.test(reasonText),
    stderr_class,
    stderr_source,
    cancellation_reason: cancelled ? cancellationReasonOf(meta) : null,
  };
}

export const FAILED_OR_CANCELLED: ReadonlySet<string> = new Set(['failed', 'cancelled']);

/** The failure object of a raw-SQL cancel of a lease that never reported an exit (bind with cancelLeaseBind). */
export const cancelFailure = (reason: string): LeaseFailure => buildLeaseFailure('', 'cancelled', { cancellation_reason: reason });

/**
 * `metadata = …` for a raw `UPDATE worker_leases SET status = 'cancelled'`: the reason, when, and the structured failure.
 * Bind the three values of cancelLeaseBind(reason, now) where this fragment sits in the statement.
 */
export const CANCEL_LEASE_METADATA_SQL = `metadata = json_set(COALESCE(NULLIF(metadata, ''), '{}'), '$.cancellation_reason', ?, '$.cancelled_at', ?, '$.failure', json(?))`;
export const cancelLeaseBind = (reason: string, now: string): [string, string, string] => [reason, now, JSON.stringify(cancelFailure(reason))];

/**
 * The hint for a maker lease failed by its deterministic checks: stage 'deps' when the checks' own `npm ci` failed, else
 * 'checks'; exit/timeout of the first failed check; the first stderr class (in check order) its stderr log tail shows.
 */
export function checksFailureHint(checks: Array<Record<string, unknown>>): Partial<LeaseFailure> {
  const failed = checks.filter((c) => c.status === 'fail');
  const first = failed[0];
  let stderr_class: StderrClass = 'unknown';
  let read = false;
  for (const c of failed) {
    let tail = '';
    try { if (typeof c.stderr_path === 'string' && fs.existsSync(c.stderr_path)) tail = fs.readFileSync(c.stderr_path, 'utf8').slice(-STDERR_TAIL_CHARS); } catch { /* unreadable log */ }
    if (tail.trim()) read = true;
    stderr_class = classifyStderr(tail);
    if (stderr_class !== 'unknown') break;
  }
  return {
    stage: failed.some((c) => c.name === 'install') ? 'deps' : 'checks',
    exit_observed: typeof first?.exit_status === 'number',
    exit_code: typeof first?.exit_status === 'number' ? first.exit_status : null,
    signal: null,
    timed_out: failed.some((c) => c.timed_out === true),
    stderr_class,
    stderr_source: read ? 'stderr' : 'none',
  };
}
