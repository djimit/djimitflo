import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { LoopRunRecord, LoopReviewBundle, WorkerLeaseRecord, LoopGate, LoopFinding, LoopEventRecord } from '../../lib/api';

vi.mock('../../components/GymRunPanel', () => ({
  GymRunPanel: () => <div data-testid="gym-run-panel">gym panel</div>,
  isGymRun: (run: { loop_name: string }) => ['evolution-gym', 'tg-001', 'pl-001', 'cv-001'].includes(run.loop_name),
}));

const api = vi.hoisted(() => ({
  stepLoopRun: vi.fn(() => Promise.resolve({})),
  continueLoopRun: vi.fn(() => Promise.resolve({})),
  verifyLoopRun: vi.fn(() => Promise.resolve({})),
  stopLoopRun: vi.fn(() => Promise.resolve({})),
  submitCheckerVerdict: vi.fn(() => Promise.resolve({})),
  submitSecurityVerdict: vi.fn(() => Promise.resolve({})),
  retryLoopRun: vi.fn(() => Promise.resolve({})),
  executeWorker: vi.fn(() => Promise.resolve({})),
}));
vi.mock('../../lib/api', () => ({
  api,
  type: {},
}));

import { LoopRunDetail } from './LoopRunDetail';

type DetailProps = React.ComponentProps<typeof LoopRunDetail>;

const gate = (over: Partial<LoopGate> = {}): LoopGate => ({ name: 'gate', status: 'pass', evidence: 'ok', ...over });

const finding = (over: Partial<LoopFinding> = {}): LoopFinding => ({
  id: 'f1', type: 'gap', severity: 'info', file: 'src/a.ts', line: 12, message: 'Missing tests',
  evidence: 'evidence', suggested_fix: 'add tests', ...over,
});

const lease = (over: Partial<WorkerLeaseRecord> = {}): WorkerLeaseRecord => ({
  id: 'l1', loop_run_id: 'r1', role: 'maker', runtime: 'codex', status: 'prepared',
  finding_id: 'f1', worktree_path: null, branch_name: 'branch-1', budget: {}, metadata: {},
  created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z', ...over,
});

const run = (over: Partial<LoopRunRecord> = {}): LoopRunRecord => ({
  id: 'r1', goal_id: 'g1', loop_name: 'doc-drift', mode: 'closed', status: 'running',
  repository_path: 'djimitflo/djimitflo', state_file: null, findings: [finding()], plan: {},
  gates: [gate({ name: 'compile', status: 'pass', evidence: 'tsc clean' })], next_actions: [],
  metadata: {}, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z', completed_at: null, ...over,
});

const event = (over: Partial<LoopEventRecord> = {}): LoopEventRecord => ({
  id: 'e1', loop_run_id: 'r1', event_type: 'step', level: 'info', message: 'stepped', metadata: {},
  created_at: '2026-11-01T00:00:00Z', ...over,
});

function bundle(over: Partial<LoopReviewBundle> = {}): LoopReviewBundle {
  const r = run();
  return { run: r, leases: [lease()], events: [event()], state_content: null, ...over };
}

function renderDetail(over: Partial<DetailProps> = {}) {
  const runAction = vi.fn(async (_label: string, action: () => Promise<unknown>) => { await action(); });
  const completeLoop = vi.fn(async () => {});
  const executeChecker = vi.fn(async (_l: WorkerLeaseRecord) => {});
  const splitFinding = vi.fn(async (_id: string) => {});
  const props: DetailProps = {
    selectedRun: null, selectedRunId: null, selectedBundle: null, runLookupError: null, loading: false,
    runtime: 'opencode', canApprove: true, actionId: null, runLocked: false,
    runAction, completeLoop, executeChecker, splitFinding, ...over,
  };
  return { ...render(<LoopRunDetail {...props} />), props };
}

