import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, GitBranch, Play, Plus, RefreshCw, ShieldCheck, Split, Square, Target, Timer, Workflow, XCircle } from 'lucide-react';
import { api, type GoalRecord, type LoopCatalogItem, type LoopGate, type LoopReviewBundle, type LoopRunRecord, type WorkerLeaseRecord } from '../lib/api';

const DEFAULT_REPOSITORY_PATH = '/Users/dlandman/djimitflo';

export function GoalsLoopsPage() {
  const [goals, setGoals] = useState<GoalRecord[]>([]);
  const [runs, setRuns] = useState<LoopRunRecord[]>([]);
  const [catalog, setCatalog] = useState<LoopCatalogItem[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [bundle, setBundle] = useState<LoopReviewBundle | null>(null);
  const [repositoryPath, setRepositoryPath] = useState(DEFAULT_REPOSITORY_PATH);
  const [selectedLoopName, setSelectedLoopName] = useState('doc-drift-and-small-fix-loop');
  const [selectedGoalId, setSelectedGoalId] = useState('');
  const [runtime, setRuntime] = useState<'manual' | 'codex' | 'opencode'>('manual');
  const [goalObjective, setGoalObjective] = useState('');
  const [goalAcceptance, setGoalAcceptance] = useState('');
  const [goalRisk, setGoalRisk] = useState<'low' | 'medium' | 'high' | 'critical'>('low');
  const [loading, setLoading] = useState(true);
  const [actionId, setActionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedRun = useMemo(
    () => runs.find((run) => run.id === selectedRunId) || runs[0] || null,
    [runs, selectedRunId]
  );

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (!selectedRun) {
      setBundle(null);
      return;
    }
    void loadBundle(selectedRun.id);
  }, [selectedRun?.id]);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const [goalRes, runRes, catalogRes] = await Promise.all([
        api.getGoals(),
        api.getLoopRuns(),
        api.getLoopCatalog(),
      ]);
      setGoals(goalRes.goals);
      setRuns(runRes.runs);
      setCatalog(catalogRes.loops);
      if (!selectedRunId && runRes.runs.length > 0) {
        setSelectedRunId(runRes.runs[0].id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load goals and loops');
    } finally {
      setLoading(false);
    }
  }

  async function loadBundle(runId: string) {
    try {
      setBundle(await api.getLoopReviewBundle(runId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load review bundle');
    }
  }

  async function runAction(label: string, action: () => Promise<unknown>) {
    setActionId(label);
    setError(null);
    try {
      await action();
      await refresh();
      if (selectedRun?.id) {
        await loadBundle(selectedRun.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setActionId(null);
    }
  }

  async function createGoal() {
    const objective = goalObjective.trim();
    const acceptance = goalAcceptance.trim();
    if (!objective || !acceptance) {
      setError('Goal objective and acceptance criteria are required');
      return;
    }
    const goal = await api.createGoal({
      objective,
      acceptance_criteria: acceptance.split('\n').map((line) => line.trim()).filter(Boolean),
      risk_class: goalRisk,
      budget: {
        max_maker_workers: 5,
        max_retries: 1,
        max_failure_count: 3,
      },
    });
    setSelectedGoalId(goal.id);
    setGoalObjective('');
    setGoalAcceptance('');
    setGoalRisk('low');
  }

  async function splitFinding(findingId: string) {
    if (!selectedRun) return;
    const reason = window.prompt('Split reason');
    if (!reason) return;
    const first = window.prompt('First child finding');
    if (!first) return;
    const second = window.prompt('Second child finding');
    if (!second) return;
    await api.splitLoopFinding(selectedRun.id, {
      finding_id: findingId,
      reason,
      children: [
        { message: first, suggested_fix: first },
        { message: second, suggested_fix: second },
      ],
    });
  }

  const selectedLoop = catalog.find((loop) => loop.name === selectedLoopName);
  const highRiskRuns = runs.filter((run) => run.metadata?.risk_class === 'high' || run.metadata?.risk_class === 'critical' || run.gates.some((gate) => gate.name === 'security_checker_verdict' && gate.status === 'fail')).length;
  const blockedRuns = runs.filter((run) => ['blocked', 'escalated', 'failed'].includes(run.status)).length;
  const activeWorkers = bundle?.leases.filter((lease) => ['prepared', 'running'].includes(lease.status)).length ?? 0;

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Goals & Loops</h1>
          <p className="text-foreground-secondary mt-2">Closed-loop execution state, gates, workers, and review evidence.</p>
        </div>
        <button
          onClick={() => void refresh()}
          disabled={loading || actionId !== null}
          className="p-2 hover:bg-background-elevated rounded-lg transition-colors disabled:opacity-50"
          title="Refresh"
        >
          <RefreshCw className={`w-5 h-5 text-foreground-secondary ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-status-error/20 bg-status-error/10 p-3 text-sm text-status-error">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Metric icon={<Target className="h-5 w-5" />} label="Goals" value={goals.length} tone="blue" />
        <Metric icon={<Workflow className="h-5 w-5" />} label="Loops" value={catalog.length || runs.length} tone="green" />
        <Metric icon={<AlertTriangle className="h-5 w-5" />} label="Blocked" value={blockedRuns} tone="yellow" />
        <Metric icon={<ShieldCheck className="h-5 w-5" />} label="Security Gates" value={highRiskRuns} tone="red" />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(360px,0.75fr)_minmax(520px,1.25fr)] gap-4">
        <div className="bg-background-secondary border border-border rounded-lg p-4 space-y-3">
          <div className="text-sm font-semibold text-foreground">Create Goal</div>
          <input
            type="text"
            value={goalObjective}
            onChange={(event) => setGoalObjective(event.target.value)}
            className="w-full px-3 py-2 bg-background rounded border border-border text-foreground text-sm"
            placeholder="Objective"
          />
          <textarea
            value={goalAcceptance}
            onChange={(event) => setGoalAcceptance(event.target.value)}
            className="w-full min-h-20 px-3 py-2 bg-background rounded border border-border text-foreground text-sm"
            placeholder="Acceptance criteria, one per line"
          />
          <div className="flex gap-2">
            <select
              value={goalRisk}
              onChange={(event) => setGoalRisk(event.target.value as typeof goalRisk)}
              className="flex-1 px-3 py-2 bg-background rounded border border-border text-foreground text-sm"
            >
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="critical">critical</option>
            </select>
            <button
              onClick={() => void runAction('create-goal', createGoal)}
              disabled={actionId !== null || !goalObjective.trim() || !goalAcceptance.trim()}
              className="inline-flex items-center justify-center gap-2 px-4 py-2 bg-accent text-white rounded-lg hover:bg-accent/90 transition-colors disabled:opacity-50"
            >
              <Plus className="h-4 w-4" />
              Create
            </button>
          </div>
        </div>

        <div className="bg-background-secondary border border-border rounded-lg p-4 space-y-3">
          <div className="text-sm font-semibold text-foreground">Start Loop</div>
          <div className="flex flex-col lg:flex-row gap-3">
            <input
              type="text"
              value={repositoryPath}
              onChange={(event) => setRepositoryPath(event.target.value)}
              className="flex-1 px-3 py-2 bg-background rounded border border-border text-foreground text-sm"
              placeholder="/path/to/repository on workstation"
            />
            <select
              value={selectedGoalId}
              onChange={(event) => setSelectedGoalId(event.target.value)}
              className="lg:w-56 px-3 py-2 bg-background rounded border border-border text-foreground text-sm"
            >
              <option value="">ad-hoc goal</option>
              {goals.map((goal) => (
                <option key={goal.id} value={goal.id}>{goal.objective}</option>
              ))}
            </select>
            <select
              value={selectedLoopName}
              onChange={(event) => setSelectedLoopName(event.target.value)}
              className="lg:w-64 px-3 py-2 bg-background rounded border border-border text-foreground text-sm"
            >
              {(catalog.length ? catalog : [{ name: 'doc-drift-and-small-fix-loop', title: 'Doc Drift And Small Fix' } as LoopCatalogItem]).map((loop) => (
                <option key={loop.name} value={loop.name}>{loop.title || loop.name}</option>
              ))}
            </select>
            <select
              value={runtime}
              onChange={(event) => setRuntime(event.target.value as typeof runtime)}
              className="lg:w-32 px-3 py-2 bg-background rounded border border-border text-foreground text-sm"
            >
              <option value="manual">manual</option>
              <option value="codex">codex</option>
              <option value="opencode">opencode</option>
            </select>
            <button
              onClick={() => void runAction('start-loop', () => api.startLoop({ loop_name: selectedLoopName, repository_path: repositoryPath, goal_id: selectedGoalId || undefined }))}
              disabled={actionId !== null || !repositoryPath.trim()}
              className="inline-flex items-center justify-center gap-2 px-4 py-2 bg-accent text-white rounded-lg hover:bg-accent/90 transition-colors disabled:opacity-50"
            >
              <Play className="h-4 w-4" />
              Start
            </button>
          </div>
          {selectedLoop && (
            <div className="flex flex-wrap gap-2 text-xs text-foreground-tertiary">
              <span>{selectedLoop.risk_class} risk</span>
              <span>{selectedLoop.stop_conditions.length} stop condition(s)</span>
              <span>{selectedLoop.verification.length} verification gate(s)</span>
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(360px,0.9fr)_minmax(520px,1.1fr)] gap-6">
        <div className="space-y-3">
          {loading ? (
            <div className="bg-background-secondary border border-border rounded-lg p-8 text-foreground-secondary">Loading loop runs...</div>
          ) : runs.length === 0 ? (
            <div className="bg-background-secondary border border-border rounded-lg p-8 text-foreground-secondary">No loop runs yet.</div>
          ) : (
            runs.map((run) => (
              <button
                key={run.id}
                onClick={() => setSelectedRunId(run.id)}
                className={`w-full text-left rounded-lg border p-4 transition-colors ${selectedRun?.id === run.id ? 'border-accent/40 bg-accent/5' : 'border-border bg-background-secondary hover:border-accent/20'}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Workflow className="h-4 w-4 text-accent shrink-0" />
                      <span className="font-semibold text-foreground truncate">{run.loop_name}</span>
                    </div>
                    <div className="text-xs text-foreground-tertiary mt-1 truncate">{run.id}</div>
                  </div>
                  <StatusBadge status={run.status} />
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                  <SmallStat label="Findings" value={run.findings.length} />
                  <SmallStat label="Gates" value={run.gates.length} />
                  <SmallStat label="Mode" value={run.mode} />
                </div>
                {run.next_actions.length > 0 && (
                  <div className="mt-3 text-xs text-foreground-secondary truncate">{run.next_actions[0]}</div>
                )}
              </button>
            ))
          )}
        </div>

        <div className="space-y-4">
          {selectedRun ? (
            <>
              <div className="bg-background-secondary border border-border rounded-lg p-5">
                <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
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
                  <div className="flex gap-2">
                    <button
                      onClick={() => void runAction(`step-${selectedRun.id}`, () => api.stepLoopRun(selectedRun.id))}
                      disabled={actionId !== null}
                      className="inline-flex items-center gap-2 px-3 py-2 bg-background border border-border rounded-lg text-sm text-foreground hover:border-accent/30 disabled:opacity-50"
                    >
                      <Workflow className="h-4 w-4" />
                      Step
                    </button>
                    <button
                      onClick={() => void runAction(`continue-${selectedRun.id}`, () => api.continueLoopRun(selectedRun.id, { max_assignments: 1, runtime }))}
                      disabled={actionId !== null || ['running', 'verifying', 'completed', 'escalated'].includes(selectedRun.status)}
                      className="inline-flex items-center gap-2 px-3 py-2 bg-background border border-border rounded-lg text-sm text-foreground hover:border-accent/30 disabled:opacity-50"
                    >
                      <GitBranch className="h-4 w-4" />
                      Continue
                    </button>
                    <button
                      onClick={() => void runAction(`verify-${selectedRun.id}`, () => api.verifyLoopRun(selectedRun.id))}
                      disabled={actionId !== null}
                      className="inline-flex items-center gap-2 px-3 py-2 bg-background border border-border rounded-lg text-sm text-foreground hover:border-accent/30 disabled:opacity-50"
                    >
                      <CheckCircle2 className="h-4 w-4" />
                      Verify
                    </button>
                    <button
                      onClick={() => void runAction(`complete-${selectedRun.id}`, () => api.completeLoopRun(selectedRun.id))}
                      disabled={actionId !== null || selectedRun.status === 'completed'}
                      className="inline-flex items-center gap-2 px-3 py-2 bg-background border border-border rounded-lg text-sm text-foreground hover:border-accent/30 disabled:opacity-50"
                    >
                      <CheckCircle2 className="h-4 w-4" />
                      Complete
                    </button>
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

              <section className="bg-background-secondary border border-border rounded-lg p-5">
                <h3 className="text-lg font-semibold text-foreground mb-3">Gates</h3>
                <div className="space-y-2">
                  {(bundle?.run.gates.length ? bundle.run.gates : selectedRun.gates).map((gate) => (
                    <GateRow key={gate.name} gate={gate} />
                  ))}
                </div>
              </section>

              <section className="bg-background-secondary border border-border rounded-lg p-5">
                <h3 className="text-lg font-semibold text-foreground mb-3">Worker Leases</h3>
                <div className="space-y-2">
                  {bundle?.leases.length ? bundle.leases.map((lease) => (
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
                      busy={actionId !== null}
                    />
                  )) : (
                    <p className="text-sm text-foreground-secondary">No worker leases for this run.</p>
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
                              disabled={actionId !== null}
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
                  {bundle?.events.slice(-8).reverse().map((event) => (
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
          ) : (
            <div className="bg-background-secondary border border-border rounded-lg p-8 text-foreground-secondary">Select a loop run.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function Metric({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: number; tone: 'blue' | 'green' | 'yellow' | 'red' }) {
  const tones = {
    blue: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
    green: 'bg-status-completed/10 text-status-completed border-status-completed/20',
    yellow: 'bg-status-paused/10 text-status-paused border-status-paused/20',
    red: 'bg-status-error/10 text-status-error border-status-error/20',
  };
  return (
    <div className={`border rounded-lg p-4 ${tones[tone]}`}>
      <div className="flex items-center gap-2 mb-2 text-sm">{icon}<span>{label}</span></div>
      <div className="text-2xl font-bold">{value}</div>
    </div>
  );
}

function SmallStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded border border-border bg-background px-2 py-1">
      <div className="text-foreground-tertiary">{label}</div>
      <div className="text-foreground font-medium truncate">{value}</div>
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
  onAccept,
  onNeedsRevision,
  onRetry,
  busy,
}: {
  lease: WorkerLeaseRecord;
  onExecute: () => void;
  onAccept: () => void;
  onNeedsRevision: () => void;
  onRetry: () => void;
  busy: boolean;
}) {
  const canVerdict = (lease.role === 'checker' || lease.role === 'security_checker') && lease.status === 'prepared';
  const canExecute = lease.role === 'maker' && lease.status === 'prepared' && lease.runtime !== 'manual';
  const canRetry = lease.role === 'maker' && lease.status === 'failed';
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
      {(canExecute || canVerdict || canRetry) && (
        <div className="mt-3 flex flex-wrap gap-2">
          {canExecute && (
            <button onClick={onExecute} disabled={busy} className="inline-flex items-center gap-1 px-2 py-1 rounded border border-accent/20 text-xs text-accent hover:bg-accent/10 disabled:opacity-50">
              <Play className="h-3 w-3" />
              Run
            </button>
          )}
          {canVerdict && (
            <>
              <button onClick={onAccept} disabled={busy} className="px-2 py-1 rounded border border-status-completed/20 text-xs text-status-completed hover:bg-status-completed/10 disabled:opacity-50">Accept</button>
              <button onClick={onNeedsRevision} disabled={busy} className="px-2 py-1 rounded border border-status-paused/20 text-xs text-status-paused hover:bg-status-paused/10 disabled:opacity-50">Needs revision</button>
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

function StatusIcon({ status }: { status: string }) {
  if (status === 'pass' || status === 'completed') return <CheckCircle2 className="h-4 w-4 text-status-completed shrink-0" />;
  if (status === 'fail' || status === 'failed' || status === 'blocked' || status === 'escalated') return <XCircle className="h-4 w-4 text-status-error shrink-0" />;
  if (status === 'skipped') return <AlertTriangle className="h-4 w-4 text-foreground-tertiary shrink-0" />;
  return <Timer className="h-4 w-4 text-status-paused shrink-0" />;
}

function StatusBadge({ status }: { status: string }) {
  const tone = status === 'pass' || status === 'completed'
    ? 'bg-status-completed/10 text-status-completed border-status-completed/20'
    : status === 'fail' || status === 'failed' || status === 'blocked' || status === 'escalated'
      ? 'bg-status-error/10 text-status-error border-status-error/20'
      : status === 'skipped'
        ? 'bg-foreground-muted/10 text-foreground-muted border-foreground-muted/20'
        : 'bg-status-paused/10 text-status-paused border-status-paused/20';
  return <span className={`px-2 py-0.5 text-xs rounded border ${tone}`}>{status}</span>;
}
