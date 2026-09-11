import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GoalsLoopsPage } from './GoalsLoopsPage';
import { useAuthStore } from '../lib/auth-store';

const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
let run: any;
let leases: any[];
let requests: ReturnType<typeof vi.fn>;
beforeEach(() => {
  useAuthStore.setState({ user: { id: 'fixture-admin', role: 'admin' } as any });
  run = { id: 'fixture-run', loop_name: 'doc-drift-and-small-fix-loop', status: 'verifying', mode: 'closed',
    repository_path: '/tmp/explicit-fixture', created_at: new Date().toISOString(), metadata: {}, gates: [], next_actions: [],
    findings: [{ id: 'finding', message: 'Fixture finding', file: 'README.md' }] };
  leases = [
    { id: 'maker', role: 'maker', status: 'completed', runtime: 'codex', metadata: {} },
    { id: 'ordinary-review', role: 'checker', status: 'prepared', runtime: 'manual', metadata: { maker_lease_id: 'maker' } },
    { id: 'security-review', role: 'security_checker', status: 'prepared', runtime: 'manual', metadata: { maker_lease_id: 'maker' } },
  ];
  requests = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/loops/start' && init?.method === 'POST') return response(run);
    if (init?.method === 'POST') return response({ run });
    if (url === '/api/goals') return response({ goals: [] });
    if (url === '/api/loops/runs') return response({ runs: [run] });
    if (url === '/api/loops/catalog') return response({ loops: [] });
    if (url === '/api/loops/runs/fixture-run/review-bundle') return response({ run, leases, events: [] });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', requests);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); useAuthStore.setState({ user: null }); });
const posts = () => requests.mock.calls.filter(([, init]) => init?.method === 'POST');
const ready = async () => { render(<GoalsLoopsPage />); await screen.findByText('security_checker'); };

async function selectInterventionGoal() {
  const baseline = requests.getMockImplementation()!;
  requests.mockImplementation((url: string, init?: RequestInit) => url === '/api/goals'
    ? Promise.resolve(response({ goals: [{ id: 'fixture-goal', objective: 'Intervention fixture', status: 'running', metadata: {} }] }))
    : baseline(url, init));
  await ready();
  fireEvent.change(screen.getByRole('option', { name: 'Intervention fixture' }).closest('select')!, { target: { value: 'fixture-goal' } });
}

it('shows intervention failures and serializes duplicate pause clicks', async () => {
  await selectInterventionGoal();
  let reject!: (error: Error) => void;
  requests.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  const pause = screen.getByRole('button', { name: /Pause/ });
  fireEvent.click(pause); fireEvent.click(pause);
  expect(posts()).toHaveLength(1);
  expect(pause).toHaveProperty('disabled', true);
  reject(new Error('OPERATOR_GOAL_BUSY'));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'OPERATOR_GOAL_BUSY');
});

it('does not manufacture a proceed decision when the operator cancels the decision prompt', async () => {
  await selectInterventionGoal();
  vi.spyOn(window, 'prompt').mockReturnValueOnce('security_checker_verdict').mockReturnValueOnce(null);
  fireEvent.click(screen.getByRole('button', { name: /^(Override Gate|Record gate advice)$/ }));
  await waitFor(() => expect(window.prompt).toHaveBeenCalledTimes(2));
  expect(posts()).toHaveLength(0);
});

it('does not expose configuration intervention controls to a viewer', async () => {
  useAuthStore.setState({ user: { id: 'viewer', role: 'viewer' } as any });
  await selectInterventionGoal();
  expect(screen.queryByRole('button', { name: /Pause/ })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Inject Knowledge' })).toBeNull();
});

it('shows the returned persisted knowledge claim identity instead of silent success', async () => {
  await selectInterventionGoal();
  vi.spyOn(window,'prompt').mockReturnValue('Fixture evidence');
  requests.mockImplementationOnce(async () => response({ injected:true,claim_id:'durable-claim-id' }));
  fireEvent.click(screen.getByRole('button',{name:'Inject Knowledge'}));
  expect(await screen.findByRole('status')).toHaveProperty('textContent',expect.stringContaining('durable-claim-id'));
});

it('keeps runtime and verification controls disabled on an operator-paused run', async () => {
  run.status='interrupted'; run.metadata.operator_paused=true;
  await ready();
  for (const name of ['Continue','Verify']) expect(screen.getByRole('button',{name,exact:true})).toHaveProperty('disabled',true);
});
it('disables new loop admission for the selected operator-paused goal', async () => {
  const baseline=requests.getMockImplementation()!;
  requests.mockImplementation((url:string,init?:RequestInit)=>url==='/api/goals'
    ? Promise.resolve(response({goals:[{id:'paused-goal',objective:'Paused fixture',status:'blocked',metadata:{operator_paused:true}}]})) : baseline(url,init));
  await ready();
  fireEvent.change(screen.getByLabelText('Loop goal'),{target:{value:'paused-goal'}});
  fireEvent.change(screen.getByPlaceholderText('/path/to/repository on workstation'),{target:{value:'/tmp/fixture'}});
  expect(screen.getByRole('button',{name:'Start',exact:true})).toHaveProperty('disabled',true);
  expect(screen.getByText('Goal admission: paused by operator')).toBeTruthy();
});

it('requires an explicitly entered nonblank repository before starting a loop', async () => {
  await ready();
  const input = screen.getByPlaceholderText('/path/to/repository on workstation');
  const start = screen.getByRole('button', { name: 'Start', exact: true });
  expect(input).toHaveProperty('value', '');
  expect(start).toHaveProperty('disabled', true);
  fireEvent.click(start);
  fireEvent.change(input, { target: { value: '   ' } });
  fireEvent.click(start);
  expect(posts()).toHaveLength(0);
  fireEvent.change(input, { target: { value: ' /tmp/explicit-fixture ' } });
  fireEvent.click(start);
  await waitFor(() => expect(posts()).toHaveLength(1));
  expect(JSON.parse(posts()[0][1].body)).toEqual({ loop_name: run.loop_name, repository_path: '/tmp/explicit-fixture' });
});
it('selects the created run and does not replace its review bundle with the previously selected run', async () => {
  await ready();
  const created={...run,id:'created-run',status:'planning'};
  const baseline=requests.getMockImplementation()!;
  requests.mockImplementation((url:string,init?:RequestInit)=> {
    if(url==='/api/loops/start') return Promise.resolve(response(created));
    if(url==='/api/loops/runs') return Promise.resolve(response({runs:[run,created]}));
    if(url==='/api/loops/runs/created-run/review-bundle') return Promise.resolve(response({run:created,leases:[],events:[]}));
    return baseline(url,init);
  });
  fireEvent.change(screen.getByPlaceholderText('/path/to/repository on workstation'),{target:{value:'/tmp/created-fixture'}});
  fireEvent.click(screen.getByRole('button',{name:'Start',exact:true}));
  expect(await screen.findByText('No worker leases for this run.')).toBeTruthy();
  expect(screen.queryByRole('button',{name:'Run Security Checker',exact:true})).toBeNull();
});

it('keeps manual review explicit and never dispatches a mock from the default selection', async () => {
  await ready();
  for (const label of ['Run Checker', 'Run Security Checker']) {
    const button = screen.getByRole('button', { name: label, exact: true });
    expect(button).toHaveProperty('disabled', true);
    fireEvent.click(button);
  }
  expect(posts()).toHaveLength(0);
  const manualAccept = screen.getAllByRole('button', { name: 'Accept manually' });
  fireEvent.click(manualAccept[1]);
  await waitFor(() => expect(posts()).toHaveLength(1));
  expect(posts()[0][0]).toBe('/api/loops/runs/fixture-run/security-verdict');
  expect(JSON.parse(posts()[0][1].body)).toMatchObject({ lease_id: 'security-review', verdict: 'accepted' });
});

it.each([['codex', 'Run Checker', 'ordinary-review'], ['opencode', 'Run Security Checker', 'security-review']])(
  'dispatches explicit %s using the correct %s lease', async (runtime, label, leaseId) => {
    await ready();
    fireEvent.change(screen.getByLabelText('Worker runtime'), { target: { value: runtime } });
    fireEvent.click(screen.getByRole('button', { name: label, exact: true }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0][0]).toBe('/api/loops/runs/fixture-run/execute-checker');
    expect(JSON.parse(posts()[0][1].body)).toEqual({ lease_id: leaseId, runtime, timeout_ms: 120_000 });
  },
);

it('holds review controls busy until the pending request settles and displays dispatch failures', async () => {
  await ready();
  let reject!: (error: Error) => void;
  requests.mockImplementationOnce(() => new Promise((_, rejectPromise) => { reject = rejectPromise; }));
  fireEvent.change(screen.getByLabelText('Worker runtime'), { target: { value: 'codex' } });
  const execute = screen.getByRole('button', { name: 'Run Security Checker', exact: true });
  fireEvent.click(execute);
  fireEvent.click(execute);
  expect(execute).toHaveProperty('disabled', true);
  expect(screen.getByRole('button', { name: 'Run Checker', exact: true })).toHaveProperty('disabled', true);
  expect(posts()).toHaveLength(1);
  reject(new Error('Approval is required before execution'));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Approval is required before execution');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Run Security Checker', exact: true })).toHaveProperty('disabled', false));
});

