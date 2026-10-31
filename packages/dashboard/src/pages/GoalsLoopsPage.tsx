import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Play, Plus, RefreshCw, ShieldCheck, Target, Workflow } from 'lucide-react';
import { api, type GoalRecord, type LoopCatalogItem, type LoopReviewBundle, type LoopRunRecord, type WorkerLeaseRecord } from '../lib/api';
import { useAuthStore } from '../lib/auth-store';
import { useDialog } from '../components/ConfirmDialog';
import { LoopRunList } from './goals-loops/LoopRunList';
import { LoopRunDetail } from './goals-loops/LoopRunDetail';

export function GoalsLoopsPage() {
  const dialog = useDialog();
  const canApprove = useAuthStore((state) => state.hasPermission('approve:task'));
  const canIntervene = useAuthStore((state) => state.hasPermission('manage:config'));
  const [goals, setGoals] = useState<GoalRecord[]>([]);
  const [runs, setRuns] = useState<LoopRunRecord[]>([]);
  const [catalog, setCatalog] = useState<LoopCatalogItem[]>([]);
  // UX-10: loop draft-PR bodies link here with ?run=<id>
  const [selectedRunId, setSelectedRunId] = useState<string | null>(() => new URLSearchParams(window.location.search).get('run'));
  const [bundle, setBundle] = useState<LoopReviewBundle | null>(null);
  const [repositoryPath, setRepositoryPath] = useState('');
  const [selectedLoopName, setSelectedLoopName] = useState('doc-drift-and-small-fix-loop');
  const [selectedGoalId, setSelectedGoalId] = useState('');
  const [runtime, setRuntime] = useState<'manual' | 'codex' | 'opencode'>('manual');
  const [goalObjective, setGoalObjective] = useState('');
  const [goalAcceptance, setGoalAcceptance] = useState('');
  const [goalRisk, setGoalRisk] = useState<'low' | 'medium' | 'high' | 'critical'>('low');
  const [loading, setLoading] = useState(true);
  const [actionId, setActionId] = useState<string | null>(null);
  const actionPending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // UX-005: a requested run is shown only if it is that run — never another run's evidence as a fallback
  const selectedRun = useMemo(
    () => (selectedRunId ? runs.find((run) => run.id === selectedRunId) ?? null : runs[0] ?? null),
    [runs, selectedRunId]
  );
  const [runLookupError, setRunLookupError] = useState<{ id: string; message: string } | null>(null);
  const selectedBundle = bundle?.run.id === selectedRun?.id ? bundle : null;
  const selectedRunRef = useRef<string | null>(null);
  selectedRunRef.current = selectedRun?.id || null;
  const bundleRequest = useRef(0);
  const chosenGoal = goals.find(goal => goal.id === selectedGoalId);
  const runLocked = !!selectedRun && (selectedRun.metadata?.operator_paused === true || ['completed', 'cancelled', 'escalated'].includes(selectedRun.status));

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

  // UX-005: the run list holds only the newest runs; a linked older run is fetched by its id
  useEffect(() => {
    if (loading || !selectedRunId || runs.some((run) => run.id === selectedRunId)) return;
    let active = true;
    setRunLookupError(null);
    api.getLoopRun(selectedRunId)
      .then((run) => { if (active) setRuns((current) => current.some((r) => r.id === run.id) ? current : [run, ...current]); })
      .catch((err) => { if (active) setRunLookupError({ id: selectedRunId, message: err instanceof Error ? err.message : String(err) }); });
    return () => { active = false; };
  }, [loading, selectedRunId, runs]);

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
    if (selectedRunRef.current !== runId) return;
    const requestId = ++bundleRequest.current;
    try {
      const response = await api.getLoopReviewBundle(runId);
      if (selectedRunRef.current === runId && requestId === bundleRequest.current) setBundle(response);
    } catch (err) {
      if (selectedRunRef.current === runId && requestId === bundleRequest.current) setError(err instanceof Error ? err.message : 'Failed to load review bundle');
    }
  }

  async function runAction(label: string, action: () => Promise<unknown>) {
    if (actionPending.current) return;
    actionPending.current = true;
    setActionId(label);
    setError(null);
    setNotice(null);
    try {
      await action();
      await refresh();
      if (selectedRun?.id) {
        await loadBundle(selectedRun.id);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Action failed';
      // Approval-required responses can follow a durable task/lease transition.
      // Refresh before offering another action instead of retaining a manual lease.
      setBundle(null);
      await refresh();
      if (selectedRun?.id) await loadBundle(selectedRun.id);
      setError(message);
    } finally {
      actionPending.current = false;
      setActionId(null);
    }
  }

  async function startLoop() {
    const repository = repositoryPath.trim();
    if (!repository) throw new Error('Choose an explicit repository path before starting a loop');
    const created = await api.startLoop({ loop_name: selectedLoopName, repository_path: repository, goal_id: selectedGoalId || undefined });
    setSelectedRunId(created.id);
    setBundle(null);
  }

  async function executeChecker(lease: WorkerLeaseRecord) {
    if (!selectedRun || runLocked) return;
    if (runtime === 'manual') throw new Error('Select Codex or OpenCode for runtime review, or submit a manual verdict');
    await api.executeChecker(selectedRun.id, lease.id, { runtime, timeout_ms: 120_000 });
  }

  async function completeLoop() {
    if (!selectedRun || selectedRun.status !== 'ready_for_human_merge' || !canApprove) return;
    const confirmed = await dialog.confirm(`Complete loop ${selectedRun.id}?`, 'The server records your authenticated identity and rechecks all verification gates. This does not merge, push, or deploy changes.', 'Confirm human approval');
    if (!confirmed) return;
    await api.completeLoopRun(selectedRun.id, true);
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

  // D9: Operator intervention
  async function pauseGoal(goalId: string) {
    await api.request(`/intervention/${goalId}/pause`, { method: 'POST' });
    setNotice('Goal admission paused. No live workers were checkpointed or drained.');
  }
  async function resumeGoal(goalId: string) {
    await api.request(`/intervention/${goalId}/resume`, { method: 'POST' });
    setNotice('Operator pause released. Runtime dispatch still requires an explicit action.');
  }
  async function injectKnowledge(goalId: string) {
    const answer = await dialog.ask({ title: 'Inject knowledge', fields: [{ name: 'evidence', label: 'Knowledge to inject', multiline: true, required: true }], confirmLabel: 'Inject' });
    if (answer === null) return;
    const evidence = answer.evidence;
    if (!evidence.trim()) throw new Error('Knowledge text is required');
    const result = await api.request<{ claim_id: string }>(`/intervention/${goalId}/inject`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ predicate: 'recommends', subject_ref: `goal:${goalId}`, confidence: 0.9, evidence: evidence.trim() }) });
    setNotice(`Knowledge proposal stored: ${result.claim_id}. Operator input is not independently verified evidence.`);
  }
  async function overrideGate(goalId: string) {
    const answer = await dialog.ask({ title: 'Advisory gate decision', message: 'Verification gates are not overridden; this does not execute or stop workers.', fields: [
      { name: 'gate', label: 'Gate name', required: true },
      { name: 'decision', label: 'Advisory decision', options: ['proceed', 'stop'], required: true },
      { name: 'reason', label: 'Reason', multiline: true, required: true },
    ], confirmLabel: 'Record advice' });
    if (answer === null) return;
    const { gate, decision, reason } = answer;
    if (!gate.trim() || !['proceed','stop'].includes(decision.trim()) || !reason.trim()) throw new Error('Gate, proceed/stop decision and reason are required');
    await api.request(`/intervention/${goalId}/override`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gate: gate.trim(), decision: decision.trim(), reason: reason.trim() }) });
    setNotice('Gate advice recorded. Verification evidence, approvals and worker execution are unchanged.');
  }

  async function splitFinding(findingId: string) {
    if (!selectedRun) return;
    const answer = await dialog.ask({ title: 'Split finding', fields: [
      { name: 'reason', label: 'Split reason', required: true },
      { name: 'first', label: 'First child finding', multiline: true, required: true },
      { name: 'second', label: 'Second child finding', multiline: true, required: true },
    ], confirmLabel: 'Split' });
    if (answer === null) return;
    const { reason, first, second } = answer;
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

  return (
    <div className="p-8 space-y-6">
      {dialog.element}
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
        <div role="alert" className="flex items-center gap-2 rounded-lg border border-status-error/20 bg-status-error/10 p-3 text-sm text-status-error">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}
      {notice && <p role="status" className="text-sm text-foreground-secondary">{notice}</p>}

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
          <div className="flex flex-col lg:flex-row lg:flex-wrap gap-3">
            <input
              type="text"
              value={repositoryPath}
              onChange={(event) => setRepositoryPath(event.target.value)}
              className="flex-1 px-3 py-2 bg-background rounded border border-border text-foreground text-sm"
              placeholder="/path/to/repository on workstation"
            />
            <select
              value={selectedGoalId}
              aria-label="Loop goal"
              disabled={actionId !== null}
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
              aria-label="Worker runtime"
              onChange={(event) => setRuntime(event.target.value as typeof runtime)}
              className="lg:w-32 px-3 py-2 bg-background rounded border border-border text-foreground text-sm"
            >
              <option value="manual">manual (no runtime)</option>
              <option value="codex">codex</option>
              <option value="opencode">opencode</option>
            </select>
            <button
              onClick={() => void runAction('start-loop', startLoop)}
              disabled={actionId !== null || !repositoryPath.trim() || chosenGoal?.metadata?.operator_paused === true}
              className="inline-flex items-center justify-center gap-2 px-4 py-2 bg-accent text-white rounded-lg hover:bg-accent/90 transition-colors disabled:opacity-50"
            >
              <Play className="h-4 w-4" />
              Start
            </button>
          </div>
          {selectedGoalId && canIntervene && (
            <div className="flex flex-wrap gap-2">
              <p className="w-full text-xs text-foreground-secondary">Goal admission: {chosenGoal?.metadata?.operator_paused === true ? 'paused by operator' : chosenGoal?.status || 'unknown'}</p>
              <button disabled={actionId !== null} onClick={() => void runAction('pause-goal', () => pauseGoal(selectedGoalId))} className="px-3 py-1.5 text-xs bg-status-paused/10 text-status-paused border border-status-paused/20 rounded-lg hover:bg-status-paused/20 disabled:opacity-50">Pause idle goal</button>
              <button disabled={actionId !== null} onClick={() => void runAction('resume-goal', () => resumeGoal(selectedGoalId))} className="px-3 py-1.5 text-xs bg-status-active/10 text-status-active border border-status-active/20 rounded-lg hover:bg-status-active/20 disabled:opacity-50">Resume</button>
              <button disabled={actionId !== null} onClick={() => void runAction('inject-knowledge', () => injectKnowledge(selectedGoalId))} className="px-3 py-1.5 text-xs bg-accent/10 text-accent-secondary border border-accent/20 rounded-lg hover:bg-accent/20 disabled:opacity-50">Inject Knowledge</button>
              <button disabled={actionId !== null} onClick={() => void runAction('gate-advice', () => overrideGate(selectedGoalId))} className="px-3 py-1.5 text-xs bg-status-error/10 text-status-error border border-status-error/20 rounded-lg hover:bg-status-error/20 disabled:opacity-50">Record gate advice</button>
              <p className="w-full text-xs text-foreground-tertiary">Pause requires quiescent workers. Gate advice does not override verification or execute/stop workers.</p>
            </div>
          )}
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
        <LoopRunList runs={runs} loading={loading} selectedRun={selectedRun} actionId={actionId} setSelectedRunId={setSelectedRunId} />

        <LoopRunDetail
          selectedRun={selectedRun} selectedRunId={selectedRunId} selectedBundle={selectedBundle} runLookupError={runLookupError} loading={loading}
          runtime={runtime} canApprove={canApprove} actionId={actionId} runLocked={runLocked} runAction={runAction}
          completeLoop={completeLoop} executeChecker={executeChecker} splitFinding={splitFinding}
        />
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
