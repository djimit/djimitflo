import { CheckCircle2, GitBranch, Play, Split, Square, Timer, Workflow } from 'lucide-react';
import { api, type LoopGate, type LoopReviewBundle, type LoopRunRecord, type WorkerLeaseRecord } from '../../lib/api';
import { GymRunPanel, isGymRun } from '../../components/GymRunPanel';
import { StatusBadge, StatusIcon } from './status';

type Runtime = 'manual' | 'codex' | 'opencode';

/** UX-28: the selected run of the Goals & Loops page; data, bundle and actions stay in the page. */
export function LoopRunDetail({ selectedRun, selectedRunId, selectedBundle, runLookupError, loading, runtime, canApprove, actionId, runLocked, runAction, completeLoop, executeChecker, splitFinding }: {
  selectedRun: LoopRunRecord | null; selectedRunId: string | null; selectedBundle: LoopReviewBundle | null;
  runLookupError: { id: string; message: string } | null; loading: boolean; runtime: Runtime; canApprove: boolean;
  actionId: string | null; runLocked: boolean; runAction: (label: string, action: () => Promise<unknown>) => Promise<void>;
  completeLoop: () => Promise<void>; executeChecker: (lease: WorkerLeaseRecord) => Promise<void>; splitFinding: (findingId: string) => Promise<void>;
}) {
  const activeWorkers = selectedBundle?.leases.filter((lease) => ['prepared', 'running'].includes(lease.status)).length ?? 0;
  return (
    <div className="space-y-4">
      {selectedRun ? (
        <>
          <div className="bg-background-secondary border border-border rounded-lg p-5">
            <div className="flex flex-col lg:flex-row lg:flex-wrap lg:items-start lg:justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <StatusIcon status={selectedRun.status} />
                  <h2 className="text-xl font-semibold text-foreground">{selectedRun.loop_name}</h2>
                  <StatusBadge status={selectedRun.status} />
                </div>
                <p className="text-sm text-foreground-secondary mt-2 truncate">{selectedRun.repository_path || 'No repository path'}</p>
                <div className="flex flex-wrap gap-2 mt-3 text-xs text-foreground-tertiary">
                  <span>{new Date(selectedRun.created_at).toLocaleString()}</span>
                  {selectedRun.completed_at && <span>Completed {new Date(selectedRun.completed_at).toLocaleString()}</span>}
                  {activeWorkers > 0 && <span>{activeWorkers} active worker(s)</span>}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => void runAction(`step-${selectedRun.id}`, () => api.stepLoopRun(selectedRun.id))}
                  disabled={actionId !== null || runLocked}
                  className="inline-flex items-center gap-2 px-3 py-2 bg-background border border-border rounded-lg text-sm text-foreground hover:border-accent/30 disabled:opacity-50"
                >
                  <Workflow className="h-4 w-4" />
                  Step
                </button>
                <button
                  onClick={() => void runAction(`continue-${selectedRun.id}`, () => api.continueLoopRun(selectedRun.id, { max_assignments: 1, runtime }))}
                  disabled={actionId !== null || runLocked || ['running', 'verifying'].includes(selectedRun.status)}
                  className="inline-flex items-center gap-2 px-3 py-2 bg-background border border-border rounded-lg text-sm text-foreground hover:border-accent/30 disabled:opacity-50"
                >
                  <GitBranch className="h-4 w-4" />
                  Continue
                </button>
                <button
                  onClick={() => void runAction(`verify-${selectedRun.id}`, () => api.verifyLoopRun(selectedRun.id))}
                  disabled={actionId !== null || runLocked}
                  className="inline-flex items-center gap-2 px-3 py-2 bg-background border border-border rounded-lg text-sm text-foreground hover:border-accent/30 disabled:opacity-50"
                >
                  <CheckCircle2 className="h-4 w-4" />
                  Verify
                </button>
                {canApprove && (
                  <button
                    onClick={() => void runAction(`complete-${selectedRun.id}`, completeLoop)}
                    disabled={actionId !== null || selectedRun.status !== 'ready_for_human_merge'}
                    className="inline-flex items-center gap-2 px-3 py-2 bg-background border border-border rounded-lg text-sm text-foreground hover:border-accent/30 disabled:opacity-50"
                  >
                    <CheckCircle2 className="h-4 w-4" />
                    Complete
                  </button>
                )}
                <button
                  onClick={() => void runAction(`stop-${selectedRun.id}`, () => api.stopLoopRun(selectedRun.id))}
                  disabled={actionId !== null || ['completed', 'cancelled'].includes(selectedRun.status)}
                  className="inline-flex items-center gap-2 px-3 py-2 bg-background border border-border rounded-lg text-sm text-foreground hover:border-accent/30 disabled:opacity-50"
                >
                  <Square className="h-4 w-4" />
                  Stop
                </button>
              </div>
            </div>
          </div>

          {/* gym runs have no worker leases: their claim, result and outcome are read from the run itself */}
          {isGymRun(selectedRun) && <GymRunPanel key={selectedRun.id} run={selectedBundle?.run ?? selectedRun} />}

          <section className="bg-background-secondary border border-border rounded-lg p-5">
            <h3 className="text-lg font-semibold text-foreground mb-3">Gates</h3>
            <div className="space-y-2">
              {(selectedBundle?.run.gates.length ? selectedBundle.run.gates : selectedRun.gates).map((gate) => (
                <GateRow key={gate.name} gate={gate} />
              ))}
            </div>
          </section>

          <section className="bg-background-secondary border border-border rounded-lg p-5">
            <h3 className="text-lg font-semibold text-foreground mb-3">Worker Leases</h3>
            {runtime === 'manual' && <p className="text-sm text-foreground-secondary mb-3">Manual review does not execute a runtime. Select Codex or OpenCode above to run a checker, or submit an explicit manual verdict.</p>}
            <div className="space-y-2">
              {selectedBundle?.leases.length ? selectedBundle.leases.map((lease) => (
                <LeaseRow
                  key={lease.id}
                  lease={lease}
                  onAccept={() => void runAction(`accept-${lease.id}`, () => lease.role === 'security_checker'
                    ? api.submitSecurityVerdict(selectedRun.id, lease.id, 'accepted', 'Accepted from dashboard')
                    : api.submitCheckerVerdict(selectedRun.id, lease.id, 'accepted', 'Accepted from dashboard'))}
                  onNeedsRevision={() => void runAction(`revise-${lease.id}`, () => lease.role === 'security_checker'
                    ? api.submitSecurityVerdict(selectedRun.id, lease.id, 'needs_revision', 'Needs revision from dashboard')
                    : api.submitCheckerVerdict(selectedRun.id, lease.id, 'needs_revision', 'Needs revision from dashboard'))}
                  onRetry={() => void runAction(`retry-${lease.id}`, () => api.retryLoopRun(selectedRun.id, lease.id, runtime))}
                  onExecute={() => void runAction(`execute-worker-${lease.id}`, () => api.executeWorker(selectedRun.id, lease.id, { timeout_ms: 120_000, diff_max_lines: 200 }))}
                  onExecuteChecker={() => void runAction(`execute-checker-${lease.id}`, () => executeChecker(lease))}
                  selectedRuntime={runtime}
                  makerCompleted={selectedBundle.leases.some((maker) => maker.id === lease.metadata.maker_lease_id && maker.role === 'maker' && maker.status === 'completed')}
                  runMakerCost={makerCost(selectedBundle.leases)}
                  busy={actionId !== null || loading || runLocked}
                />
              )) : (
                <p className="text-sm text-foreground-secondary">{selectedBundle ? 'No worker leases for this run.' : 'Review bundle unavailable or loading.'}</p>
              )}
            </div>
          </section>

          <section className="bg-background-secondary border border-border rounded-lg p-5">
            <h3 className="text-lg font-semibold text-foreground mb-3">Findings</h3>
            <div className="space-y-2">
              {selectedRun.findings.slice(0, 8).map((finding) => (
                <div key={finding.id} className="rounded border border-border bg-background p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-medium text-foreground truncate">{finding.message}</div>
                    <div className="flex items-center gap-2">
                      {finding.metadata?.status === 'split' && <Split className="h-4 w-4 text-status-paused shrink-0" />}
                      {finding.metadata?.status !== 'split' && (
                        <button
                          onClick={() => void runAction(`split-${finding.id}`, () => splitFinding(finding.id))}
                          disabled={actionId !== null || runLocked}
                          className="p-1 rounded hover:bg-background-elevated disabled:opacity-50"
                          title="Split finding"
                        >
                          <Split className="h-4 w-4 text-foreground-secondary" />
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="text-xs text-foreground-tertiary mt-1 truncate">{finding.file}{finding.line ? `:${finding.line}` : ''}</div>
                </div>
              ))}
            </div>
          </section>

          <section className="bg-background-secondary border border-border rounded-lg p-5">
            <h3 className="text-lg font-semibold text-foreground mb-3">Review Events</h3>
            <div className="space-y-2">
              {selectedBundle?.events.slice(-8).reverse().map((event) => (
                <div key={event.id} className="flex items-start gap-3 rounded border border-border bg-background p-3">
                  <Timer className="h-4 w-4 text-foreground-tertiary mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-foreground">{event.event_type}</div>
                    <div className="text-xs text-foreground-secondary mt-1">{event.message}</div>
                  </div>
                </div>
              )) || <p className="text-sm text-foreground-secondary">No events loaded.</p>}
            </div>
          </section>
        </>
      ) : selectedRunId && runLookupError?.id === selectedRunId ? (
        <div role="alert" className="bg-background-secondary border border-status-error/30 rounded-lg p-8 text-status-error">
          Run {selectedRunId} is unavailable: {runLookupError.message}. No other run&apos;s evidence is shown; pick a run from the list.
        </div>
      ) : selectedRunId && !loading ? (
        <div className="bg-background-secondary border border-border rounded-lg p-8 text-foreground-secondary">Loading run {selectedRunId}…</div>
      ) : (
        <div className="bg-background-secondary border border-border rounded-lg p-8 text-foreground-secondary">Select a loop run.</div>
      )}
    </div>
  );
}

function GateRow({ gate }: { gate: LoopGate }) {
  return (
    <div className="flex items-start gap-3 rounded border border-border bg-background p-3">
      <StatusIcon status={gate.status} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-foreground">{gate.name}</span>
          <StatusBadge status={gate.status} />
        </div>
        <p className="text-xs text-foreground-secondary mt-1">{gate.evidence}</p>
      </div>
    </div>
  );
}

function LeaseRow({
  lease,
  onExecute,
  onExecuteChecker,
  onAccept,
  onNeedsRevision,
  onRetry,
  selectedRuntime,
  makerCompleted,
  busy,
  runMakerCost,
}: {
  lease: WorkerLeaseRecord;
  onExecute: () => void;
  onExecuteChecker: () => void;
  onAccept: () => void;
  onNeedsRevision: () => void;
  onRetry: () => void;
  selectedRuntime: 'manual' | 'codex' | 'opencode';
  makerCompleted: boolean;
  busy: boolean;
  runMakerCost?: MakerCost;
}) {
  const isReviewer = lease.role === 'checker' || lease.role === 'security_checker';
  const canVerdict = isReviewer && lease.status === 'prepared' && lease.runtime === 'manual' && !lease.metadata.execution_task_id;
  const canExecute = lease.role === 'maker' && lease.status === 'prepared' && lease.runtime !== 'manual';
  const canExecuteChecker = isReviewer && lease.status === 'prepared';
  const reviewDisabled = busy || !makerCompleted || selectedRuntime === 'manual'
    || (!!lease.metadata.execution_task_id && selectedRuntime !== lease.runtime);
  const canRetry = lease.role === 'maker' && lease.status === 'failed';
  const runtimeUsage = lease.metadata.runtime_usage as { total_tokens?: number } | undefined;
  const efficiency = lease.metadata.token_efficiency as { tokens_per_diff_line?: number | null } | undefined;
  const warnings = Array.isArray(lease.metadata.runtime_warnings) ? lease.metadata.runtime_warnings : [];
  const hasArtifacts = typeof lease.metadata.stdout_path === 'string' && lease.metadata.stdout_path.length > 0;
  const hasExecutionMetrics = Boolean(runtimeUsage?.total_tokens || typeof efficiency?.tokens_per_diff_line === 'number' || warnings.length > 0 || hasArtifacts);
  return (
    <div className="rounded border border-border bg-background p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium text-foreground">{lease.role}</div>
        <StatusBadge status={lease.status} />
      </div>
      <div className="mt-2 grid grid-cols-1 md:grid-cols-3 gap-2 text-xs text-foreground-secondary">
        <span className="truncate">Runtime: {lease.runtime}</span>
        <span className="truncate">Finding: {lease.finding_id?.slice(0, 8) || 'none'}</span>
        <span className="truncate">Branch: {lease.branch_name || 'none'}</span>
      </div>
      {hasExecutionMetrics && (
        <div className="mt-2 grid grid-cols-1 md:grid-cols-4 gap-2 text-xs text-foreground-tertiary">
          <span className="truncate">Tokens: {runtimeUsage?.total_tokens ?? 'unknown'}</span>
          <span className="truncate">Tokens/diff: {typeof efficiency?.tokens_per_diff_line === 'number' ? efficiency.tokens_per_diff_line.toFixed(0) : 'n/a'}</span>
          <span className="truncate">Warnings: {warnings.length}</span>
          <span className="truncate">Artifacts: {hasArtifacts ? 'yes' : 'no'}</span>
        </div>
      )}
      {lease.role === 'maker' && isAsgRecord(lease.metadata.asg) && <AsgPanel asg={lease.metadata.asg} cost={runMakerCost} />}
      {(canExecute || canExecuteChecker || canVerdict || canRetry) && (
        <div className="mt-3 flex flex-wrap gap-2">
          {canExecute && (
            <button onClick={onExecute} disabled={busy} className="inline-flex items-center gap-1 px-2 py-1 rounded border border-accent/20 text-xs text-accent hover:bg-accent/10 disabled:opacity-50">
              <Play className="h-3 w-3" />
              Run Maker
            </button>
          )}
          {canExecuteChecker && (
            <button onClick={onExecuteChecker} disabled={reviewDisabled} title={selectedRuntime === 'manual' ? 'Select Codex or OpenCode for runtime review' : undefined} className="inline-flex items-center gap-1 px-2 py-1 rounded border border-accent/20 text-xs text-accent hover:bg-accent/10 disabled:opacity-50">
              <Play className="h-3 w-3" />
              {lease.role === 'security_checker' ? 'Run Security Checker' : 'Run Checker'}
            </button>
          )}
          {canVerdict && (
            <>
              <button onClick={onAccept} disabled={busy || !makerCompleted} className="px-2 py-1 rounded border border-status-completed/20 text-xs text-status-completed hover:bg-status-completed/10 disabled:opacity-50">Accept manually</button>
              <button onClick={onNeedsRevision} disabled={busy || !makerCompleted} className="px-2 py-1 rounded border border-status-paused/20 text-xs text-status-paused hover:bg-status-paused/10 disabled:opacity-50">Needs revision (manual)</button>
            </>
          )}
          {canRetry && (
            <button onClick={onRetry} disabled={busy} className="px-2 py-1 rounded border border-accent/20 text-xs text-accent hover:bg-accent/10 disabled:opacity-50">Retry</button>
          )}
        </div>
      )}
    </div>
  );
}

interface MakerCost { tokens: number; leases: number; failed: number; unknown: number }
/** Every maker attempt of the run, failed ones included; tokens the runtime did not report stay unknown (never 0). */
function makerCost(leases: WorkerLeaseRecord[]): MakerCost {
  const makers = leases.filter((l) => l.role === 'maker');
  const known = makers.map((l) => (l.metadata.runtime_usage as { total_tokens?: number } | undefined)?.total_tokens).filter((t): t is number => typeof t === 'number');
  return { tokens: known.reduce((a, b) => a + b, 0), leases: makers.length, failed: makers.filter((l) => l.status === 'failed').length, unknown: makers.length - known.length };
}

interface AsgSkillRef { skill_id: string; version: number; digest: string; state: string }
interface AsgRecord {
  mode: string; requested?: string; blocked_by?: string[]; lane?: string; route_executed?: string;
  decision: { route: string; reason_codes: string[]; policy: { id: string; version: number; hash: string }; feature_schema_hash: string; skill: AsgSkillRef | null; prefix?: AsgSkillRef | null; alternatives: Array<{ route: string; skill: string | null; reason: string }> };
  outcome?: {
    execution_status: string; verification_status: string; result: string; rescued: boolean;
    incident: { class: string; timed_out: boolean; token_budget_hit: boolean } | null; failure: { class: string; recoverable: boolean } | null;
    effects: { expected: string[]; observed: string[]; out_of_scope: string[]; declared_untouched: string[]; bounded: boolean };
    verifier: { command: string | null; exit: number | null } | null;
  };
}
const isAsgRecord = (v: unknown): v is AsgRecord => Boolean(v && typeof v === 'object' && (v as AsgRecord).decision && typeof (v as AsgRecord).decision.route === 'string');
const skillLabel = (s: AsgSkillRef | null | undefined) => (s ? `${s.skill_id}@${s.version} · ${s.digest.slice(0, 12)} · ${s.state}` : 'none');

/** ASG-001 (ASG_MODE): route, execution error and task result are shown apart, never merged into one status. */
function AsgPanel({ asg, cost }: { asg: AsgRecord; cost?: MakerCost }) {
  const d = asg.decision; const o = asg.outcome;
  return (
    <div className="mt-2 rounded border border-border p-2 text-xs text-foreground-secondary space-y-1" data-testid="asg-panel">
      <div className="font-medium text-foreground">Skill granularity (ASG {asg.mode}{asg.blocked_by?.length ? `, on blocked by ${asg.blocked_by.join(', ')}` : ''})</div>
      <div>Route: <span className="text-foreground">{d.route}</span> ({d.reason_codes.join(', ')}) · executed {asg.route_executed ?? d.route}</div>
      <div>Policy: {d.policy.id} v{d.policy.version} · {d.policy.hash} · features {d.feature_schema_hash}</div>
      <div>Skill: {skillLabel(d.skill)}{d.prefix ? ` · prefix ${skillLabel(d.prefix)}` : ''}</div>
      {d.alternatives.length > 0 && <div>Alternatives: {d.alternatives.map((a) => `${a.route}${a.skill ? ` ${a.skill}` : ''} (${a.reason})`).join('; ')}</div>}
      {o ? (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            <span>Execution: <span className="text-foreground">{o.execution_status}</span></span>
            <span>Verification: <span className="text-foreground">{o.verification_status}</span>{o.verifier?.command ? ` (${o.verifier.command}, exit ${o.verifier.exit ?? '?'})` : ''}</span>
            <span>Result: <span className="text-foreground">{o.result}</span></span>
          </div>
          <div>Effects: expected {o.effects.expected.join(', ') || 'none'} · observed {o.effects.observed.join(', ') || 'none'}{o.effects.out_of_scope.length ? ` · out of scope ${o.effects.out_of_scope.join(', ')}` : ''} · {o.effects.bounded ? 'bounded to the worktree' : 'external effects unknown'}</div>
          {o.incident && <div>Incident: {o.incident.class}{o.incident.timed_out ? ' (timeout)' : ''}{o.incident.token_budget_hit ? ' (token brake)' : ''}</div>}
          {o.failure && <div>Failure: {o.failure.class} · {o.failure.recoverable ? 'recoverable' : 'not recoverable'}</div>}
          <div>Recovery: {o.rescued ? 'end state verified after the exception (no re-run)' : 'none (v1: no macro adapter, so no macro → micro recovery on this runtime)'}</div>
        </>
      ) : <div>Outcome: pending</div>}
      {cost && <div>Cost, every maker attempt of this run: {cost.tokens.toLocaleString('en-US')} tokens over {cost.leases} lease(s), {cost.failed} failed{cost.unknown ? `, ${cost.unknown} with unknown usage` : ''}</div>}
      {d.skill && <div>Lineage/admission: lifecycle {d.skill.state}; executes only when eligible or active</div>}
    </div>
  );
}