it('disables cancelled-run mutations even if old prepared leases remain', async () => {
  run.status = 'cancelled';
  await ready();
  fireEvent.change(screen.getByLabelText('Worker runtime'), { target: { value: 'codex' } });
  for (const label of ['Step', 'Continue', 'Verify', 'Complete', 'Stop', 'Run Checker', 'Run Security Checker']) {
    const button = screen.getByRole('button', { name: label, exact: true });
    expect(button).toHaveProperty('disabled', true);
    fireEvent.click(button);
  }
  for (const button of screen.getAllByRole('button', { name: 'Accept manually' })) expect(button).toHaveProperty('disabled', true);
  expect(screen.getByTitle('Split finding')).toHaveProperty('disabled', true);
  expect(posts()).toHaveLength(0);
});

it('does not offer a manual verdict on a runtime-owned approval continuation', async () => {
  leases[2].runtime = 'codex';
  leases[2].metadata.execution_task_id = 'existing-task';
  await ready();
  expect(screen.getAllByRole('button', { name: 'Accept manually' })).toHaveLength(1);
  fireEvent.change(screen.getByLabelText('Worker runtime'), { target: { value: 'opencode' } });
  expect(screen.getByRole('button', { name: 'Run Security Checker', exact: true })).toHaveProperty('disabled', true);
  fireEvent.change(screen.getByLabelText('Worker runtime'), { target: { value: 'codex' } });
  expect(screen.getByRole('button', { name: 'Run Security Checker', exact: true })).toHaveProperty('disabled', false);
});