describe('LoopRunDetail', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('prompts to select a run when nothing is selected', () => {
    renderDetail();
    expect(screen.getByText('Select a loop run.')).toBeTruthy();
  });

  it('shows a loading message for a selected run id that has not loaded yet', () => {
    renderDetail({ selectedRunId: 'r-pending', loading: false });
    expect(screen.getByText('Loading run r-pending…')).toBeTruthy();
  });

  it('shows a lookup error alert scoped to the selected run id', () => {
    renderDetail({ selectedRunId: 'r-missing', runLookupError: { id: 'r-missing', message: 'not found' } });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('r-missing');
    expect(alert.textContent).toContain('not found');
  });

  it('renders the run header, repository path and gates', () => {
    renderDetail({ selectedRun: run({ loop_name: 'doc-drift', repository_path: 'djimitflo/djimitflo' }) });
    expect(screen.getByText('doc-drift')).toBeTruthy();
    expect(screen.getByText('djimitflo/djimitflo')).toBeTruthy();
    expect(screen.getByText('compile')).toBeTruthy();
    expect(screen.getByText('tsc clean')).toBeTruthy();
  });

  it('prefers bundle run gates over the selected run gates when present', () => {
    const b = bundle({ run: run({ gates: [gate({ name: 'run-gate' })] }), leases: [] });
    b.run.gates = [gate({ name: 'bundle-gate', evidence: 'bundle evidence' })];
    renderDetail({ selectedRun: run({ gates: [gate({ name: 'run-gate' })] }), selectedBundle: b });
    expect(screen.getByText('bundle-gate')).toBeTruthy();
    expect(screen.queryByText('run-gate')).toBeNull();
  });

  it('steps the run via runAction and api.stepLoopRun', async () => {
    const { props } = renderDetail({ selectedRun: run() });
    fireEvent.click(screen.getByText('Step'));
    await Promise.resolve();
    expect(props.runAction).toHaveBeenCalled();
    expect(api.stepLoopRun).toHaveBeenCalledWith('r1');
  });

  it('disables Continue while the run is running or verifying', () => {
    renderDetail({ selectedRun: run({ status: 'verifying' }) });
    expect((screen.getByText('Continue').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('disables Stop for completed and cancelled runs', () => {
    renderDetail({ selectedRun: run({ status: 'completed' }) });
    expect((screen.getByText('Stop').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders the Complete button only for approvers, disabled unless ready for human merge', () => {
    const { rerender, props } = renderDetail({ selectedRun: run({ status: 'running' }), canApprove: true });
    expect((screen.getByText('Complete').closest('button') as HTMLButtonElement).disabled).toBe(true);
    rerender(<LoopRunDetail {...props} selectedRun={run({ status: 'ready_for_human_merge' })} />);
    expect((screen.getByText('Complete').closest('button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('hides the Complete button for non-approvers', () => {
    renderDetail({ selectedRun: run({ status: 'ready_for_human_merge' }), canApprove: false });
    expect(screen.queryByText('Complete')).toBeNull();
  });

  it('renders worker leases and routes checker verdicts through submitCheckerVerdict', async () => {
    const b = bundle({ leases: [
      lease({ id: 'chk', role: 'checker', status: 'prepared', runtime: 'manual', metadata: { maker_lease_id: 'mk' } }),
      lease({ id: 'mk', role: 'maker', status: 'completed' }),
    ] });
    renderDetail({ selectedRun: run(), selectedBundle: b });
    expect(screen.getByText('Worker Leases')).toBeTruthy();
    fireEvent.click(screen.getByText('Accept manually'));
    await Promise.resolve();
    expect(api.submitCheckerVerdict).toHaveBeenCalledWith('r1', 'chk', 'accepted', 'Accepted from dashboard');
  });

  it('routes security_checker verdicts through submitSecurityVerdict', async () => {
    const b = bundle({ leases: [
      lease({ id: 'sec', role: 'security_checker', status: 'prepared', runtime: 'manual', metadata: { maker_lease_id: 'mk' } }),
      lease({ id: 'mk', role: 'maker', status: 'completed' }),
    ] });
    renderDetail({ selectedRun: run(), selectedBundle: b });
    fireEvent.click(screen.getByText('Accept manually'));
    await Promise.resolve();
    expect(api.submitSecurityVerdict).toHaveBeenCalledWith('r1', 'sec', 'accepted', 'Accepted from dashboard');
  });

  it('runs a prepared maker lease on a non-manual runtime via executeWorker', async () => {
    const { props } = renderDetail({ selectedRun: run(), selectedBundle: bundle({ leases: [lease({ id: 'mk', role: 'maker', status: 'prepared', runtime: 'codex' })] }) });
    fireEvent.click(screen.getByText('Run Maker'));
    await Promise.resolve();
    expect(api.executeWorker).toHaveBeenCalledWith('r1', 'mk', { timeout_ms: 120_000, diff_max_lines: 200 });
    expect(props.runAction).toHaveBeenCalled();
  });

  it('runs a prepared checker via executeChecker prop', async () => {
    const { props } = renderDetail({ selectedRun: run(), selectedBundle: bundle({ leases: [
      lease({ id: 'chk', role: 'checker', status: 'prepared', runtime: 'opencode', metadata: { maker_lease_id: 'mk' } }),
      lease({ id: 'mk', role: 'maker', status: 'completed' }),
    ] }) });
    fireEvent.click(screen.getByText('Run Checker'));
    await Promise.resolve();
    expect(props.executeChecker).toHaveBeenCalled();
  });

  it('renders findings and splits a finding through splitFinding', async () => {
    const { props } = renderDetail({ selectedRun: run({ findings: [finding({ id: 'fx', message: 'No tests here' })] }) });
    expect(screen.getByText('No tests here')).toBeTruthy();
    const splitBtn = screen.getByTitle('Split finding');
    fireEvent.click(splitBtn);
    await Promise.resolve();
    expect(props.splitFinding).toHaveBeenCalledWith('fx');
  });

  it('shows the split glyph instead of the split button for already-split findings', () => {
    renderDetail({ selectedRun: run({ findings: [finding({ id: 'fx', message: 'split one', metadata: { status: 'split' } })] }) });
    expect(screen.queryByTitle('Split finding')).toBeNull();
    expect(screen.getByText('split one')).toBeTruthy();
  });

  it('renders the last review events and falls back to a placeholder', () => {
    const { rerender, props } = renderDetail({ selectedRun: run(), selectedBundle: bundle({ events: [event({ id: 'e1', event_type: 'step', message: 'stepped once' })] }) });
    expect(screen.getByText('stepped once')).toBeTruthy();
    rerender(<LoopRunDetail {...props} selectedBundle={null} />);
    expect(screen.getByText('No events loaded.')).toBeTruthy();
  });

  it('shows the manual-review notice for worker leases on the manual runtime', () => {
    renderDetail({ selectedRun: run(), selectedBundle: bundle(), runtime: 'manual' });
    expect(screen.getByText(/Manual review does not execute a runtime/)).toBeTruthy();
  });

  it('shows the gym run panel for gym runs and the lease section still renders', () => {
    renderDetail({ selectedRun: run({ loop_name: 'evolution-gym' }), selectedBundle: bundle() });
    expect(screen.getByTestId('gym-run-panel')).toBeTruthy();
  });

  it('disables all action buttons while a run action is in flight', () => {
    renderDetail({ selectedRun: run(), actionId: 'step-r1' });
    for (const label of ['Step', 'Continue', 'Verify', 'Stop']) {
      expect((screen.getByText(label).closest('button') as HTMLButtonElement).disabled).toBe(true);
    }
  });
});