it('blocks both runtime and manual verdicts until the linked maker is completed', async () => {
  leases[0].status = 'running';
  await ready();
  fireEvent.change(screen.getByLabelText('Worker runtime'), { target: { value: 'codex' } });
  for (const name of ['Run Checker', 'Run Security Checker']) expect(screen.getByRole('button', { name, exact: true })).toHaveProperty('disabled', true);
  for (const button of screen.getAllByRole('button', { name: 'Accept manually' })) expect(button).toHaveProperty('disabled', true);
  expect(posts()).toHaveLength(0);
});

it('never pairs the previous review bundle leases with a newly selected run', async () => {
  const second = { ...run, id: 'second-run' };
  const baseline = requests.getMockImplementation()!;
  let resolveBundle!: (response: unknown) => void;
  requests.mockImplementation((url: string, init?: RequestInit) => {
    if (url === '/api/loops/runs' && !init?.method) return Promise.resolve(response({ runs: [run, second] }));
    if (url === '/api/loops/runs/second-run/review-bundle') return new Promise(resolve => { resolveBundle = resolve; });
    return baseline(url, init);
  });
  await ready();
  fireEvent.change(screen.getByLabelText('Worker runtime'), { target: { value: 'codex' } });
  fireEvent.click(screen.getByText('second-run').closest('button')!);
  expect(screen.queryByRole('button', { name: 'Run Security Checker', exact: true })).toBeNull();
  expect(screen.getByText('Review bundle unavailable or loading.')).toBeTruthy();
  expect(posts()).toHaveLength(0);
  resolveBundle(response({ run: second, leases: leases.map(lease => lease.role === 'security_checker' ? { ...lease, id: 'second-security-review' } : lease), events: [] }));
  fireEvent.click(await screen.findByRole('button', { name: 'Run Security Checker', exact: true }));
  await waitFor(() => expect(posts()).toHaveLength(1));
  expect(posts()[0][0]).toBe('/api/loops/runs/second-run/execute-checker');
  expect(JSON.parse(posts()[0][1].body)).toMatchObject({ lease_id: 'second-security-review', runtime: 'codex' });
});

it('reloads persisted lease ownership after an approval-required response', async () => {
  await ready();
  const baseline = requests.getMockImplementation()!;
  requests.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      leases[2] = { ...leases[2], runtime: 'codex', metadata: { maker_lease_id: 'maker', execution_task_id: 'approved-later' } };
      return Promise.resolve({ ok: false, status: 409, json: async () => ({ error: { message: 'Approval required' } }) });
    }
    return baseline(url, init);
  });
  fireEvent.change(screen.getByLabelText('Worker runtime'), { target: { value: 'codex' } });
  fireEvent.click(screen.getByRole('button', { name: 'Run Security Checker', exact: true }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Approval required');
  expect(screen.getAllByRole('button', { name: 'Accept manually' })).toHaveLength(1);
  expect(posts()).toHaveLength(1);
});

it('does not complete a loop when the human cancels confirmation', async () => {
  run.status = 'ready_for_human_merge';
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  await ready();
  fireEvent.click(screen.getByRole('button', { name: 'Complete', exact: true }));
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining('does not merge, push, or deploy'));
  expect(posts()).toHaveLength(0);
});

it('sends explicit human confirmation without inventing an approver identity', async () => {
  run.status = 'ready_for_human_merge';
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  await ready();
  fireEvent.click(screen.getByRole('button', { name: 'Complete', exact: true }));
  await waitFor(() => expect(posts()).toHaveLength(1));
  expect(posts()[0][0]).toBe('/api/loops/runs/fixture-run/complete');
  expect(JSON.parse(posts()[0][1].body)).toEqual({ human_approval_ref: 'dashboard:explicit-confirmation' });
});

it('does not expose human completion approval to a viewer', async () => {
  run.status = 'ready_for_human_merge';
  useAuthStore.setState({ user: { id: 'viewer', role: 'viewer' } as any });
  await ready();
  expect(screen.queryByRole('button', { name: 'Complete', exact: true })).toBeNull();
  expect(posts()).toHaveLength(0);
});
